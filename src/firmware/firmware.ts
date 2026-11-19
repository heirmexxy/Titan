/**
 * Firmware updates over the air (Device Protocol v1 §15).
 *
 * A release is a binary for one device type, fingerprinted (SHA-256) and signed by Titan's firmware key (Ed25519
 * over the 32 digest bytes). A rollout targets devices and sends them `ota.update` in batches, only while they are
 * online. Each device downloads the binary over HTTPS with its own token, checks size, SHA-256 and signature
 * before flashing, and reboots; Titan marks it installed when the device reports the new `fw` version.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActuatorService } from '../actuators/service.js';
import type { Body, MessageKind } from '../core/envelope.js';
import type { PipelineHook } from '../ingest/pipeline.js';
import type { Device } from '../store/types.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export class FirmwareError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
export const MAX_FIRMWARE_BYTES = 8 * 1024 * 1024;
const SENT_TIMEOUT_MS = 30 * 60_000;   // no ack or new version within 30 minutes → retry
const MAX_ATTEMPTS = 3;

export class FirmwareService implements PipelineHook {
  private key: KeyObject;
  readonly publicKey: string;            // base64url raw 32 bytes, for baking into firmware
  private lastFw = new Map<string, string>();

  constructor(private pool: Pool, private actuators: ActuatorService | null, private dir: string, private publicUrl: string) {
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, 'signing-key.pem');
    if (!existsSync(keyFile)) {
      const { privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }));
      chmodSync(keyFile, 0o600);
    }
    this.key = createPrivateKey(readFileSync(keyFile));
    this.publicKey = createPublicKey(this.key).export({ format: 'jwk' }).x as string;
  }

  private q(t: string, v: unknown[] = []) { return this.pool.query(t, v); }

  async createRelease(o: { orgId: string | null; typeId: string; version: string; notes?: string | null; binary: Buffer; by: string }) {
    if (!VERSION.test(o.version)) throw new FirmwareError(400, 'invalid_version', 'Version may use letters, digits and . _ + - (max 32)');
    if (!o.binary.length) throw new FirmwareError(400, 'empty_file', 'The firmware file is empty');
    if (o.binary.length > MAX_FIRMWARE_BYTES) throw new FirmwareError(413, 'too_large', 'Firmware must be 8 MB or smaller');
    const type = (await this.q(`SELECT id FROM device_types WHERE id = $1`, [o.typeId])).rows[0];
    if (!type) throw new FirmwareError(400, 'unknown_type', `Unknown device type ${o.typeId}`);
    const digest = createHash('sha256').update(o.binary).digest();
    const sha256 = digest.toString('hex');
    const signature = sign(null, digest, this.key).toString('base64url');
    const file = join(this.dir, `${o.typeId}-${o.version}-${sha256.slice(0, 12)}.bin`);
    const dup = await this.q(`SELECT 1 FROM firmware_releases WHERE type_id = $1 AND version = $2 AND org_id IS NOT DISTINCT FROM $3`, [o.typeId, o.version, o.orgId]);
    if (dup.rows.length) throw new FirmwareError(409, 'version_exists', `Version ${o.version} already exists for ${o.typeId}`);
    writeFileSync(file, o.binary);
    const row = (await this.q(
      `INSERT INTO firmware_releases (org_id, type_id, version, file_path, size, sha256, signature, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, org_id, type_id, version, size, sha256, signature, notes, created_at`,
      [o.orgId, o.typeId, o.version, file, o.binary.length, sha256, signature, o.notes ?? null, o.by])).rows[0];
    return row;
  }

  /** Releases an organisation may use: its own plus Kitovu's. orgId null = all. */
  async listReleases(orgId: string | null) {
    return (await this.q(
      `SELECT r.id, r.org_id, r.type_id, r.version, r.size, r.sha256, r.notes, r.created_at, r.retired_at, o.name AS org_name,
              (SELECT count(*) FROM device_firmware f JOIN devices d ON d.id = f.device_id
                WHERE f.current_version = r.version AND d.type_id = r.type_id AND ($1::uuid IS NULL OR d.org_id = $1))::int AS devices_on_version
       FROM firmware_releases r LEFT JOIN organisations o ON o.id = r.org_id
       WHERE $1::uuid IS NULL OR r.org_id IS NULL OR r.org_id = $1
       ORDER BY r.created_at DESC LIMIT 200`, [orgId])).rows;
  }

  async getRelease(id: string) {
    return (await this.q(`SELECT * FROM firmware_releases WHERE id = $1`, [id])).rows[0] ?? null;
  }

  async retire(id: string, orgId: string | null) {
    const r = await this.q(`UPDATE firmware_releases SET retired_at = now() WHERE id = $1 AND ($2::uuid IS NULL OR org_id = $2) AND retired_at IS NULL`, [id, orgId]);
    if (!r.rowCount) throw new FirmwareError(404, 'not_found', 'Release not found');
  }

  /**
   * Starts a rollout. `scopeOrgId` is the caller's organisation (null for Kitovu, who may also pass `targetOrgId`).
   * Devices already on the version, disabled devices and devices of other types are skipped.
   */
  async startRollout(o: { releaseId: string; scopeOrgId: string | null; targetOrgId?: string | null; siteId?: string | null; deviceIds?: string[] | null; batchSize?: number; by: string }) {
    const rel = await this.getRelease(o.releaseId);
    if (!rel || rel.retired_at) throw new FirmwareError(404, 'not_found', 'Release not found');
    if (o.scopeOrgId && rel.org_id && rel.org_id !== o.scopeOrgId) throw new FirmwareError(404, 'not_found', 'Release not found');
    const orgId = o.scopeOrgId ?? o.targetOrgId ?? rel.org_id ?? null;
    const ids = o.deviceIds?.length ? o.deviceIds.slice(0, 5000) : null;
    const targets = (await this.q(
      `SELECT d.id FROM devices d LEFT JOIN device_firmware f ON f.device_id = d.id
       WHERE d.type_id = $1 AND d.status <> 'disabled'
         AND ($2::uuid IS NULL OR d.org_id = $2) AND ($3::uuid IS NULL OR d.site_id = $3) AND ($4::text[] IS NULL OR d.id = ANY($4))
         AND f.current_version IS DISTINCT FROM $5
         AND (f.state IS NULL OR f.state NOT IN ('queued','sent','downloading'))`,
      [rel.type_id, orgId, o.siteId ?? null, ids, rel.version])).rows.map((x) => x.id as string);
    if (!targets.length) throw new FirmwareError(400, 'no_devices', 'No matching devices need this version');
    const rollout = (await this.q(
      `INSERT INTO firmware_rollouts (release_id, org_id, site_id, device_ids, batch_size, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [rel.id, orgId, o.siteId ?? null, ids, Math.min(Math.max(Math.round(o.batchSize ?? 10), 1), 1000), o.by])).rows[0];
    for (const id of targets) {
      await this.q(
        `INSERT INTO device_firmware (device_id, rollout_id, release_id, state, attempts, detail, updated_at) VALUES ($1,$2,$3,'queued',0,null,now())
         ON CONFLICT (device_id) DO UPDATE SET rollout_id = $2, release_id = $3, state = 'queued', attempts = 0, detail = null, command_id = null, updated_at = now()`,
        [id, rollout.id, rel.id]);
    }
    await this.tick();
    return { rollout, devices: targets.length };
  }

  async setRolloutStatus(id: string, scopeOrgId: string | null, status: 'active' | 'paused' | 'cancelled') {
    const r = await this.q(
      `UPDATE firmware_rollouts SET status = $3 WHERE id = $1 AND ($2::uuid IS NULL OR org_id = $2) AND status IN ('active','paused') RETURNING id`,
      [id, scopeOrgId, status]);
    if (!r.rowCount) throw new FirmwareError(404, 'not_found', 'Rollout not found or already finished');
    if (status === 'cancelled') await this.q(`UPDATE device_firmware SET state = 'idle', detail = 'rollout cancelled', updated_at = now() WHERE rollout_id = $1 AND state = 'queued'`, [id]);
    if (status === 'active') await this.tick();
  }

  async listRollouts(scopeOrgId: string | null) {
    return (await this.q(
      `SELECT ro.*, r.version, r.type_id, o.name AS org_name,
              count(f.*) FILTER (WHERE f.state = 'queued')::int AS queued,
              count(f.*) FILTER (WHERE f.state IN ('sent','downloading'))::int AS in_progress,
              count(f.*) FILTER (WHERE f.state = 'installed')::int AS installed,
              count(f.*) FILTER (WHERE f.state = 'failed')::int AS failed
       FROM firmware_rollouts ro JOIN firmware_releases r ON r.id = ro.release_id
       LEFT JOIN organisations o ON o.id = ro.org_id
       LEFT JOIN device_firmware f ON f.rollout_id = ro.id
       WHERE $1::uuid IS NULL OR ro.org_id = $1
       GROUP BY ro.id, r.version, r.type_id, o.name ORDER BY ro.created_at DESC LIMIT 100`, [scopeOrgId])).rows;
  }

  async rolloutDevices(id: string, scopeOrgId: string | null) {
    const ro = (await this.q(`SELECT * FROM firmware_rollouts WHERE id = $1 AND ($2::uuid IS NULL OR org_id = $2)`, [id, scopeOrgId])).rows[0];
    if (!ro) throw new FirmwareError(404, 'not_found', 'Rollout not found');
    const devices = (await this.q(
      `SELECT f.device_id, f.state, f.current_version, f.detail, f.attempts, f.updated_at, d.status AS device_status, d.name
       FROM device_firmware f JOIN devices d ON d.id = f.device_id WHERE f.rollout_id = $1 ORDER BY f.device_id`, [id])).rows;
    return { rollout: ro, devices };
  }

  /** Called by the worker every 30 s: sends the next batch, retries stalled devices, closes finished rollouts. */
  async tick(now = new Date()) {
    if (!this.actuators) return;
    // Stalled: sent but never acknowledged or installed.
    await this.q(
      `UPDATE device_firmware SET state = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
              detail = CASE WHEN attempts >= $2 THEN 'no response after ' || attempts || ' attempts' ELSE 'retrying: no response' END, updated_at = $1
       WHERE state IN ('sent','downloading') AND updated_at < $1::timestamptz - make_interval(secs => $3)`,
      [now, MAX_ATTEMPTS, SENT_TIMEOUT_MS / 1000]);
    const rollouts = (await this.q(
      `SELECT ro.id, ro.batch_size, r.id AS release_id, r.version, r.size, r.sha256, r.signature
       FROM firmware_rollouts ro JOIN firmware_releases r ON r.id = ro.release_id WHERE ro.status = 'active'`)).rows;
    for (const ro of rollouts) {
      const counts = (await this.q(
        `SELECT count(*) FILTER (WHERE state IN ('sent','downloading'))::int AS busy, count(*) FILTER (WHERE state = 'queued')::int AS queued
         FROM device_firmware WHERE rollout_id = $1`, [ro.id])).rows[0];
      if (!counts.busy && !counts.queued) {
        await this.q(`UPDATE firmware_rollouts SET status = 'done' WHERE id = $1`, [ro.id]);
        continue;
      }
      const room = Number(ro.batch_size) - Number(counts.busy);
      if (room <= 0) continue;
      const next = (await this.q(
        `SELECT f.device_id FROM device_firmware f JOIN devices d ON d.id = f.device_id
         WHERE f.rollout_id = $1 AND f.state = 'queued' AND d.status = 'online' ORDER BY f.attempts, f.device_id LIMIT $2`, [ro.id, room])).rows;
      for (const n of next) {
        try {
          const cmd = await this.actuators.send(n.device_id, 'ota.update', {
            version: ro.version, url: `${this.publicUrl}/api/device/firmware/${ro.release_id}`, size: Number(ro.size), sha256: ro.sha256, sig: ro.signature,
          }, { source: 'system', actor: `rollout:${ro.id}` });
          await this.q(`UPDATE device_firmware SET state = 'sent', command_id = $2, attempts = attempts + 1, detail = null, updated_at = now() WHERE device_id = $1`, [n.device_id, cmd.id]);
        } catch (e) {
          await this.q(`UPDATE device_firmware SET state = 'failed', detail = $2, updated_at = now() WHERE device_id = $1`, [n.device_id, String((e as Error).message ?? e).slice(0, 200)]);
        }
      }
    }
  }

  /** Download for a device: only a release of its own type, published by Kitovu or its own organisation. */
  async binaryFor(device: Device, releaseId: string): Promise<{ data: Buffer; sha256: string; version: string } | null> {
    const rel = await this.getRelease(releaseId);
    if (!rel || rel.type_id !== device.typeId || (rel.org_id && rel.org_id !== device.orgId)) return null;
    await this.q(`UPDATE device_firmware SET state = 'downloading', updated_at = now() WHERE device_id = $1 AND release_id = $2 AND state = 'sent'`, [device.id, rel.id]);
    return { data: readFileSync(rel.file_path), sha256: rel.sha256, version: rel.version };
  }

  // ---------- Pipeline hooks ----------
  async onAck(device: Device, ack: { id?: string; ok: boolean; msg?: string }) {
    if (!ack.id) return;
    await this.q(
      `UPDATE device_firmware SET state = CASE WHEN $3 THEN 'downloading' ELSE 'failed' END, detail = $4, updated_at = now()
       WHERE device_id = $1 AND command_id = $2 AND state IN ('sent','downloading')`,
      [device.id, ack.id, ack.ok, ack.ok ? null : (ack.msg ?? 'device rejected the update').slice(0, 200)]);
  }

  async onEvent(device: Device, ev: { code: string; msg?: string }) {
    if (ev.code !== 'ota_failed') return;
    await this.q(`UPDATE device_firmware SET state = 'failed', detail = $2, updated_at = now() WHERE device_id = $1 AND state IN ('sent','downloading')`,
      [device.id, (ev.msg ?? 'update failed on the device').slice(0, 200)]);
  }

  async onMessage(device: Device, _kind: MessageKind, body: Body) {
    const fw = typeof body.fw === 'string' ? body.fw.slice(0, 32) : null;
    if (!fw || this.lastFw.get(device.id) === fw) return;
    this.lastFw.set(device.id, fw);
    await this.q(
      `INSERT INTO device_firmware (device_id, current_version, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (device_id) DO UPDATE SET current_version = $2,
         state = CASE WHEN device_firmware.state IN ('sent','downloading','queued','failed')
                       AND (SELECT version FROM firmware_releases WHERE id = device_firmware.release_id) = $2 THEN 'installed' ELSE device_firmware.state END,
         detail = CASE WHEN (SELECT version FROM firmware_releases WHERE id = device_firmware.release_id) = $2 THEN null ELSE device_firmware.detail END,
         updated_at = now()`,
      [device.id, fw]);
  }
}

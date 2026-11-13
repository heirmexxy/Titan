import {
  EnvelopeError,
  parseBody,
  parseEnvelope,
  readingTime,
  verifyEnvelope,
  type Body,
  type MessageKind,
} from '../core/envelope.js';
import { dewPoint, emcWetBasis, round, vpd } from '../core/derived.js';
import { evaluateRule, ruleMatches, ruleTitle } from '../core/rules.js';
import {
  FLAG_BUFFERED,
  FLAG_DERIVED,
  FLAG_SHARED_SECRET,
  FLAG_TIME_ESTIMATED,
  type Alert,
  type Device,
  type ReadingRow,
  type Store,
} from '../store/types.js';

export interface Notifier {
  /** event: alert.opened | alert.resolved | device.offline | device.online | reading.created | event.created */
  emit(event: string, ctx: { orgId: string; siteId: string | null }, data: unknown): Promise<void>;
}

export type IngestResult =
  | { status: 'accepted'; seq: number; readings: number; rejected: string[]; alertsOpened: number }
  | { status: 'duplicate'; seq: number }
  | { status: 'rejected'; code: string; message: string };

const VPD_SITE_KINDS = new Set(['greenhouse', 'hydroponics', 'aquaponics']);
const SEVERITY = new Set(['info', 'warning', 'critical']);

export class IngestPipeline {
  constructor(private store: Store, private notifier: Notifier) {}

  async handle(deviceId: string, kind: MessageKind, raw: string | Buffer, receivedAt = new Date()): Promise<IngestResult> {
    const device = await this.store.getDevice(deviceId);
    if (!device || device.status === 'disabled') {
      return { status: 'rejected', code: 'unknown_device', message: `Device ${deviceId} is not registered or is disabled` };
    }

    let body: Body;
    let keyAlg: string;
    let env;
    try {
      env = parseEnvelope(raw);
      const key = await this.store.getDeviceKey(deviceId, env.k);
      keyAlg = key?.alg ?? '';
      const bytes = verifyEnvelope(env, key);
      body = parseBody(bytes, kind, deviceId);
    } catch (e) {
      if (e instanceof EnvelopeError) {
        if (e.code === 'bad_signature' || e.code === 'unknown_key' || e.code === 'device_mismatch') {
          await this.tamper(device, e.code, receivedAt);
        }
        return { status: 'rejected', code: e.code, message: e.message };
      }
      throw e;
    }

    const stored = await this.store.insertMessage({
      deviceId,
      seq: body.seq,
      kind,
      keyId: env.k,
      payloadB64: env.p,
      sigB64: env.s,
      receivedAt,
    });
    if (!stored) return { status: 'duplicate', seq: body.seq };

    const ctx = { orgId: device.orgId, siteId: device.siteId };
    const seen = await this.store.markDeviceSeen(deviceId, receivedAt, body.seq, kind === 'state' ? body.st : undefined);
    if (seen === 'came_online') await this.deviceOnline(device, receivedAt);

    const { time, estimated } = readingTime(body, receivedAt);
    let flags = 0;
    if (body.buf) flags |= FLAG_BUFFERED;
    if (estimated) flags |= FLAG_TIME_ESTIMATED;
    if (keyAlg === 'hmac-sha256') flags |= FLAG_SHARED_SECRET;

    const metrics = await this.store.getMetrics();
    const rows: ReadingRow[] = [];
    const rejected: string[] = [];
    for (const r of body.r ?? []) {
      const m = metrics.get(r.m);
      if (!m || m.derived) {
        rejected.push(r.m);
        continue;
      }
      const outOfRange = (m.minValid !== null && r.v < m.minValid) || (m.maxValid !== null && r.v > m.maxValid);
      rows.push({
        time,
        orgId: device.orgId,
        siteId: device.siteId,
        deviceId,
        channel: r.ch,
        metric: r.m,
        value: r.v,
        quality: outOfRange ? 'rejected' : (r.q ?? 'ok'),
        flags,
        seq: body.seq,
        cal: r.cal ?? null,
      });
    }

    rows.push(...(await this.derive(device, rows, time, flags)));
    if (rows.length) await this.store.insertReadings(rows);

    let alertsOpened = 0;
    if (kind === 'event' && body.ev) alertsOpened += await this.handleEvent(device, body, time);
    if (kind === 'ack' && body.ack?.cfg !== undefined && body.ack.ok) await this.store.ackConfig(deviceId, body.ack.cfg, receivedAt);

    // Threshold rules run on live readings only; buffered history is stored but does not page anyone.
    if (!body.buf) alertsOpened += await this.evaluateRules(device, rows.filter((r) => r.quality !== 'rejected'), metrics);

    const day = receivedAt.toISOString().slice(0, 10);
    await this.store.addUsage(device.orgId, day, { messages: 1, readings: rows.length });
    await this.store.markActiveDevice(device.orgId, day, deviceId);

    if (rows.length) {
      await this.notifier.emit('reading.created', ctx, {
        deviceId,
        siteId: device.siteId,
        seq: body.seq,
        buffered: body.buf,
        readings: rows.map((r) => ({ time: r.time.toISOString(), metric: r.metric, channel: r.channel, value: r.value, quality: r.quality })),
      });
    }

    return { status: 'accepted', seq: body.seq, readings: rows.length, rejected, alertsOpened };
  }

  private async derive(device: Device, rows: ReadingRow[], time: Date, baseFlags: number): Promise<ReadingRow[]> {
    const byZone = new Map<string, { t?: number; rh?: number }>();
    for (const r of rows) {
      if (r.quality === 'rejected') continue;
      if (r.metric !== 'air.temperature' && r.metric !== 'air.humidity') continue;
      const zone = r.channel.split('/')[0];
      const z = byZone.get(zone) ?? {};
      if (r.metric === 'air.temperature') z.t = r.value;
      else z.rh = r.value;
      byZone.set(zone, z);
    }
    if (!byZone.size) return [];

    const out: ReadingRow[] = [];
    const flags = baseFlags | FLAG_DERIVED;
    const mk = (channel: string, metric: string, value: number): ReadingRow => ({
      time, orgId: device.orgId, siteId: device.siteId, deviceId: device.id, channel, metric, value: round(value), quality: 'ok', flags, seq: null, cal: null,
    });
    const zoneCrops = device.siteId ? await this.store.getZoneCrops(device.siteId) : new Map();

    for (const [zone, { t, rh }] of byZone) {
      if (t === undefined || rh === undefined) continue;
      out.push(mk(`${zone}/derived`, 'air.dew_point', dewPoint(t, rh)));
      if (device.siteKind && VPD_SITE_KINDS.has(device.siteKind)) out.push(mk(`${zone}/derived`, 'air.vpd', vpd(t, rh)));
      for (const { stack, crop } of zoneCrops.get(zone) ?? []) {
        if (crop.hendersonK === null || crop.hendersonN === null || crop.hendersonC === null) continue;
        const emc = emcWetBasis(t, rh, { k: crop.hendersonK, n: crop.hendersonN, c: crop.hendersonC });
        if (emc !== null) out.push(mk(`${zone}/${stack}`, 'produce.emc', emc));
      }
    }
    return out;
  }

  private async handleEvent(device: Device, body: Body, time: Date): Promise<number> {
    const ev = body.ev!;
    const severity = SEVERITY.has(ev.sev ?? '') ? (ev.sev as Alert['severity']) : 'info';
    const ctx = { orgId: device.orgId, siteId: device.siteId };
    await this.store.insertEvent({
      time, orgId: device.orgId, siteId: device.siteId, deviceId: device.id, code: ev.code, severity, channel: ev.ch ?? null, message: ev.msg ?? null, seq: body.seq,
    });
    await this.notifier.emit('event.created', ctx, { deviceId: device.id, code: ev.code, severity, channel: ev.ch ?? null, message: ev.msg ?? null, time: time.toISOString() });

    if (ev.code === 'power_restored') {
      const open = await this.store.findOpenAlert(device.orgId, device.id, 'power_lost', ev.ch ?? null);
      if (open) await this.resolve(open, time);
      return 0;
    }
    if (severity === 'info' || body.buf) return 0;
    const existing = await this.store.findOpenAlert(device.orgId, device.id, ev.code, ev.ch ?? null);
    if (existing) return 0;
    const alert = await this.store.openAlert({
      orgId: device.orgId, siteId: device.siteId, deviceId: device.id, channel: ev.ch ?? null, ruleId: null, code: ev.code, severity,
      title: ev.msg || ev.code.replace(/_/g, ' '), value: null, openedAt: time,
    });
    await this.notifier.emit('alert.opened', ctx, alert);
    return 1;
  }

  private async evaluateRules(device: Device, rows: ReadingRow[], metrics: Map<string, { unit: string }>): Promise<number> {
    if (!rows.length) return 0;
    const rules = await this.store.listRulesFor(device.orgId);
    if (!rules.length) return 0;
    let opened = 0;
    const d = { orgId: device.orgId, siteId: device.siteId, deviceId: device.id };
    for (const row of rows) {
      for (const rule of rules) {
        if (!ruleMatches(rule, d, row.metric, row.channel)) continue;
        const prev = await this.store.getRuleState(rule.id, device.id, row.channel);
        const { state, action } = evaluateRule(rule, prev, row.value, row.time);
        if (action === 'open') {
          const alert = await this.store.openAlert({
            orgId: device.orgId, siteId: device.siteId, deviceId: device.id, channel: row.channel, ruleId: rule.id, code: 'threshold',
            severity: rule.severity, title: ruleTitle(rule, row.value, metrics.get(row.metric)?.unit ?? ''), value: row.value, openedAt: row.time,
          });
          state.alertId = alert.id;
          opened++;
          await this.notifier.emit('alert.opened', { orgId: device.orgId, siteId: device.siteId }, alert);
        } else if (action === 'resolve' && prev.alertId) {
          const resolved = await this.store.resolveAlert(prev.alertId, row.time);
          if (resolved) await this.notifier.emit('alert.resolved', { orgId: device.orgId, siteId: device.siteId }, resolved);
        }
        if (state.breachSince !== prev.breachSince || state.alertId !== prev.alertId) {
          await this.store.setRuleState(rule.id, device.id, row.channel, state);
        }
      }
    }
    return opened;
  }

  private async resolve(alert: Alert, at: Date) {
    const resolved = await this.store.resolveAlert(alert.id, at);
    if (resolved) await this.notifier.emit('alert.resolved', { orgId: alert.orgId, siteId: alert.siteId }, resolved);
  }

  private async tamper(device: Device, reason: string, at: Date) {
    await this.store.insertEvent({
      time: at, orgId: device.orgId, siteId: device.siteId, deviceId: device.id, code: 'signature_failed', severity: 'critical', channel: null, message: reason, seq: null,
    });
    const existing = await this.store.findOpenAlert(device.orgId, device.id, 'tamper', null);
    if (existing) return;
    const alert = await this.store.openAlert({
      orgId: device.orgId, siteId: device.siteId, deviceId: device.id, channel: null, ruleId: null, code: 'tamper', severity: 'critical',
      title: `Unverifiable message from ${device.id} (${reason})`, value: null, openedAt: at,
    });
    await this.notifier.emit('alert.opened', { orgId: device.orgId, siteId: device.siteId }, alert);
  }

  private async deviceOnline(device: Device, at: Date) {
    const ctx = { orgId: device.orgId, siteId: device.siteId };
    await this.notifier.emit('device.online', ctx, { deviceId: device.id, at: at.toISOString() });
    const open = await this.store.findOpenAlert(device.orgId, device.id, 'device_offline', null);
    if (open) await this.resolve(open, at);
  }

  /** Called by the broker disconnect hook and by the heartbeat sweeper. */
  async deviceOffline(deviceId: string, at = new Date()): Promise<void> {
    const device = await this.store.getDevice(deviceId);
    if (!device) return;
    const changed = await this.store.markDeviceOffline(deviceId);
    if (!changed) return;
    const ctx = { orgId: device.orgId, siteId: device.siteId };
    await this.notifier.emit('device.offline', ctx, { deviceId, at: at.toISOString() });
    if (await this.store.findOpenAlert(device.orgId, deviceId, 'device_offline', null)) return;
    const alert = await this.store.openAlert({
      orgId: device.orgId, siteId: device.siteId, deviceId, channel: null, ruleId: null, code: 'device_offline', severity: 'warning',
      title: `${device.id} is offline`, value: null, openedAt: at,
    });
    await this.notifier.emit('alert.opened', ctx, alert);
  }
}

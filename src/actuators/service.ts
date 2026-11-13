import { randomUUID } from 'node:crypto';
import { commandTopic } from '../core/device-config.js';
import { evaluateRule, type AlertRule } from '../core/rules.js';
import type { Broker } from '../ingest/devices.js';
import type { PipelineHook } from '../ingest/pipeline.js';
import type { Device, ReadingRow } from '../store/types.js';
import { checkPolicy, CommandError, findCommand, SYSTEM_COMMANDS, validateArgs, type CommandSpec, type Source } from './catalogue.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export interface Automation {
  id: string; orgId: string; name: string; siteId: string | null; sourceDeviceId: string | null; channel: string | null;
  metric: string; op: 'gt' | 'lt'; threshold: number; durationS: number; hysteresis: number;
  targetDeviceId: string; command: string; args: Record<string, unknown>; clearCommand: string | null; clearArgs: Record<string, unknown>;
  cooldownS: number; lastFiredAt: Date | null;
}

const toAutomation = (r: any): Automation => ({
  id: r.id, orgId: r.org_id, name: r.name, siteId: r.site_id, sourceDeviceId: r.source_device_id, channel: r.channel, metric: r.metric,
  op: r.op, threshold: Number(r.threshold), durationS: Number(r.duration_s), hysteresis: Number(r.hysteresis), targetDeviceId: r.target_device_id,
  command: r.command, args: r.args ?? {}, clearCommand: r.clear_command, clearArgs: r.clear_args ?? {}, cooldownS: Number(r.cooldown_s),
  lastFiredAt: r.last_fired_at ? new Date(r.last_fired_at) : null,
});

/** Sends commands to devices under policy, logs them, tracks acks, and runs automations. */
export class ActuatorService implements PipelineHook {
  private cache = new Map<string, { at: number; list: Automation[] }>();

  constructor(private pool: Pool, private broker: Broker) {}

  private q(t: string, v: unknown[] = []) { return this.pool.query(t, v); }

  async catalogue(deviceId: string): Promise<CommandSpec[]> {
    const r = await this.q(`SELECT t.commands FROM devices d JOIN device_types t ON t.id = d.type_id WHERE d.id = $1`, [deviceId]);
    if (!r.rows[0]) throw new CommandError('unknown_command', `Unknown device ${deviceId}`);
    return [...SYSTEM_COMMANDS, ...((r.rows[0].commands ?? []) as CommandSpec[])];
  }

  /** Validates, logs and publishes a command. `orgId` (when set) must own the device. */
  async send(deviceId: string, name: string, args: Record<string, unknown>, by: { source: Source; actor: string; orgId?: string }) {
    const d = (await this.q(
      `SELECT d.id, d.org_id, d.status, t.commands FROM devices d JOIN device_types t ON t.id = d.type_id WHERE d.id = $1`, [deviceId])).rows[0];
    if (!d || (by.orgId && d.org_id !== by.orgId)) throw new CommandError('unknown_command', `Unknown device ${deviceId}`);
    if (d.status === 'disabled') throw new CommandError('not_allowed', `${deviceId} is disabled`);
    const spec = findCommand(d.commands, name);
    if (!spec) throw new CommandError('unknown_command', `${deviceId} does not support ${name}`);
    checkPolicy(spec, by.source);
    const clean = validateArgs(spec, args ?? {});
    if (name === 'time_sync' && clean.time === undefined) clean.time = Math.floor(Date.now() / 1000);
    const id = `c_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await this.q(
      `INSERT INTO commands (id, device_id, org_id, name, args, source, actor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, deviceId, d.org_id, name, JSON.stringify(clean), by.source === 'admin' || by.source === 'ops' ? 'user' : by.source, by.actor]);
    try {
      await this.broker.publish(commandTopic(deviceId), JSON.stringify({ v: 1, id, cmd: name, args: clean }), { qos: 1, retain: false });
    } catch (e) {
      await this.q(`UPDATE commands SET status = 'failed', result = $2 WHERE id = $1`, [id, `publish failed: ${String(e).slice(0, 200)}`]);
      throw e;
    }
    return { id, name, args: clean };
  }

  async history(deviceId: string, limit = 50) {
    return (await this.q(`SELECT * FROM commands WHERE device_id = $1 ORDER BY sent_at DESC LIMIT $2`, [deviceId, limit])).rows;
  }

  // ---------- Pipeline hooks ----------
  async onAck(_device: Device, ack: { id?: string; ok: boolean; msg?: string }, at: Date) {
    if (!ack.id) return;
    await this.q(`UPDATE commands SET status = $2, result = $3, acked_at = $4 WHERE id = $1 AND status = 'sent'`,
      [ack.id, ack.ok ? 'acked' : 'failed', ack.msg ?? null, at]);
  }

  async onReadings(device: Device, rows: ReadingRow[], live: boolean) {
    if (!live || !rows.length) return;
    const list = await this.automationsFor(device.orgId);
    if (!list.length) return;
    for (const row of rows) {
      for (const a of list) {
        if (a.metric !== row.metric) continue;
        if (a.siteId && a.siteId !== device.siteId) continue;
        if (a.sourceDeviceId && a.sourceDeviceId !== device.id) continue;
        if (a.channel && a.channel !== row.channel) continue;
        await this.evaluate(a, device.id, row);
      }
    }
  }

  private async automationsFor(orgId: string): Promise<Automation[]> {
    const c = this.cache.get(orgId);
    if (c && Date.now() - c.at < 30_000) return c.list;
    const list = (await this.q(`SELECT * FROM automations WHERE org_id = $1 AND enabled`, [orgId])).rows.map(toAutomation);
    this.cache.set(orgId, { at: Date.now(), list });
    return list;
  }

  invalidate(orgId?: string) {
    if (orgId) this.cache.delete(orgId);
    else this.cache.clear();
  }

  private async evaluate(a: Automation, deviceId: string, row: ReadingRow) {
    const st = (await this.q(`SELECT breach_since, active FROM automation_state WHERE automation_id = $1 AND device_id = $2 AND channel = $3`,
      [a.id, deviceId, row.channel])).rows[0];
    const prev = { breachSince: st?.breach_since ? new Date(st.breach_since) : null, alertId: st?.active === true || st?.active === 't' ? 'active' : null };
    const rule: AlertRule = { id: a.id, orgId: a.orgId, siteId: a.siteId, deviceId: null, channel: a.channel, metric: a.metric, op: a.op,
      threshold: a.threshold, durationS: a.durationS, hysteresis: a.hysteresis, severity: 'info', name: a.name };
    const { state, action } = evaluateRule(rule, prev, row.value, row.time);
    const actor = { source: 'automation' as const, actor: `automation:${a.id}` };

    if (action === 'open') {
      const coolingDown = a.lastFiredAt && row.time.getTime() - a.lastFiredAt.getTime() < a.cooldownS * 1000;
      if (coolingDown) return; // keep state unchanged; try again on a later reading
      await this.send(a.targetDeviceId, a.command, a.args, actor);
      state.alertId = 'active';
      a.lastFiredAt = row.time;
      await this.q(`UPDATE automations SET last_fired_at = $2 WHERE id = $1`, [a.id, row.time]);
    } else if (action === 'resolve' && a.clearCommand) {
      await this.send(a.targetDeviceId, a.clearCommand, a.clearArgs, actor);
    }
    if (state.breachSince?.getTime() !== prev.breachSince?.getTime() || state.alertId !== prev.alertId) {
      await this.q(
        `INSERT INTO automation_state (automation_id, device_id, channel, breach_since, active) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (automation_id, device_id, channel) DO UPDATE SET breach_since = EXCLUDED.breach_since, active = EXCLUDED.active`,
        [a.id, deviceId, row.channel, state.breachSince, state.alertId !== null]);
    }
  }
}

// Titan admin CLI — bootstrap organisations, sites, devices and keys before the admin dashboard ships.
// Usage: npm run cli -- <command> [args] [--flag value]
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { randomToken, sha256Hex } from './core/crypto.js';
import { Billing } from './billing/billing.js';
import { hashPassword } from './admin/auth.js';
import { DeviceService, EmqxBroker } from './ingest/devices.js';
import { PostgresStore } from './store/postgres.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    kind: { type: 'string' }, type: { type: 'string' }, gsm: { type: 'boolean' }, scopes: { type: 'string' }, crop: { type: 'string' },
    min: { type: 'string' }, site: { type: 'string' }, device: { type: 'string' }, channel: { type: 'string' }, duration: { type: 'string' },
    hysteresis: { type: 'string' }, severity: { type: 'string' }, ref: { type: 'string' }, name: { type: 'string' },
  },
});
const [cmd, ...args] = positionals;
const store = PostgresStore.fromUrl(config.databaseUrl);
const q = (t: string, v: unknown[] = []) => store.pool.query(t, v);
const devices = new DeviceService(store, new EmqxBroker(config.emqx.apiUrl, config.emqx.apiKey, config.emqx.apiSecret));
const need = (n: number, usage: string) => { if (args.length < n) { console.error(`Usage: ${usage}`); process.exit(1); } };

const commands: Record<string, () => Promise<unknown>> = {
  async 'org:create'() {
    need(1, 'org:create <name> [--kind client|consumer]');
    return (await q(`INSERT INTO organisations (name, kind) VALUES ($1, $2) RETURNING id, name, kind`, [args[0], values.kind ?? 'client'])).rows[0];
  },
  async 'org:list'() { return (await q(`SELECT id, name, kind, device_prefix FROM organisations ORDER BY created_at`)).rows; },
  async 'site:create'() {
    need(2, 'site:create <orgId> <name> [--kind warehouse] [--ref STORAGEX_ID]');
    return (await q(`INSERT INTO sites (org_id, name, kind, external_ref) VALUES ($1,$2,$3,$4) RETURNING id, name, kind`, [args[0], args[1], values.kind ?? 'warehouse', values.ref ?? null])).rows[0];
  },
  async 'zone:create'() {
    need(2, 'zone:create <siteId> <code> [--name "Bay 1"]');
    return (await q(`INSERT INTO zones (site_id, code, name) VALUES ($1,$2,$3) RETURNING id, code`, [args[0], args[1], values.name ?? null])).rows[0];
  },
  async 'stack:create'() {
    need(3, 'stack:create <siteId> <zoneCode> <stackCode> [--crop maize] [--ref LOT_ID]');
    return (await q(
      `INSERT INTO stacks (zone_id, code, commodity, external_ref) SELECT id, $3, $4, $5 FROM zones WHERE site_id = $1 AND code = $2 RETURNING id, code, commodity`,
      [args[0], args[1], args[2], values.crop ?? null, values.ref ?? null])).rows[0];
  },
  async 'device:create'() {
    need(3, 'device:create <deviceId> <orgId> <siteId> [--type wareguard-v1] [--gsm]');
    await q(`INSERT INTO devices (id, org_id, site_id, type_id, connectivity) VALUES ($1,$2,$3,$4,$5)`,
      [args[0], args[1], args[2], values.type ?? 'wareguard-v1', values.gsm ? 'gsm' : 'wifi']);
    return { deviceId: args[0], provisioningCode: await devices.issueProvisionCode(args[0]), expires: '7 days' };
  },
  async 'device:code'() { need(1, 'device:code <deviceId>'); return { provisioningCode: await devices.issueProvisionCode(args[0]) }; },
  /** Removes a device and everything it sent (readings, alerts, commands). For test devices; real devices should be disabled instead. */
  async 'device:delete'() {
    need(2, 'device:delete <deviceId> --yes');
    if (args[1] !== '--yes') throw new Error('Add --yes to confirm: this deletes the device and all its readings');
    const id = args[0];
    const q = (t: string) => store.pool.query(t, [id]);
    const t = ['readings', 'events', 'messages', 'alerts', 'alert_rules', 'commands', 'automation_state', 'device_firmware', 'device_keys', 'quality_tests'];
    const counts: Record<string, number> = {};
    for (const table of t) {
      try { counts[table] = (await q(`DELETE FROM ${table} WHERE device_id = $1`)).rowCount ?? 0; } catch { /* table without device_id */ }
    }
    await store.pool.query(`UPDATE devices SET gateway_id = NULL WHERE gateway_id = $1`, [id]);
    const d = await q(`DELETE FROM devices WHERE id = $1`);
    if (!d.rowCount) throw new Error(`No device ${id}`);
    return { deleted: id, removed: counts };
  },
  async 'config:push'() { need(1, 'config:push <deviceId>'); return devices.pushConfig(args[0], null); },
  async 'apikey:create'() {
    need(2, 'apikey:create <orgId> <name> [--scopes read:readings,read:alerts,manage:webhooks,manage:grants]');
    const key = `tk_live_${randomToken(24)}`;
    const scopes = (values.scopes ?? 'read:readings,read:alerts').split(',');
    const id = await store.createApiKey(args[0], args[1], key.slice(0, 12), sha256Hex(key), scopes);
    return { id, key, scopes, note: 'Store this key now; it is not shown again.' };
  },
  async 'contact:add'() {
    need(3, 'contact:add <orgId> email|sms <address> [--min warning] [--site siteId]');
    return (await q(`INSERT INTO notification_contacts (org_id, channel, address, min_severity, site_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [args[0], args[1], args[2], values.min ?? 'warning', values.site ?? null])).rows[0];
  },
  async 'rule:create'() {
    need(4, 'rule:create <orgId> <metric> gt|lt <threshold> [--site id] [--device id] [--channel ch] [--duration s] [--hysteresis n] [--severity warning]');
    return (await q(
      `INSERT INTO alert_rules (org_id, metric, op, threshold, site_id, device_id, channel, duration_s, hysteresis, severity, name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [args[0], args[1], args[2], Number(args[3]), values.site ?? null, values.device ?? null, values.channel ?? null,
        Number(values.duration ?? 0), Number(values.hysteresis ?? 0), values.severity ?? 'warning', values.name ?? null])).rows[0];
  },
  async 'user:create'() {
    need(2, 'user:create <email> admin|ops [--name "Full Name"]  (prints a temporary password)');
    if (!['admin', 'ops'].includes(args[1])) throw new Error('role must be admin or ops');
    const org = (await q(`SELECT id FROM organisations WHERE kind = 'kitovu' LIMIT 1`)).rows[0];
    const password = randomToken(12);
    await q(`INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5)`,
      [org.id, args[0].toLowerCase(), values.name ?? null, args[1], await hashPassword(password)]);
    return { email: args[0], role: args[1], temporaryPassword: password, note: 'Sign in at /admin and change it under Settings.' };
  },
  async 'invoices:generate'() {
    need(1, 'invoices:generate <YYYY-MM>');
    return { created: await new Billing(store.pool, config.paystack.secretKey).generateInvoices(args[0]) };
  },
};

const run = commands[cmd ?? ''];
if (!run) {
  console.log(`Commands:\n  ${Object.keys(commands).join('\n  ')}`);
  process.exit(cmd ? 1 : 0);
}
try {
  console.log(JSON.stringify(await run(), null, 2));
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  await store.pool.end();
}

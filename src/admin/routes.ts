import { randomToken, sha256Hex } from '../core/crypto.js';
import { HttpError, type Req, type Router } from '../http/router.js';
import type { DeviceService } from '../ingest/devices.js';
import { clearCookie, hashPassword, parseCookies, SESSION_COOKIE, SESSION_DAYS, sessionCookie, verifyPassword } from './auth.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export interface AdminDeps {
  pool: Pool;
  devices: DeviceService;
  secureCookies: boolean;
}

interface Session { userId: string; email: string; name: string | null; role: 'admin' | 'ops' }

const SITE_KINDS = ['warehouse', 'aquaponics', 'hydroponics', 'greenhouse', 'cold_room', 'poultry', 'field', 'energy', 'other'];
const SCOPES = ['read:readings', 'read:alerts', 'manage:webhooks', 'manage:grants'];
const DEVICE_ID = /^[A-Z]{2,6}-\d{6,}$/;
const INTERVAL_KEYS = ['telemetry_s', 'moisture_s', 'heartbeat_s'];

const str = (v: unknown, name: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'invalid_request', `${name} is required`);
  return v.trim().slice(0, max);
};
const optStr = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function cleanIntervals(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!x || typeof x !== 'object') return out;
  for (const k of INTERVAL_KEYS) {
    const v = (x as any)[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 86_400) throw new HttpError(400, 'invalid_interval', `${k} must be a whole number of seconds between 1 and 86400`);
    out[k] = n;
  }
  return out;
}

export function registerAdmin(r: Router, d: AdminDeps) {
  const q = (t: string, v: unknown[] = []) => d.pool.query(t, v);

  const audit = (s: Session, action: string, target: string | null, detail?: unknown) =>
    q(`INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)`, [`user:${s.userId}`, action, target, detail === undefined ? null : JSON.stringify(detail)]);

  /** Every admin route needs a session; writes also need the X-Titan-Admin header (blocks cross-site form posts). */
  const session = async (req: Req, role?: 'admin'): Promise<Session> => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) throw new HttpError(401, 'unauthorized');
    const row = (await q(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > now() AND u.disabled_at IS NULL AND u.role IN ('admin','ops')`, [sha256Hex(token)])).rows[0];
    if (!row) throw new HttpError(401, 'unauthorized');
    if (req.method !== 'GET' && req.headers['x-titan-admin'] !== '1') throw new HttpError(403, 'forbidden', 'Missing X-Titan-Admin header');
    if (role === 'admin' && row.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can do this');
    return { userId: row.id, email: row.email, name: row.name, role: row.role };
  };

  // ---------- Auth ----------
  const attempts = new Map<string, { n: number; reset: number }>();
  r.post('/admin/api/login', async (req) => {
    const key = `${req.ip}|${String(req.body?.email ?? '').toLowerCase()}`;
    const a = attempts.get(key);
    if (a && a.reset > Date.now() && a.n >= 8) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.');
    const email = str(req.body?.email, 'email').toLowerCase();
    const password = str(req.body?.password, 'password', 500);
    const u = (await q(`SELECT id, password_hash, role, disabled_at FROM users WHERE lower(email) = $1`, [email])).rows[0];
    const ok = !!u && !u.disabled_at && ['admin', 'ops'].includes(u.role) && (await verifyPassword(password, u.password_hash));
    if (!ok) {
      attempts.set(key, { n: (a && a.reset > Date.now() ? a.n : 0) + 1, reset: Date.now() + 15 * 60_000 });
      throw new HttpError(401, 'invalid_login', 'Email or password is incorrect');
    }
    attempts.delete(key);
    const token = randomToken(32);
    await q(`INSERT INTO sessions (id, user_id, expires_at, ip) VALUES ($1,$2, now() + make_interval(days => $3), $4)`, [sha256Hex(token), u.id, SESSION_DAYS, req.ip]);
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
    return { body: { ok: true, role: u.role }, headers: { 'Set-Cookie': sessionCookie(token, d.secureCookies) } };
  });

  r.post('/admin/api/logout', async (req) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await q(`DELETE FROM sessions WHERE id = $1`, [sha256Hex(token)]);
    return { body: { ok: true }, headers: { 'Set-Cookie': clearCookie(d.secureCookies) } };
  });

  r.get('/admin/api/me', async (req) => ({ body: await session(req) }));

  // ---------- Overview ----------
  r.get('/admin/api/overview', async (req) => {
    await session(req);
    const counts = (await q(`SELECT
      (SELECT count(*) FROM organisations)::int AS orgs,
      (SELECT count(*) FROM sites)::int AS sites,
      (SELECT count(*) FROM devices WHERE status = 'online')::int AS online,
      (SELECT count(*) FROM devices WHERE status = 'offline')::int AS offline,
      (SELECT count(*) FROM devices WHERE status = 'registered')::int AS awaiting,
      (SELECT count(*) FROM alerts WHERE status = 'open' AND severity = 'critical')::int AS critical,
      (SELECT count(*) FROM alerts WHERE status <> 'resolved')::int AS open_alerts,
      (SELECT coalesce(sum(messages),0) FROM usage_daily WHERE day = current_date)::bigint AS messages_today,
      (SELECT count(*) FROM devices WHERE config_acked_version < config_version)::int AS config_pending`)).rows[0];
    const alerts = (await q(
      `SELECT a.*, s.name AS site_name FROM alerts a LEFT JOIN sites s ON s.id = a.site_id
       WHERE a.status <> 'resolved' ORDER BY (a.severity = 'critical') DESC, a.opened_at DESC LIMIT 20`)).rows;
    const sites = (await q(
      `SELECT s.id, s.name, s.kind, s.lat, s.lng, o.name AS org_name,
         count(DISTINCT dv.id)::int AS devices,
         count(DISTINCT dv.id) FILTER (WHERE dv.status = 'online')::int AS online,
         (SELECT count(*) FROM alerts al WHERE al.site_id = s.id AND al.status <> 'resolved')::int AS open_alerts
       FROM sites s JOIN organisations o ON o.id = s.org_id LEFT JOIN devices dv ON dv.site_id = s.id
       GROUP BY s.id, o.name ORDER BY open_alerts DESC, s.name LIMIT 200`)).rows;
    return { body: { counts, alerts, sites } };
  });

  // ---------- Organisations ----------
  r.get('/admin/api/orgs', async (req) => {
    await session(req);
    return { body: { orgs: (await q(
      `SELECT o.*, (SELECT count(*) FROM sites s WHERE s.org_id = o.id)::int AS sites,
         (SELECT count(*) FROM devices dv WHERE dv.org_id = o.id)::int AS devices, sub.plan_id
       FROM organisations o LEFT JOIN subscriptions sub ON sub.org_id = o.id ORDER BY o.created_at`)).rows } };
  });
  r.post('/admin/api/orgs', async (req) => {
    const s = await session(req);
    const kind = req.body?.kind ?? 'client';
    if (!['client', 'consumer'].includes(kind)) throw new HttpError(400, 'invalid_kind');
    const prefix = optStr(req.body?.devicePrefix, 6)?.toUpperCase() ?? null;
    if (prefix && !/^[A-Z]{2,6}$/.test(prefix)) throw new HttpError(400, 'invalid_prefix', 'Device prefix must be 2–6 letters');
    if (prefix && (await q(`SELECT 1 FROM organisations WHERE device_prefix = $1`, [prefix])).rows.length) throw new HttpError(409, 'prefix_taken', `Device prefix ${prefix} is already used`);
    const row = (await q(`INSERT INTO organisations (name, kind, billing_email, device_prefix) VALUES ($1,$2,$3,$4) RETURNING *`,
      [str(req.body?.name, 'name'), kind, optStr(req.body?.billingEmail), prefix])).rows[0];
    await audit(s, 'org.created', row.id, { name: row.name });
    return { status: 201, body: { org: row } };
  });

  // ---------- Sites, zones, stacks ----------
  r.get('/admin/api/sites', async (req) => {
    await session(req);
    return { body: { sites: (await q(
      `SELECT s.*, o.name AS org_name, (SELECT count(*) FROM devices dv WHERE dv.site_id = s.id)::int AS devices
       FROM sites s JOIN organisations o ON o.id = s.org_id ORDER BY o.name, s.name`)).rows } };
  });
  r.post('/admin/api/sites', async (req) => {
    const s = await session(req);
    const kind = req.body?.kind ?? 'warehouse';
    if (!SITE_KINDS.includes(kind)) throw new HttpError(400, 'invalid_kind');
    const lat = req.body?.lat === '' || req.body?.lat == null ? null : Number(req.body.lat);
    const lng = req.body?.lng === '' || req.body?.lng == null ? null : Number(req.body.lng);
    if ((lat !== null && !(lat >= -90 && lat <= 90)) || (lng !== null && !(lng >= -180 && lng <= 180))) throw new HttpError(400, 'invalid_location');
    const row = (await q(`INSERT INTO sites (org_id, name, kind, external_ref, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [str(req.body?.orgId, 'orgId'), str(req.body?.name, 'name'), kind, optStr(req.body?.externalRef), optStr(req.body?.address, 300), lat, lng])).rows[0];
    await audit(s, 'site.created', row.id, { name: row.name });
    return { status: 201, body: { site: row } };
  });
  r.get('/admin/api/sites/:id', async (req) => {
    await session(req);
    const site = (await q(`SELECT s.*, o.name AS org_name FROM sites s JOIN organisations o ON o.id = s.org_id WHERE s.id = $1`, [req.params.id])).rows[0];
    if (!site) throw new HttpError(404, 'not_found');
    const zones = (await q(`SELECT * FROM zones WHERE site_id = $1 ORDER BY code`, [site.id])).rows;
    const stacks = (await q(`SELECT st.*, z.code AS zone_code FROM stacks st JOIN zones z ON z.id = st.zone_id WHERE z.site_id = $1 ORDER BY z.code, st.code`, [site.id])).rows;
    const devices = (await q(`SELECT id, type_id, connectivity, status, last_seen_at, config_version, config_acked_version FROM devices WHERE site_id = $1 ORDER BY id`, [site.id])).rows;
    const latest = (await q(
      `SELECT DISTINCT ON (device_id, channel, metric) time, device_id, channel, metric, value, quality, flags FROM readings
       WHERE site_id = $1 AND time > now() - interval '2 days' AND quality <> 'rejected' ORDER BY device_id, channel, metric, time DESC`, [site.id])).rows;
    const alerts = (await q(`SELECT * FROM alerts WHERE site_id = $1 ORDER BY opened_at DESC LIMIT 50`, [site.id])).rows;
    return { body: { site, zones, stacks, devices, latest, alerts } };
  });
  r.post('/admin/api/sites/:id/zones', async (req) => {
    const s = await session(req);
    const code = str(req.body?.code, 'code', 40);
    if (!/^[a-z0-9-]+$/.test(code)) throw new HttpError(400, 'invalid_code', 'Zone code: lowercase letters, digits and hyphens (it must match the device channel)');
    const row = (await q(`INSERT INTO zones (site_id, code, name) VALUES ($1,$2,$3) RETURNING *`, [req.params.id, code, optStr(req.body?.name)])).rows[0];
    await audit(s, 'zone.created', row.id, { code });
    return { status: 201, body: { zone: row } };
  });
  r.post('/admin/api/sites/:id/stacks', async (req) => {
    const s = await session(req);
    const code = str(req.body?.code, 'code', 40);
    if (!/^[a-z0-9-]+$/.test(code)) throw new HttpError(400, 'invalid_code', 'Stack code: lowercase letters, digits and hyphens');
    const row = (await q(
      `INSERT INTO stacks (zone_id, code, commodity, external_ref) SELECT id, $3, $4, $5 FROM zones WHERE site_id = $1 AND code = $2 RETURNING *`,
      [req.params.id, str(req.body?.zone, 'zone'), code, optStr(req.body?.commodity), optStr(req.body?.externalRef)])).rows[0];
    if (!row) throw new HttpError(400, 'zone_not_found');
    await audit(s, 'stack.created', row.id, { code });
    return { status: 201, body: { stack: row } };
  });

  // ---------- Devices ----------
  r.get('/admin/api/devices', async (req) => {
    await session(req);
    return { body: { devices: (await q(
      `SELECT dv.id, dv.type_id, dv.connectivity, dv.status, dv.last_seen_at, dv.config_version, dv.config_acked_version, dv.last_state,
         s.name AS site_name, s.id AS site_id, o.name AS org_name
       FROM devices dv JOIN organisations o ON o.id = dv.org_id LEFT JOIN sites s ON s.id = dv.site_id ORDER BY dv.id`)).rows } };
  });
  r.post('/admin/api/devices', async (req) => {
    const s = await session(req);
    const id = str(req.body?.id, 'id', 64).toUpperCase();
    if (!DEVICE_ID.test(id)) throw new HttpError(400, 'invalid_id', 'Device ID looks like WG-000123');
    const connectivity = req.body?.connectivity === 'gsm' ? 'gsm' : 'wifi';
    const site = (await q(`SELECT org_id FROM sites WHERE id = $1`, [str(req.body?.siteId, 'siteId')])).rows[0];
    if (!site) throw new HttpError(400, 'site_not_found');
    if ((await q(`SELECT 1 FROM devices WHERE id = $1`, [id])).rows.length) throw new HttpError(409, 'exists', `${id} is already registered`);
    await q(`INSERT INTO devices (id, org_id, site_id, type_id, connectivity, name, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, site.org_id, req.body.siteId, optStr(req.body?.typeId) ?? 'wareguard-v1', connectivity, optStr(req.body?.name), optStr(req.body?.notes, 1000)]);
    const code = await d.devices.issueProvisionCode(id);
    await audit(s, 'device.registered', id);
    return { status: 201, body: { id, provisioningCode: code, expiresInDays: 7 } };
  });
  r.get('/admin/api/devices/:id', async (req) => {
    await session(req);
    const id = req.params.id;
    const device = (await q(
      `SELECT dv.*, s.name AS site_name, o.name AS org_name, t.name AS type_name, t.defaults AS type_defaults
       FROM devices dv JOIN organisations o ON o.id = dv.org_id JOIN device_types t ON t.id = dv.type_id LEFT JOIN sites s ON s.id = dv.site_id
       WHERE dv.id = $1`, [id])).rows[0];
    if (!device) throw new HttpError(404, 'not_found');
    delete device.token_hash;
    delete device.provision_code_hash;
    const keys = (await q(`SELECT key_id, alg, created_at, retired_at FROM device_keys WHERE device_id = $1 ORDER BY created_at`, [id])).rows;
    const latest = (await q(
      `SELECT DISTINCT ON (channel, metric) time, channel, metric, value, quality, flags FROM readings
       WHERE device_id = $1 AND time > now() - interval '2 days' ORDER BY channel, metric, time DESC`, [id])).rows;
    const events = (await q(`SELECT * FROM events WHERE device_id = $1 ORDER BY time DESC LIMIT 30`, [id])).rows;
    const configs = (await q(`SELECT version, doc, created_at, acked_at FROM device_configs WHERE device_id = $1 ORDER BY version DESC LIMIT 10`, [id])).rows;
    const alerts = (await q(`SELECT * FROM alerts WHERE device_id = $1 ORDER BY opened_at DESC LIMIT 20`, [id])).rows;
    return { body: { device, keys, latest, events, configs, alerts } };
  });
  r.get('/admin/api/devices/:id/series', async (req) => {
    await session(req);
    const hours = Math.min(Math.max(Number(req.query.get('hours') ?? 24) || 24, 1), 24 * 90);
    const bucket = hours <= 6 ? '1 minute' : hours <= 24 * 7 ? '15 minutes' : '1 hour';
    const metric = str(req.query.get('metric'), 'metric', 60);
    const rows = (await q(
      `SELECT date_bin(interval '${bucket}', time, timestamptz '2000-01-01') AS t, channel, avg(value) AS avg, min(value) AS min, max(value) AS max
       FROM readings WHERE device_id = $1 AND metric = $2 AND time > now() - make_interval(hours => $3) AND quality <> 'rejected'
       GROUP BY 1, 2 ORDER BY 1`, [req.params.id, metric, hours])).rows;
    return { body: { metric, bucket, points: rows.map((x) => ({ t: x.t, channel: x.channel, avg: Number(x.avg), min: Number(x.min), max: Number(x.max) })) } };
  });
  r.post('/admin/api/devices/:id/code', async (req) => {
    const s = await session(req);
    if (!(await q(`SELECT 1 FROM devices WHERE id = $1`, [req.params.id])).rows.length) throw new HttpError(404, 'not_found');
    const code = await d.devices.issueProvisionCode(req.params.id);
    await audit(s, 'device.code_issued', req.params.id);
    return { body: { provisioningCode: code, expiresInDays: 7 } };
  });
  r.post('/admin/api/devices/:id/config', async (req) => {
    const s = await session(req);
    const b = req.body ?? {};
    const thresholds: Record<string, { min?: number; max?: number }> = {};
    for (const [m, v] of Object.entries(b.thresholds ?? {})) {
      const t: { min?: number; max?: number } = {};
      for (const k of ['min', 'max'] as const) {
        const raw = (v as any)?.[k];
        if (raw === undefined || raw === null || raw === '') continue;
        if (!Number.isFinite(Number(raw))) throw new HttpError(400, 'invalid_threshold', `${m} ${k} must be a number`);
        t[k] = Number(raw);
      }
      if (Object.keys(t).length) thresholds[m] = t;
    }
    const override = {
      interval: cleanIntervals(b.interval),
      thresholds,
      alarm_enable: b.alarm_enable !== false,
      cal: typeof b.cal === 'object' && b.cal ? b.cal : {},
    };
    const conn = b.connectivity === 'gsm' || b.connectivity === 'wifi' ? b.connectivity : null;
    const upd = await q(`UPDATE devices SET config_override = $2, connectivity = COALESCE($3, connectivity) WHERE id = $1`, [req.params.id, JSON.stringify(override), conn]);
    if (!upd.rowCount) throw new HttpError(404, 'not_found');
    const doc = await d.devices.pushConfig(req.params.id, s.userId);
    await audit(s, 'device.config_pushed', req.params.id, override);
    return { body: { config: doc, pending: true } };
  });
  r.post('/admin/api/devices/:id/command', async (req) => {
    const s = await session(req);
    const cmd = req.body?.cmd;
    if (!['alarm_ack', 'reboot', 'time_sync', 'send_state'].includes(cmd)) throw new HttpError(400, 'invalid_command');
    const id = await d.devices.sendCommand(req.params.id, cmd, typeof req.body?.args === 'object' ? req.body.args : {});
    await audit(s, 'device.command', req.params.id, { cmd, id });
    return { body: { commandId: id } };
  });
  r.post('/admin/api/devices/:id/status', async (req) => {
    const s = await session(req, 'admin');
    const disable = req.body?.disabled === true;
    const upd = await q(`UPDATE devices SET status = $2 WHERE id = $1`, [req.params.id, disable ? 'disabled' : 'offline']);
    if (!upd.rowCount) throw new HttpError(404, 'not_found');
    await audit(s, disable ? 'device.disabled' : 'device.enabled', req.params.id);
    return { body: { ok: true } };
  });

  // ---------- Alerts ----------
  r.get('/admin/api/alerts', async (req) => {
    await session(req);
    const status = req.query.get('status');
    return { body: { alerts: (await q(
      `SELECT a.*, s.name AS site_name, u.email AS acked_by_email FROM alerts a LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN users u ON u.id = a.acked_by
       WHERE ($1::text IS NULL AND a.status <> 'resolved') OR a.status = $1 ORDER BY a.opened_at DESC LIMIT 300`, [status])).rows } };
  });
  r.post('/admin/api/alerts/:id/ack', async (req) => {
    const s = await session(req);
    const upd = await q(`UPDATE alerts SET status = 'acknowledged', acked_at = now(), acked_by = $2 WHERE id = $1 AND status = 'open'`, [req.params.id, s.userId]);
    if (!upd.rowCount) throw new HttpError(409, 'not_open', 'Alert is not open');
    await audit(s, 'alert.acknowledged', req.params.id);
    return { body: { ok: true } };
  });
  r.post('/admin/api/alerts/:id/resolve', async (req) => {
    const s = await session(req);
    const upd = await q(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1 AND status <> 'resolved'`, [req.params.id]);
    if (!upd.rowCount) throw new HttpError(409, 'already_resolved');
    await q(`UPDATE rule_state SET alert_id = NULL, breach_since = NULL WHERE alert_id = $1`, [req.params.id]);
    await audit(s, 'alert.resolved', req.params.id);
    return { body: { ok: true } };
  });

  // ---------- Alert rules & contacts ----------
  r.get('/admin/api/rules', async (req) => {
    await session(req);
    return { body: { rules: (await q(
      `SELECT r.*, o.name AS org_name, s.name AS site_name FROM alert_rules r JOIN organisations o ON o.id = r.org_id LEFT JOIN sites s ON s.id = r.site_id ORDER BY o.name, r.metric`)).rows } };
  });
  r.post('/admin/api/rules', async (req) => {
    const s = await session(req);
    const b = req.body ?? {};
    if (!['gt', 'lt'].includes(b.op)) throw new HttpError(400, 'invalid_op');
    if (!['info', 'warning', 'critical'].includes(b.severity ?? 'warning')) throw new HttpError(400, 'invalid_severity');
    const threshold = Number(b.threshold);
    if (!Number.isFinite(threshold)) throw new HttpError(400, 'invalid_threshold');
    const row = (await q(
      `INSERT INTO alert_rules (org_id, site_id, device_id, channel, metric, op, threshold, duration_s, hysteresis, severity, name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [str(b.orgId, 'orgId'), optStr(b.siteId), optStr(b.deviceId), optStr(b.channel), str(b.metric, 'metric'), b.op, threshold,
        Math.max(0, Number(b.durationS) || 0), Math.max(0, Number(b.hysteresis) || 0), b.severity ?? 'warning', optStr(b.name)])).rows[0];
    await audit(s, 'rule.created', row.id, b);
    return { status: 201, body: { rule: row } };
  });
  r.post('/admin/api/rules/:id/toggle', async (req) => {
    const s = await session(req);
    const row = (await q(`UPDATE alert_rules SET enabled = NOT enabled WHERE id = $1 RETURNING enabled`, [req.params.id])).rows[0];
    if (!row) throw new HttpError(404, 'not_found');
    await audit(s, 'rule.toggled', req.params.id, row);
    return { body: row };
  });
  r.get('/admin/api/contacts', async (req) => {
    await session(req);
    return { body: { contacts: (await q(
      `SELECT c.*, o.name AS org_name, s.name AS site_name FROM notification_contacts c JOIN organisations o ON o.id = c.org_id LEFT JOIN sites s ON s.id = c.site_id ORDER BY o.name`)).rows } };
  });
  r.post('/admin/api/contacts', async (req) => {
    const s = await session(req);
    const b = req.body ?? {};
    if (!['email', 'sms'].includes(b.channel)) throw new HttpError(400, 'invalid_channel');
    const address = str(b.address, 'address');
    if (b.channel === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new HttpError(400, 'invalid_email');
    if (b.channel === 'sms' && !/^\+?\d{10,15}$/.test(address)) throw new HttpError(400, 'invalid_phone', 'Phone in international format, e.g. 2348012345678');
    const row = (await q(`INSERT INTO notification_contacts (org_id, site_id, channel, address, min_severity) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [str(b.orgId, 'orgId'), optStr(b.siteId), b.channel, address, ['info', 'warning', 'critical'].includes(b.minSeverity) ? b.minSeverity : 'warning'])).rows[0];
    await audit(s, 'contact.created', row.id);
    return { status: 201, body: { contact: row } };
  });
  r.delete('/admin/api/contacts/:id', async (req) => {
    const s = await session(req);
    await q(`DELETE FROM notification_contacts WHERE id = $1`, [req.params.id]);
    await audit(s, 'contact.deleted', req.params.id);
    return { status: 204 };
  });

  // ---------- Reporting frequency (device types) ----------
  r.get('/admin/api/device-types', async (req) => {
    await session(req);
    return { body: { types: (await q(
      `SELECT t.*, (SELECT count(*) FROM devices dv WHERE dv.type_id = t.id)::int AS devices FROM device_types t ORDER BY t.id`)).rows } };
  });
  r.post('/admin/api/device-types/:id', async (req) => {
    const s = await session(req, 'admin');
    const defaults = { wifi: cleanIntervals(req.body?.wifi), gsm: cleanIntervals(req.body?.gsm) };
    const upd = await q(`UPDATE device_types SET defaults = $2 WHERE id = $1`, [req.params.id, JSON.stringify(defaults)]);
    if (!upd.rowCount) throw new HttpError(404, 'not_found');
    // Push the new frequencies to every active device of this type.
    const ids = (await q(`SELECT id FROM devices WHERE type_id = $1 AND status <> 'disabled' AND token_hash IS NOT NULL`, [req.params.id])).rows.map((x) => x.id);
    const failed: string[] = [];
    for (const id of ids) await d.devices.pushConfig(id, s.userId).catch(() => failed.push(id));
    await audit(s, 'device_type.defaults_changed', req.params.id, defaults);
    return { body: { defaults, pushedTo: ids.length - failed.length, failed } };
  });

  // ---------- API keys ----------
  r.get('/admin/api/apikeys', async (req) => {
    await session(req);
    return { body: { keys: (await q(
      `SELECT k.id, k.org_id, k.name, k.prefix, k.scopes, k.last_used_at, k.revoked_at, k.created_at, o.name AS org_name
       FROM api_keys k JOIN organisations o ON o.id = k.org_id ORDER BY k.created_at DESC`)).rows } };
  });
  r.post('/admin/api/apikeys', async (req) => {
    const s = await session(req, 'admin');
    const scopes: string[] = Array.isArray(req.body?.scopes) && req.body.scopes.length ? req.body.scopes : ['read:readings', 'read:alerts'];
    if (scopes.some((x) => !SCOPES.includes(x))) throw new HttpError(400, 'invalid_scopes');
    const key = `tk_live_${randomToken(24)}`;
    const row = (await q(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [str(req.body?.orgId, 'orgId'), str(req.body?.name, 'name'), key.slice(0, 12), sha256Hex(key), scopes])).rows[0];
    await audit(s, 'apikey.created', row.id, { scopes });
    return { status: 201, body: { id: row.id, key, scopes } };
  });
  r.post('/admin/api/apikeys/:id/revoke', async (req) => {
    const s = await session(req, 'admin');
    await q(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [req.params.id]);
    await audit(s, 'apikey.revoked', req.params.id);
    return { body: { ok: true } };
  });

  // ---------- Plans & subscriptions (admin only) ----------
  r.get('/admin/api/plans', async (req) => {
    await session(req);
    return { body: { plans: (await q(`SELECT * FROM plans ORDER BY sort, id`)).rows } };
  });
  r.post('/admin/api/plans', async (req) => {
    const s = await session(req, 'admin');
    const b = req.body ?? {};
    const id = str(b.id, 'id', 40).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(id)) throw new HttpError(400, 'invalid_id');
    const n = (v: unknown) => { const x = Number(v ?? 0); if (!Number.isFinite(x) || x < 0) throw new HttpError(400, 'invalid_number'); return x; };
    const features = Array.isArray(b.features) ? b.features.map(String).slice(0, 12) : String(b.features ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12);
    const row = (await q(
      `INSERT INTO plans (id, name, currency, price_per_device, base_fee, included_api_calls, overage_per_1k_calls, features, published, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, currency = EXCLUDED.currency, price_per_device = EXCLUDED.price_per_device,
         base_fee = EXCLUDED.base_fee, included_api_calls = EXCLUDED.included_api_calls, overage_per_1k_calls = EXCLUDED.overage_per_1k_calls,
         features = EXCLUDED.features, published = EXCLUDED.published, sort = EXCLUDED.sort
       RETURNING *`,
      [id, str(b.name, 'name'), b.currency === 'USD' ? 'USD' : 'NGN', n(b.pricePerDevice), n(b.baseFee), Math.round(n(b.includedApiCalls)),
        n(b.overagePer1kCalls), features, b.published === true, Math.round(n(b.sort))])).rows[0];
    await audit(s, 'plan.saved', id, b);
    return { body: { plan: row } };
  });
  r.post('/admin/api/subscriptions', async (req) => {
    const s = await session(req, 'admin');
    const orgId = str(req.body?.orgId, 'orgId');
    const planId = str(req.body?.planId, 'planId');
    await q(`INSERT INTO subscriptions (org_id, plan_id) VALUES ($1,$2) ON CONFLICT (org_id) DO UPDATE SET plan_id = EXCLUDED.plan_id`, [orgId, planId]);
    await audit(s, 'subscription.set', orgId, { planId });
    return { body: { ok: true } };
  });

  // ---------- Registry, usage, demo requests ----------
  r.get('/admin/api/metrics', async (req) => {
    await session(req);
    return { body: { metrics: (await q(`SELECT * FROM metrics ORDER BY key`)).rows, crops: (await q(`SELECT * FROM crop_profiles ORDER BY crop`)).rows } };
  });
  r.get('/admin/api/usage', async (req) => {
    await session(req);
    const month = req.query.get('month') ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'invalid_month');
    return { body: { month, usage: (await q(
      `SELECT o.id, o.name, coalesce(sum(u.messages),0)::bigint AS messages, coalesce(sum(u.readings),0)::bigint AS readings,
         coalesce(sum(u.api_calls),0)::bigint AS api_calls, coalesce(sum(u.webhooks),0)::bigint AS webhooks,
         (SELECT count(DISTINCT device_id) FROM usage_devices_daily ud WHERE ud.org_id = o.id AND ud.day >= $1::date AND ud.day < $1::date + interval '1 month')::int AS active_devices
       FROM organisations o LEFT JOIN usage_daily u ON u.org_id = o.id AND u.day >= $1::date AND u.day < $1::date + interval '1 month'
       GROUP BY o.id ORDER BY messages DESC`, [`${month}-01`])).rows } };
  });
  r.get('/admin/api/demo-requests', async (req) => {
    await session(req);
    return { body: { requests: (await q(`SELECT * FROM demo_requests ORDER BY created_at DESC LIMIT 200`)).rows } };
  });

  // ---------- Users (admin only) ----------
  r.get('/admin/api/users', async (req) => {
    await session(req, 'admin');
    return { body: { users: (await q(`SELECT id, email, name, role, last_login_at, disabled_at, created_at FROM users WHERE role IN ('admin','ops') ORDER BY created_at`)).rows } };
  });
  r.post('/admin/api/users', async (req) => {
    const s = await session(req, 'admin');
    const role = req.body?.role === 'admin' ? 'admin' : 'ops';
    const email = str(req.body?.email, 'email').toLowerCase();
    const password = randomToken(12);
    const kitovu = (await q(`SELECT id FROM organisations WHERE kind = 'kitovu' LIMIT 1`)).rows[0];
    const row = (await q(`INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [kitovu.id, email, optStr(req.body?.name), role, await hashPassword(password)])).rows[0];
    await audit(s, 'user.created', row.id, { email, role });
    return { status: 201, body: { id: row.id, email, role, temporaryPassword: password } };
  });
  r.post('/admin/api/password', async (req) => {
    const s = await session(req);
    const u = (await q(`SELECT password_hash FROM users WHERE id = $1`, [s.userId])).rows[0];
    if (!(await verifyPassword(str(req.body?.current, 'current', 500), u.password_hash))) throw new HttpError(400, 'wrong_password', 'Current password is incorrect');
    const next = str(req.body?.next, 'next', 500);
    if (next.length < 10) throw new HttpError(400, 'weak_password', 'Use at least 10 characters');
    await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [s.userId, await hashPassword(next)]);
    await q(`DELETE FROM sessions WHERE user_id = $1`, [s.userId]);
    await audit(s, 'user.password_changed', s.userId);
    return { body: { ok: true }, headers: { 'Set-Cookie': clearCookie(d.secureCookies) } };
  });
}

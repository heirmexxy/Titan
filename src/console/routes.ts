/**
 * Client console API (/console/api/*) for organisations that own devices or receive shared data.
 * Owners manage everything for their organisation; members can view and acknowledge alerts.
 * Everything is scoped to the signed-in user's organisation.
 */
import { resolveAccess } from '../core/access.js';
import { randomToken, sha256Hex } from '../core/crypto.js';
import { CONSOLE_COOKIE, clearCookie, hashPassword, parseCookies, SESSION_DAYS, sessionCookie, verifyPassword } from '../admin/auth.js';
import { CommandError } from '../actuators/catalogue.js';
import type { ActuatorService } from '../actuators/service.js';
import type { Billing } from '../billing/billing.js';
import { CarbonError, type CarbonService } from '../carbon/service.js';
import { HttpError, type Req, type Router } from '../http/router.js';
import type { DeviceService } from '../ingest/devices.js';
import type { Store } from '../store/types.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export interface ConsoleDeps {
  pool: Pool;
  store: Store;
  devices: DeviceService;
  actuators?: ActuatorService;
  carbon?: CarbonService;
  billing: Billing | null;
  publicUrl: string;
  secureCookies: boolean;
}

interface Who { userId: string; email: string; name: string | null; role: 'client_owner' | 'client_member'; orgId: string; orgName: string; devicePrefix: string | null }

const SCOPES = ['read:readings', 'read:alerts', 'manage:webhooks', 'manage:grants', 'control:devices', 'read:carbon', 'write:carbon'];
const SITE_KINDS = ['warehouse', 'aquaponics', 'hydroponics', 'greenhouse', 'cold_room', 'poultry', 'field', 'energy', 'other'];
const CLIENT_DEVICE_TYPES = ['titan-controller-v1', 'paygo-appliance-v1', 'titan-kiln-v1', 'titan-cookstove-v1', 'titan-solar-v1', 'wareguard-v1'];

const str = (v: unknown, name: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'invalid_request', `${name} is required`);
  return v.trim().slice(0, max);
};
const optStr = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function registerConsole(r: Router, d: ConsoleDeps) {
  const q = (t: string, v: unknown[] = []) => d.pool.query(t, v);
  const audit = (w: Who, action: string, target: string | null, detail?: unknown) =>
    q(`INSERT INTO audit_log (actor, org_id, action, target, detail) VALUES ($1,$2,$3,$4,$5)`, [`user:${w.userId}`, w.orgId, action, target, detail === undefined ? null : JSON.stringify(detail)]);

  const who = async (req: Req, owner = false): Promise<Who> => {
    const token = parseCookies(req.headers.cookie)[CONSOLE_COOKIE];
    if (!token) throw new HttpError(401, 'unauthorized');
    const row = (await q(
      `SELECT u.id, u.email, u.name, u.role, o.id AS org_id, o.name AS org_name, o.device_prefix FROM sessions s
       JOIN users u ON u.id = s.user_id JOIN organisations o ON o.id = u.org_id
       WHERE s.id = $1 AND s.expires_at > now() AND u.disabled_at IS NULL AND u.role IN ('client_owner','client_member')`, [sha256Hex(token)])).rows[0];
    if (!row) throw new HttpError(401, 'unauthorized');
    if (req.method !== 'GET' && req.headers['x-titan-console'] !== '1') throw new HttpError(403, 'forbidden', 'Missing X-Titan-Console header');
    if (owner && row.role !== 'client_owner') throw new HttpError(403, 'forbidden', 'Only account owners can do this');
    return { userId: row.id, email: row.email, name: row.name, role: row.role, orgId: row.org_id, orgName: row.org_name, devicePrefix: row.device_prefix };
  };
  const ownSite = async (w: Who, siteId: string) => {
    const s = (await q(`SELECT * FROM sites WHERE id = $1 AND org_id = $2`, [siteId, w.orgId])).rows[0];
    if (!s) throw new HttpError(404, 'not_found');
    return s;
  };
  const ownDevice = async (w: Who, id: string) => {
    const dv = (await q(`SELECT * FROM devices WHERE id = $1 AND org_id = $2`, [id, w.orgId])).rows[0];
    if (!dv) throw new HttpError(404, 'not_found');
    return dv;
  };

  // ---------- Auth ----------
  const attempts = new Map<string, { n: number; reset: number }>();
  r.post('/console/api/login', async (req) => {
    const email = str(req.body?.email, 'email').toLowerCase();
    const key = `${req.ip}|${email}`;
    const a = attempts.get(key);
    if (a && a.reset > Date.now() && a.n >= 8) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.');
    const u = (await q(`SELECT id, password_hash, role, disabled_at FROM users WHERE lower(email) = $1`, [email])).rows[0];
    const ok = !!u && !u.disabled_at && ['client_owner', 'client_member'].includes(u.role) && (await verifyPassword(str(req.body?.password, 'password', 500), u.password_hash));
    if (!ok) {
      attempts.set(key, { n: (a && a.reset > Date.now() ? a.n : 0) + 1, reset: Date.now() + 15 * 60_000 });
      throw new HttpError(401, 'invalid_login', 'Email or password is incorrect');
    }
    attempts.delete(key);
    const token = randomToken(32);
    await q(`INSERT INTO sessions (id, user_id, expires_at, ip) VALUES ($1,$2, now() + make_interval(days => $3), $4)`, [sha256Hex(token), u.id, SESSION_DAYS, req.ip]);
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
    return { body: { ok: true }, headers: { 'Set-Cookie': sessionCookie(token, d.secureCookies, CONSOLE_COOKIE) } };
  });
  r.post('/console/api/logout', async (req) => {
    const token = parseCookies(req.headers.cookie)[CONSOLE_COOKIE];
    if (token) await q(`DELETE FROM sessions WHERE id = $1`, [sha256Hex(token)]);
    return { body: { ok: true }, headers: { 'Set-Cookie': clearCookie(d.secureCookies, CONSOLE_COOKIE) } };
  });
  r.get('/console/api/me', async (req) => ({ body: await who(req) }));

  // ---------- Overview ----------
  r.get('/console/api/overview', async (req) => {
    const w = await who(req);
    const c = (await q(`SELECT
      (SELECT count(*) FROM sites WHERE org_id = $1)::int AS sites,
      (SELECT count(*) FROM devices WHERE org_id = $1 AND status = 'online')::int AS online,
      (SELECT count(*) FROM devices WHERE org_id = $1 AND status = 'offline')::int AS offline,
      (SELECT count(*) FROM devices WHERE org_id = $1 AND status = 'registered')::int AS awaiting,
      (SELECT count(*) FROM alerts WHERE org_id = $1 AND status <> 'resolved')::int AS open_alerts,
      (SELECT count(*) FROM data_grants WHERE grantee_org_id = $1 AND revoked_at IS NULL)::int AS shared_with_us,
      (SELECT coalesce(sum(messages),0) FROM usage_daily WHERE org_id = $1 AND day >= date_trunc('month', now()))::bigint AS messages_month`, [w.orgId])).rows[0];
    const alerts = (await q(`SELECT a.*, s.name AS site_name FROM alerts a LEFT JOIN sites s ON s.id = a.site_id WHERE a.org_id = $1 AND a.status <> 'resolved' ORDER BY a.opened_at DESC LIMIT 20`, [w.orgId])).rows;
    const sites = (await q(
      `SELECT s.id, s.name, s.kind, count(dv.id)::int AS devices, count(dv.id) FILTER (WHERE dv.status = 'online')::int AS online
       FROM sites s LEFT JOIN devices dv ON dv.site_id = s.id WHERE s.org_id = $1 GROUP BY s.id ORDER BY s.name`, [w.orgId])).rows;
    return { body: { counts: c, alerts, sites } };
  });

  // ---------- Sites ----------
  r.get('/console/api/sites', async (req) => {
    const w = await who(req);
    const own = (await q(`SELECT s.*, (SELECT count(*) FROM devices dv WHERE dv.site_id = s.id)::int AS devices FROM sites s WHERE s.org_id = $1 ORDER BY s.name`, [w.orgId])).rows;
    const access = await resolveAccess(d.store, w.orgId);
    const sharedIds = [...access.entries()].filter(([, a]) => !a.owned).map(([id]) => id);
    const shared = sharedIds.length ? (await q(`SELECT s.id, s.name, s.kind, o.name AS owner_name FROM sites s JOIN organisations o ON o.id = s.org_id WHERE s.id = ANY($1::uuid[]) ORDER BY s.name`, [sharedIds])).rows : [];
    return { body: { sites: own, shared } };
  });
  r.post('/console/api/sites', async (req) => {
    const w = await who(req, true);
    const kind = req.body?.kind ?? 'other';
    if (!SITE_KINDS.includes(kind)) throw new HttpError(400, 'invalid_kind');
    const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
    const lat = num(req.body?.lat), lng = num(req.body?.lng);
    if ((lat !== null && !(lat >= -90 && lat <= 90)) || (lng !== null && !(lng >= -180 && lng <= 180))) throw new HttpError(400, 'invalid_location');
    const row = (await q(`INSERT INTO sites (org_id, name, kind, external_ref, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [w.orgId, str(req.body?.name, 'name'), kind, optStr(req.body?.externalRef), optStr(req.body?.address, 300), lat, lng])).rows[0];
    await audit(w, 'site.created', row.id);
    return { status: 201, body: { site: row } };
  });
  r.get('/console/api/sites/:id', async (req) => {
    const w = await who(req);
    const access = await resolveAccess(d.store, w.orgId);
    const a = access.get(req.params.id);
    if (!a) throw new HttpError(404, 'not_found');
    const site = (await q(`SELECT s.*, o.name AS owner_name FROM sites s JOIN organisations o ON o.id = s.org_id WHERE s.id = $1`, [req.params.id])).rows[0];
    const zones = a.owned ? (await q(`SELECT * FROM zones WHERE site_id = $1 ORDER BY code`, [site.id])).rows : [];
    const stacks = a.owned ? (await q(`SELECT st.*, z.code AS zone_code FROM stacks st JOIN zones z ON z.id = st.zone_id WHERE z.site_id = $1 ORDER BY z.code, st.code`, [site.id])).rows : [];
    const devices = (await q(`SELECT id, type_id, connectivity, status, last_seen_at, config_version, config_acked_version FROM devices WHERE site_id = $1 ORDER BY id`, [site.id])).rows;
    const latest = (await d.store.latestReadings([site.id])).filter((x) => (!a.metrics || a.metrics.has(x.metric)) && (!a.to || x.time <= a.to) && (!a.from || x.time >= a.from));
    return { body: { site, access: { owned: a.owned, metrics: a.metrics ? [...a.metrics] : 'all', from: a.from, to: a.to }, zones, stacks, devices, latest } };
  });
  r.post('/console/api/sites/:id/zones', async (req) => {
    const w = await who(req, true);
    await ownSite(w, req.params.id);
    const code = str(req.body?.code, 'code', 40);
    if (!/^[a-z0-9-]+$/.test(code)) throw new HttpError(400, 'invalid_code', 'Zone code: lowercase letters, digits and hyphens');
    const row = (await q(`INSERT INTO zones (site_id, code, name) VALUES ($1,$2,$3) RETURNING *`, [req.params.id, code, optStr(req.body?.name)])).rows[0];
    return { status: 201, body: { zone: row } };
  });
  r.post('/console/api/sites/:id/stacks', async (req) => {
    const w = await who(req, true);
    await ownSite(w, req.params.id);
    const code = str(req.body?.code, 'code', 40);
    if (!/^[a-z0-9-]+$/.test(code)) throw new HttpError(400, 'invalid_code', 'Stack code: lowercase letters, digits and hyphens');
    const row = (await q(`INSERT INTO stacks (zone_id, code, commodity, external_ref) SELECT id, $3, $4, $5 FROM zones WHERE site_id = $1 AND code = $2 RETURNING *`,
      [req.params.id, str(req.body?.zone, 'zone'), code, optStr(req.body?.commodity), optStr(req.body?.externalRef)])).rows[0];
    if (!row) throw new HttpError(400, 'zone_not_found');
    return { status: 201, body: { stack: row } };
  });

  // ---------- Devices ----------
  r.get('/console/api/devices', async (req) => {
    const w = await who(req);
    const devices = (await q(
      `SELECT dv.id, dv.type_id, dv.connectivity, dv.status, dv.last_seen_at, dv.config_version, dv.config_acked_version, s.name AS site_name, s.id AS site_id
       FROM devices dv LEFT JOIN sites s ON s.id = dv.site_id WHERE dv.org_id = $1 ORDER BY dv.id`, [w.orgId])).rows;
    const types = (await q(`SELECT id, name FROM device_types WHERE id = ANY($1::text[]) ORDER BY name`, [CLIENT_DEVICE_TYPES])).rows;
    return { body: { devices, types, devicePrefix: w.devicePrefix } };
  });
  r.post('/console/api/devices', async (req) => {
    const w = await who(req, true);
    if (!w.devicePrefix) throw new HttpError(409, 'no_prefix', 'Your organisation has no device ID prefix yet. Ask Kitovu to assign one.');
    const id = str(req.body?.id, 'id', 64).toUpperCase();
    if (!new RegExp(`^${w.devicePrefix}-\\d{6,}$`).test(id)) throw new HttpError(400, 'invalid_id', `Device IDs for your organisation look like ${w.devicePrefix}-000001`);
    const typeId = req.body?.typeId ?? 'titan-controller-v1';
    if (!CLIENT_DEVICE_TYPES.includes(typeId)) throw new HttpError(400, 'invalid_type');
    await ownSite(w, str(req.body?.siteId, 'siteId'));
    if ((await q(`SELECT 1 FROM devices WHERE id = $1`, [id])).rows.length) throw new HttpError(409, 'exists', `${id} is already registered`);
    await q(`INSERT INTO devices (id, org_id, site_id, type_id, connectivity, name) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, w.orgId, req.body.siteId, typeId, req.body?.connectivity === 'gsm' ? 'gsm' : 'wifi', optStr(req.body?.name)]);
    const code = await d.devices.issueProvisionCode(id);
    await audit(w, 'device.registered', id);
    return { status: 201, body: { id, provisioningCode: code, expiresInDays: 7 } };
  });
  r.get('/console/api/devices/:id', async (req) => {
    const w = await who(req);
    const dv = await ownDevice(w, req.params.id);
    delete dv.token_hash; delete dv.provision_code_hash;
    const latest = (await q(`SELECT DISTINCT ON (channel, metric) time, channel, metric, value, quality, flags FROM readings WHERE device_id = $1 AND time > now() - interval '2 days' ORDER BY channel, metric, time DESC`, [dv.id])).rows;
    const events = (await q(`SELECT * FROM events WHERE device_id = $1 ORDER BY time DESC LIMIT 30`, [dv.id])).rows;
    const commands = d.actuators ? { available: (await d.actuators.catalogue(dv.id)).filter((c) => (c.allow ?? []).includes('api')), history: await d.actuators.history(dv.id, 20) } : { available: [], history: [] };
    return { body: { device: dv, latest, events, commands } };
  });
  r.get('/console/api/devices/:id/series', async (req) => {
    const w = await who(req);
    await ownDevice(w, req.params.id);
    const hours = Math.min(Math.max(Number(req.query.get('hours') ?? 24) || 24, 1), 24 * 90);
    const bucket = hours <= 6 ? '1 minute' : hours <= 24 * 7 ? '15 minutes' : '1 hour';
    const rows = (await q(
      `SELECT date_bin(interval '${bucket}', time, timestamptz '2000-01-01') AS t, channel, avg(value) AS avg, min(value) AS min, max(value) AS max
       FROM readings WHERE device_id = $1 AND metric = $2 AND time > now() - make_interval(hours => $3) AND quality <> 'rejected' GROUP BY 1, 2 ORDER BY 1`,
      [req.params.id, str(req.query.get('metric'), 'metric', 60), hours])).rows;
    return { body: { bucket, points: rows.map((x) => ({ t: x.t, channel: x.channel, avg: Number(x.avg), min: Number(x.min), max: Number(x.max) })) } };
  });
  r.post('/console/api/devices/:id/command', async (req) => {
    const w = await who(req, true);
    await ownDevice(w, req.params.id);
    if (!d.actuators) throw new HttpError(503, 'unavailable');
    try {
      const out = await d.actuators.send(req.params.id, str(req.body?.cmd, 'cmd', 60), req.body?.args ?? {}, { source: 'api', actor: `user:${w.userId}`, orgId: w.orgId });
      await audit(w, 'device.command', req.params.id, out);
      return { body: { commandId: out.id } };
    } catch (e) {
      if (e instanceof CommandError) throw new HttpError(e.code === 'not_allowed' ? 403 : 400, e.code, e.message);
      throw e;
    }
  });
  r.post('/console/api/devices/:id/code', async (req) => {
    const w = await who(req, true);
    await ownDevice(w, req.params.id);
    return { body: { provisioningCode: await d.devices.issueProvisionCode(req.params.id), expiresInDays: 7 } };
  });

  // ---------- Alerts, rules, contacts ----------
  r.get('/console/api/alerts', async (req) => {
    const w = await who(req);
    const status = req.query.get('status');
    return { body: { alerts: (await q(
      `SELECT a.*, s.name AS site_name FROM alerts a LEFT JOIN sites s ON s.id = a.site_id
       WHERE a.org_id = $1 AND (($2::text IS NULL AND a.status <> 'resolved') OR a.status = $2) ORDER BY a.opened_at DESC LIMIT 300`, [w.orgId, status])).rows } };
  });
  r.post('/console/api/alerts/:id/ack', async (req) => {
    const w = await who(req);
    const u = await q(`UPDATE alerts SET status = 'acknowledged', acked_at = now(), acked_by = $3 WHERE id = $1 AND org_id = $2 AND status = 'open'`, [req.params.id, w.orgId, w.userId]);
    if (!u.rowCount) throw new HttpError(409, 'not_open');
    return { body: { ok: true } };
  });
  r.post('/console/api/alerts/:id/resolve', async (req) => {
    const w = await who(req);
    const u = await q(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1 AND org_id = $2 AND status <> 'resolved'`, [req.params.id, w.orgId]);
    if (!u.rowCount) throw new HttpError(409, 'already_resolved');
    await q(`UPDATE rule_state SET alert_id = NULL, breach_since = NULL WHERE alert_id = $1`, [req.params.id]);
    return { body: { ok: true } };
  });
  r.get('/console/api/rules', async (req) => {
    const w = await who(req);
    const rules = (await q(`SELECT r.*, s.name AS site_name FROM alert_rules r LEFT JOIN sites s ON s.id = r.site_id WHERE r.org_id = $1 ORDER BY r.metric`, [w.orgId])).rows;
    const contacts = (await q(`SELECT c.*, s.name AS site_name FROM notification_contacts c LEFT JOIN sites s ON s.id = c.site_id WHERE c.org_id = $1`, [w.orgId])).rows;
    const metrics = (await q(`SELECT key, label, unit FROM metrics WHERE NOT derived ORDER BY key`)).rows;
    return { body: { rules, contacts, metrics } };
  });
  r.post('/console/api/rules', async (req) => {
    const w = await who(req, true);
    const b = req.body ?? {};
    if (!['gt', 'lt'].includes(b.op)) throw new HttpError(400, 'invalid_op');
    if (!['info', 'warning', 'critical'].includes(b.severity ?? 'warning')) throw new HttpError(400, 'invalid_severity');
    const threshold = Number(b.threshold);
    if (!Number.isFinite(threshold)) throw new HttpError(400, 'invalid_threshold');
    if (b.siteId) await ownSite(w, b.siteId);
    const row = (await q(
      `INSERT INTO alert_rules (org_id, site_id, channel, metric, op, threshold, duration_s, hysteresis, severity, name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [w.orgId, optStr(b.siteId), optStr(b.channel), str(b.metric, 'metric'), b.op, threshold, Math.max(0, Number(b.durationS) || 0), Math.max(0, Number(b.hysteresis) || 0), b.severity ?? 'warning', optStr(b.name)])).rows[0];
    await audit(w, 'rule.created', row.id, b);
    return { status: 201, body: { rule: row } };
  });
  r.post('/console/api/rules/:id/toggle', async (req) => {
    const w = await who(req, true);
    const row = (await q(`UPDATE alert_rules SET enabled = NOT enabled WHERE id = $1 AND org_id = $2 RETURNING enabled`, [req.params.id, w.orgId])).rows[0];
    if (!row) throw new HttpError(404, 'not_found');
    return { body: row };
  });
  r.post('/console/api/contacts', async (req) => {
    const w = await who(req, true);
    const b = req.body ?? {};
    if (!['email', 'sms'].includes(b.channel)) throw new HttpError(400, 'invalid_channel');
    const address = str(b.address, 'address');
    if (b.channel === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new HttpError(400, 'invalid_email');
    if (b.channel === 'sms' && !/^\+?\d{10,15}$/.test(address)) throw new HttpError(400, 'invalid_phone', 'Phone in international format, e.g. 2348012345678');
    if (b.siteId) await ownSite(w, b.siteId);
    const row = (await q(`INSERT INTO notification_contacts (org_id, site_id, channel, address, min_severity) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [w.orgId, optStr(b.siteId), b.channel, address, ['info', 'warning', 'critical'].includes(b.minSeverity) ? b.minSeverity : 'warning'])).rows[0];
    return { status: 201, body: { contact: row } };
  });
  r.delete('/console/api/contacts/:id', async (req) => {
    const w = await who(req, true);
    await q(`DELETE FROM notification_contacts WHERE id = $1 AND org_id = $2`, [req.params.id, w.orgId]);
    return { status: 204 };
  });

  // ---------- API keys and webhooks ----------
  r.get('/console/api/keys', async (req) => {
    const w = await who(req);
    const keys = (await q(`SELECT id, name, prefix, scopes, last_used_at, revoked_at, created_at FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`, [w.orgId])).rows;
    const webhooks = (await d.store.listOrgWebhooks(w.orgId)).map(({ secret: _s, ...x }) => x);
    return { body: { keys, webhooks, scopes: SCOPES } };
  });
  r.post('/console/api/keys', async (req) => {
    const w = await who(req, true);
    const scopes: string[] = Array.isArray(req.body?.scopes) && req.body.scopes.length ? req.body.scopes : ['read:readings', 'read:alerts'];
    if (scopes.some((x) => !SCOPES.includes(x))) throw new HttpError(400, 'invalid_scopes');
    const key = `tk_live_${randomToken(24)}`;
    const row = (await q(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [w.orgId, str(req.body?.name, 'name'), key.slice(0, 12), sha256Hex(key), scopes])).rows[0];
    await audit(w, 'apikey.created', row.id, { scopes });
    return { status: 201, body: { id: row.id, key, scopes } };
  });
  r.post('/console/api/keys/:id/revoke', async (req) => {
    const w = await who(req, true);
    await q(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`, [req.params.id, w.orgId]);
    await audit(w, 'apikey.revoked', req.params.id);
    return { body: { ok: true } };
  });
  r.post('/console/api/webhooks', async (req) => {
    const w = await who(req, true);
    const { url, events } = req.body ?? {};
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new HttpError(400, 'invalid_url', 'Webhook URL must start with https://');
    const allowed = ['alert.opened', 'alert.resolved', 'alert.*', 'device.online', 'device.offline', 'device.*', 'reading.created', 'event.created'];
    if (!Array.isArray(events) || !events.length || events.some((e: string) => !allowed.includes(e))) throw new HttpError(400, 'invalid_events');
    const hook = await d.store.createWebhook(w.orgId, url, events, `whsec_${randomToken(24)}`);
    await audit(w, 'webhook.created', hook.id, { url, events });
    return { status: 201, body: { webhook: hook } };
  });
  r.delete('/console/api/webhooks/:id', async (req) => {
    const w = await who(req, true);
    if (!(await d.store.deleteWebhook(req.params.id, w.orgId))) throw new HttpError(404, 'not_found');
    return { status: 204 };
  });

  // ---------- Sharing ----------
  r.get('/console/api/grants', async (req) => {
    const w = await who(req);
    const given = (await q(`SELECT g.*, o.name AS grantee_name FROM data_grants g JOIN organisations o ON o.id = g.grantee_org_id WHERE g.owner_org_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`, [w.orgId])).rows;
    const received = (await q(`SELECT g.*, o.name AS owner_name FROM data_grants g JOIN organisations o ON o.id = g.owner_org_id WHERE g.grantee_org_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`, [w.orgId])).rows;
    const sites = (await q(`SELECT id, name FROM sites WHERE org_id = $1 ORDER BY name`, [w.orgId])).rows;
    return { body: { given, received, sites, orgId: w.orgId } };
  });
  r.post('/console/api/grants', async (req) => {
    const w = await who(req, true);
    const b = req.body ?? {};
    const grantee = (await q(`SELECT id, name FROM organisations WHERE id::text = $1`, [str(b.granteeOrgId, 'granteeOrgId', 60)])).rows[0];
    if (!grantee) throw new HttpError(400, 'unknown_org', 'No organisation has that ID. Ask them for the Organisation ID shown in their Titan settings.');
    if (grantee.id === w.orgId) throw new HttpError(400, 'self', 'You already have access to your own sites');
    const siteIds: string[] | null = Array.isArray(b.siteIds) && b.siteIds.length ? b.siteIds : null;
    if (siteIds) for (const s of siteIds) await ownSite(w, s);
    const metrics: string[] | null = Array.isArray(b.metrics) && b.metrics.length ? b.metrics : null;
    const date = (v: unknown) => { if (!v) return null; const t = new Date(String(v)); if (Number.isNaN(t.getTime())) throw new HttpError(400, 'invalid_date'); return t; };
    const g = await d.store.createGrant({ ownerOrgId: w.orgId, granteeOrgId: grantee.id, siteIds, metrics, validFrom: date(b.validFrom), validTo: date(b.validTo), live: b.live !== false });
    await audit(w, 'grant.created', g.id, { grantee: grantee.name, siteIds, metrics });
    return { status: 201, body: { grant: g, granteeName: grantee.name } };
  });
  r.delete('/console/api/grants/:id', async (req) => {
    const w = await who(req, true);
    if (!(await d.store.revokeGrant(req.params.id, w.orgId))) throw new HttpError(404, 'not_found');
    await audit(w, 'grant.revoked', req.params.id);
    return { status: 204 };
  });

  // ---------- Carbon (read-only here) ----------
  r.get('/console/api/carbon', async (req) => {
    const w = await who(req);
    if (!d.carbon) return { body: { projects: [] } };
    const access = await resolveAccess(d.store, w.orgId);
    const projects = await d.carbon.listProjects(w.orgId, [...access.keys()]);
    return { body: { projects: await Promise.all(projects.map(async (p: any) => ({ ...p, owned: p.org_id === w.orgId, summary: await d.carbon!.summary(p.id) }))) } };
  });
  r.get('/console/api/carbon/:id', async (req) => {
    const w = await who(req);
    if (!d.carbon) throw new HttpError(404, 'not_found');
    try {
      const p = await d.carbon.getProject(req.params.id);
      if (p.org_id !== w.orgId) {
        const access = await resolveAccess(d.store, w.orgId);
        if (!(p.site_ids ?? []).some((s: string) => access.has(s))) throw new HttpError(404, 'not_found');
      }
      const activities = await d.carbon.listActivities(p.id);
      return { body: { project: p, summary: await d.carbon.summary(p.id), activities } };
    } catch (e) { if (e instanceof CarbonError) throw new HttpError(e.status, e.code, e.message); throw e; }
  });

  // ---------- Billing ----------
  r.get('/console/api/billing', async (req) => {
    const w = await who(req);
    const plan = (await q(`SELECT p.* FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.org_id = $1`, [w.orgId])).rows[0] ?? null;
    const invoices = (await q(`SELECT id, period, currency, lines, amount, status, paid_at, created_at FROM invoices WHERE org_id = $1 ORDER BY period DESC LIMIT 24`, [w.orgId])).rows;
    const usage = (await q(
      `SELECT coalesce(sum(messages),0)::bigint AS messages, coalesce(sum(readings),0)::bigint AS readings, coalesce(sum(api_calls),0)::bigint AS api_calls,
         (SELECT count(DISTINCT device_id) FROM usage_devices_daily WHERE org_id = $1 AND day >= date_trunc('month', now()))::int AS active_devices
       FROM usage_daily WHERE org_id = $1 AND day >= date_trunc('month', now())`, [w.orgId])).rows[0];
    return { body: { plan, invoices, usage, payments: !!d.billing } };
  });
  r.post('/console/api/invoices/:id/pay', async (req) => {
    const w = await who(req, true);
    if (!d.billing) throw new HttpError(503, 'payments_unavailable', 'Online payment is not set up yet. Contact titan@kitovu.com.ng.');
    const inv = (await q(`SELECT id FROM invoices WHERE id = $1 AND org_id = $2 AND status = 'open'`, [req.params.id, w.orgId])).rows[0];
    if (!inv) throw new HttpError(404, 'not_found');
    const url = await d.billing.startPayment(inv.id, w.email, `${d.publicUrl}/api/paystack/callback`);
    return { body: { url } };
  });

  // ---------- Team and settings ----------
  r.get('/console/api/team', async (req) => {
    const w = await who(req);
    const users = (await q(`SELECT id, email, name, role, last_login_at FROM users WHERE org_id = $1 AND disabled_at IS NULL ORDER BY created_at`, [w.orgId])).rows;
    return { body: { users, orgId: w.orgId, orgName: w.orgName, devicePrefix: w.devicePrefix } };
  });
  r.post('/console/api/team', async (req) => {
    const w = await who(req, true);
    const email = str(req.body?.email, 'email').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid_email');
    if ((await q(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])).rows.length) throw new HttpError(409, 'exists', 'That email already has a Titan account');
    const role = req.body?.role === 'client_owner' ? 'client_owner' : 'client_member';
    const password = randomToken(12);
    await q(`INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5)`, [w.orgId, email, optStr(req.body?.name), role, await hashPassword(password)]);
    await audit(w, 'user.created', email, { role });
    return { status: 201, body: { email, role, temporaryPassword: password } };
  });
  r.post('/console/api/password', async (req) => {
    const w = await who(req);
    const u = (await q(`SELECT password_hash FROM users WHERE id = $1`, [w.userId])).rows[0];
    if (!(await verifyPassword(str(req.body?.current, 'current', 500), u.password_hash))) throw new HttpError(400, 'wrong_password', 'Current password is incorrect');
    const next = str(req.body?.next, 'next', 500);
    if (next.length < 10) throw new HttpError(400, 'weak_password', 'Use at least 10 characters');
    await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [w.userId, await hashPassword(next)]);
    await q(`DELETE FROM sessions WHERE user_id = $1`, [w.userId]);
    return { body: { ok: true }, headers: { 'Set-Cookie': clearCookie(d.secureCookies, CONSOLE_COOKIE) } };
  });

}

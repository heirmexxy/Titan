/**
 * API for the installable field app (/app). One sign-in for Kitovu staff and client users: staff get an admin
 * session (all organisations), clients get a console session (their organisation). Quality, lots and exports use
 * the shared /admin/api or /console/api routes; this module adds sign-in, sites, live device status, alerts and
 * device installation, shaped for a phone.
 */
import { CONSOLE_COOKIE, clearCookie, parseCookies, SESSION_COOKIE, SESSION_DAYS, sessionCookie, verifyPassword } from '../admin/auth.js';
import { randomToken, sha256Hex } from '../core/crypto.js';
import { optStr, str } from '../http/actors.js';
import { HttpError, type Req, type Router } from '../http/router.js';
import type { DeviceService } from '../ingest/devices.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

interface Deps {
  pool: Pool;
  devices: DeviceService;
  secureCookies: boolean;
  adminSession: (req: Req) => Promise<{ userId: string; email: string; role: string; name?: string | null }>;
  consoleWho: (req: Req, owner?: boolean) => Promise<{ userId: string; email: string; orgId: string; role: string; name?: string | null; orgName?: string; devicePrefix?: string | null }>;
}

interface Who { mode: 'kitovu' | 'client'; orgId: string | null; userId: string; email: string; name: string | null; role: string; orgName: string; prefix: string | null }

const DEVICE_TYPES = ['wareguard-v1', 'gradeguard-v1', 'titan-controller-v1', 'paygo-appliance-v1', 'titan-kiln-v1', 'titan-cookstove-v1', 'titan-solar-v1', 'titan-lora-gateway-v1'];

export function registerFieldApp(r: Router, d: Deps) {
  const q = (t: string, v: unknown[] = []) => d.pool.query(t, v);

  const who = async (req: Req): Promise<Who> => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE]) {
      try {
        const s = await d.adminSession(req);
        return { mode: 'kitovu', orgId: null, userId: s.userId, email: s.email, name: s.name ?? null, role: s.role, orgName: 'Kitovu', prefix: null };
      } catch { /* fall through to a console session */ }
    }
    const w = await d.consoleWho(req);
    return { mode: 'client', orgId: w.orgId, userId: w.userId, email: w.email, name: w.name ?? null, role: w.role, orgName: w.orgName ?? '', prefix: w.devicePrefix ?? null };
  };

  const attempts = new Map<string, { n: number; reset: number }>();
  r.post('/app/api/login', async (req) => {
    const email = str(req.body?.email, 'email', 254).toLowerCase();
    const key = `${req.ip}|${email}`;
    const a = attempts.get(key);
    if (a && a.reset > Date.now() && a.n >= 8) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.');
    const u = (await q(`SELECT id, password_hash, role, disabled_at, email_verified_at FROM users WHERE lower(email) = $1`, [email])).rows[0];
    const ok = !!u && !u.disabled_at && ['admin', 'ops', 'client_owner', 'client_member'].includes(u.role) && (await verifyPassword(str(req.body?.password, 'password', 500), u.password_hash));
    if (!ok) {
      attempts.set(key, { n: (a && a.reset > Date.now() ? a.n : 0) + 1, reset: Date.now() + 15 * 60_000 });
      throw new HttpError(401, 'invalid_login', 'Email or password is incorrect');
    }
    attempts.delete(key);
    if (!u.email_verified_at) throw new HttpError(403, 'email_not_verified', 'Confirm your email first: open the link we sent you.');
    const token = randomToken(32);
    // The app stays signed in for 30 days: field staff work offline for long stretches.
    await q(`INSERT INTO sessions (id, user_id, expires_at, ip) VALUES ($1,$2, now() + make_interval(days => $3), $4)`, [sha256Hex(token), u.id, Math.max(SESSION_DAYS, 30), req.ip]);
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
    const staff = ['admin', 'ops'].includes(u.role);
    const cookie = sessionCookie(token, d.secureCookies, staff ? SESSION_COOKIE : CONSOLE_COOKIE).replace(`Max-Age=${SESSION_DAYS * 86400}`, `Max-Age=${30 * 86400}`);
    return { body: { ok: true, mode: staff ? 'kitovu' : 'client' }, headers: { 'Set-Cookie': cookie } };
  });

  r.post('/app/api/logout', async (req) => {
    const c = parseCookies(req.headers.cookie);
    for (const t of [c[SESSION_COOKIE], c[CONSOLE_COOKIE]].filter(Boolean)) await q(`DELETE FROM sessions WHERE id = $1`, [sha256Hex(t!)]);
    // Node sends an array as separate Set-Cookie headers.
    return { body: { ok: true }, headers: { 'Set-Cookie': [clearCookie(d.secureCookies, SESSION_COOKIE), clearCookie(d.secureCookies, CONSOLE_COOKIE)] as unknown as string } };
  });

  r.get('/app/api/me', async (req) => {
    const w = await who(req);
    return { body: { mode: w.mode, email: w.email, name: w.name, role: w.role, organisation: w.orgName, devicePrefix: w.prefix, api: w.mode === 'kitovu' ? '/admin/api' : '/console/api' } };
  });

  r.get('/app/api/home', async (req) => {
    const w = await who(req);
    const counts = (await q(`SELECT
      (SELECT count(*) FROM devices WHERE ($1::uuid IS NULL OR org_id = $1) AND status = 'online')::int AS online,
      (SELECT count(*) FROM devices WHERE ($1::uuid IS NULL OR org_id = $1) AND status = 'offline')::int AS offline,
      (SELECT count(*) FROM alerts WHERE ($1::uuid IS NULL OR org_id = $1) AND status = 'open')::int AS open_alerts,
      (SELECT count(*) FROM quality_tests WHERE ($1::uuid IS NULL OR org_id = $1) AND tested_at > now() - interval '7 days')::int AS tests_week`, [w.orgId])).rows[0];
    const sites = (await q(
      `SELECT s.id, s.name, s.kind, o.name AS org_name, count(dv.id)::int AS devices, count(dv.id) FILTER (WHERE dv.status = 'online')::int AS online,
         (SELECT count(*) FROM alerts a WHERE a.site_id = s.id AND a.status = 'open')::int AS open_alerts
       FROM sites s JOIN organisations o ON o.id = s.org_id LEFT JOIN devices dv ON dv.site_id = s.id
       WHERE ($1::uuid IS NULL OR s.org_id = $1) GROUP BY s.id, o.name ORDER BY open_alerts DESC, s.name LIMIT 300`, [w.orgId])).rows;
    return { body: { counts, sites } };
  });

  const siteFor = async (w: Who, id: string) => {
    const s = (await q(`SELECT s.*, o.name AS org_name, o.device_prefix FROM sites s JOIN organisations o ON o.id = s.org_id WHERE s.id = $1 AND ($2::uuid IS NULL OR s.org_id = $2)`, [id, w.orgId])).rows[0];
    if (!s) throw new HttpError(404, 'not_found');
    return s;
  };

  r.get('/app/api/sites/:id', async (req) => {
    const w = await who(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'not_found');
    const site = await siteFor(w, req.params.id);
    const devices = (await q(`SELECT id, name, type_id, status, last_seen_at, connectivity FROM devices WHERE site_id = $1 ORDER BY id`, [site.id])).rows;
    const latest = (await q(
      `SELECT DISTINCT ON (r.device_id, r.metric, r.channel) r.device_id, r.metric, r.channel, r.value, r.time, m.unit, m.label
       FROM readings r LEFT JOIN metrics m ON m.key = r.metric
       WHERE r.site_id = $1 AND r.time > now() - interval '2 days' AND r.quality <> 'rejected'
       ORDER BY r.device_id, r.metric, r.channel, r.time DESC`, [site.id])).rows;
    const alerts = (await q(`SELECT * FROM alerts WHERE site_id = $1 AND status <> 'resolved' ORDER BY opened_at DESC LIMIT 50`, [site.id])).rows;
    const stacks = (await q(`SELECT z.code AS zone, st.code AS stack, st.commodity FROM zones z LEFT JOIN stacks st ON st.zone_id = z.id WHERE z.site_id = $1 ORDER BY z.code, st.code`, [site.id])).rows;
    return { body: { site, devices, latest, alerts, stacks } };
  });

  r.get('/app/api/alerts', async (req) => {
    const w = await who(req);
    return { body: { alerts: (await q(`SELECT a.*, s.name AS site_name FROM alerts a LEFT JOIN sites s ON s.id = a.site_id
      WHERE ($1::uuid IS NULL OR a.org_id = $1) AND a.status <> 'resolved' ORDER BY (a.severity = 'critical') DESC, a.opened_at DESC LIMIT 200`, [w.orgId])).rows } };
  });

  r.post('/app/api/alerts/:id/ack', async (req) => {
    const w = await who(req);
    const res = await q(`UPDATE alerts SET status = 'acknowledged', acked_at = now(), acked_by = $3 WHERE id = $1 AND ($2::uuid IS NULL OR org_id = $2) AND status = 'open'`,
      [req.params.id, w.orgId, w.userId]);
    if (!res.rowCount) throw new HttpError(404, 'not_found', 'Alert not found or already handled');
    await q(`INSERT INTO audit_log (actor, org_id, action, target) VALUES ($1,$2,'alert.ack',$3)`, [`user:${w.userId}`, w.orgId, req.params.id]);
    return { body: { ok: true } };
  });

  // Installing a device on site: scan its label, pick the site, get the provisioning code.
  r.post('/app/api/devices/install', async (req) => {
    const w = await who(req);
    if (w.mode === 'client' && w.role !== 'client_owner') throw new HttpError(403, 'forbidden', 'Only account owners can install devices');
    const site = await siteFor(w, str(req.body?.siteId, 'siteId', 36));
    const id = str(req.body?.id, 'id', 64).toUpperCase().replace(/\s+/g, '');
    const prefix = site.device_prefix;
    if (!prefix) throw new HttpError(409, 'no_prefix', `${site.org_name} has no device ID prefix yet`);
    if (!new RegExp(`^${prefix}-\\d{6,}$`).test(id)) throw new HttpError(400, 'invalid_id', `Devices for ${site.org_name} look like ${prefix}-000001`);
    const typeId = optStr(req.body?.typeId, 40) ?? 'wareguard-v1';
    if (!DEVICE_TYPES.includes(typeId)) throw new HttpError(400, 'invalid_type');
    const existing = (await q(`SELECT id, org_id, token_hash FROM devices WHERE id = $1`, [id])).rows[0];
    if (existing && existing.org_id !== site.org_id) throw new HttpError(409, 'exists', `${id} belongs to another organisation`);
    if (existing) {
      await q(`UPDATE devices SET site_id = $2, name = coalesce($3, name) WHERE id = $1`, [id, site.id, optStr(req.body?.name)]);
    } else {
      await q(`INSERT INTO devices (id, org_id, site_id, type_id, connectivity, name) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, site.org_id, site.id, typeId, req.body?.connectivity === 'gsm' ? 'gsm' : 'wifi', optStr(req.body?.name)]);
    }
    const code = await d.devices.issueProvisionCode(id);
    await q(`INSERT INTO audit_log (actor, org_id, action, target, detail) VALUES ($1,$2,'device.installed',$3,$4)`,
      [`user:${w.userId}`, site.org_id, id, JSON.stringify({ site: site.id, via: 'field app', reinstall: !!existing })]);
    return { status: 201, body: { id, site: site.name, provisioningCode: code, expiresInDays: 7, reinstall: !!existing } };
  });
}

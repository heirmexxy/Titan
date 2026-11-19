import { clearCookie, parseCookies, SESSION_DAYS, sessionCookie, verifyPassword } from '../admin/auth.js';
import { randomToken, sha256Hex } from '../core/crypto.js';
import type { ApiKeyAuth } from '../http/apikey.js';
import { mount, num, optStr, str, uuid, type ActorResolvers, type RouteDef } from '../http/actors.js';
import { HttpError, type Req, type Res, type Router } from '../http/router.js';
import type { EmailSender } from '../notify/providers.js';
import { REGISTRIES, VerifyError, type RegistryService } from './registry.js';

export const VERIFY_COOKIE = 'titan_verify';

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof VerifyError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
};
const ids = (v: unknown): string[] | null => {
  const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(/[\s,]+/) : null;
  return list ? list.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 2000) : null;
};

interface VerifierWho { userId: string; email: string; orgId: string; orgName: string; actor: string }

export function registerVerification(r: Router, reg: RegistryService, o: {
  auth: ActorResolvers; apiKey: ApiKeyAuth; email: EmailSender; publicUrl: string; secureCookies: boolean;
}) {
  const q = (t: string, v: unknown[] = []) => reg.pool.query(t, v);

  // ================= Owner side (admin, console, /v1 with carbon scopes) =================
  const owner: RouteDef[] = [
    { method: 'GET', path: '/carbon/registries', scope: 'read:carbon', handler: () => ({ body: { registries: REGISTRIES } }) },
    {
      method: 'GET', path: '/carbon/projects/:id/verification', scope: 'read:carbon',
      handler: async (req, a) => {
        const p = await wrap(() => reg.projectForOwner(uuid(req.params.id, 'id'), a.orgId));
        const verifiers = (await q(`SELECT va.*, o.name, (SELECT string_agg(email, ', ') FROM users u WHERE u.org_id = o.id AND u.role = 'verifier') AS emails
          FROM verifier_assignments va JOIN organisations o ON o.id = va.verifier_org_id WHERE va.project_id = $1 ORDER BY va.granted_at`, [p.id])).rows;
        return { body: { project: p, verifiers, findings: await reg.listFindings(p.id), statements: await reg.listStatements(p.id), submissions: await reg.listSubmissions(p.id), registries: REGISTRIES } };
      },
    },
    {
      method: 'POST', path: '/carbon/projects/:id/registry', scope: 'write:carbon', privileged: true,
      handler: async (req, a) => ({ body: { project: await wrap(() => reg.setRegistry(uuid(req.params.id, 'id'), a.orgId, { registry: optStr(req.body?.registry, 60), registryMethodology: optStr(req.body?.registryMethodology, 120), registryProjectId: optStr(req.body?.registryProjectId, 60) })) } }),
    },
    {
      method: 'POST', path: '/carbon/projects/:id/verifiers', scope: 'write:carbon', privileged: true,
      handler: async (req, a) => {
        const out = await wrap(() => reg.assign(uuid(req.params.id, 'id'), a.orgId, { email: str(req.body?.email, 'email', 254), organisation: str(req.body?.organisation, 'organisation', 120), by: a.actor }));
        let link = `${o.publicUrl}/verify/`;
        if (out.needsPassword) {
          const token = randomToken(32);
          await q(`INSERT INTO user_tokens (id, user_id, purpose, expires_at) VALUES ($1,$2,'reset_password', now() + interval '7 days')`, [sha256Hex(token), out.userId]);
          link = `${o.publicUrl}/verify/#reset?token=${token}`;
        }
        await o.email.send(str(req.body?.email, 'email', 254), `Verification access: ${out.project.name}`,
          `${out.project.org_name} has given you verifier access to the carbon project "${out.project.name}" on Titan.\n\n` +
          `${out.needsPassword ? 'Set your password and sign in here (link valid 7 days):' : 'Sign in here:'}\n${link}\n\n` +
          `You will see the project's evidence: calculations, lab results with file fingerprints, and the signed device messages behind every reading. You can raise findings and sign a verification statement.`);
        return { status: 201, body: { ok: true, verifierOrgId: out.verifierOrgId, invited: out.needsPassword } };
      },
    },
    {
      method: 'DELETE', path: '/carbon/projects/:id/verifiers/:org', scope: 'write:carbon', privileged: true,
      handler: async (req, a) => { await wrap(() => reg.revoke(uuid(req.params.id, 'id'), a.orgId, uuid(req.params.org, 'org'))); return { status: 204 }; },
    },
    {
      method: 'POST', path: '/carbon/findings/:id/respond', scope: 'write:carbon',
      handler: async (req, a) => ({ body: { finding: await wrap(() => reg.respond(uuid(req.params.id, 'id'), a.orgId, str(req.body?.response, 'response', 4000), a.actor)) } }),
    },
    {
      method: 'POST', path: '/carbon/projects/:id/submissions', scope: 'write:carbon', privileged: true,
      handler: async (req, a) => ({
        status: 201,
        body: { submission: await wrap(() => reg.prepareSubmission(uuid(req.params.id, 'id'), a.orgId, { registry: str(req.body?.registry, 'registry', 20), statementId: optStr(req.body?.statementId, 36), activityIds: ids(req.body?.activityIds), by: a.actor })) },
      }),
    },
    {
      method: 'POST', path: '/carbon/submissions/:id/status', scope: 'write:carbon', privileged: true,
      handler: async (req, a) => {
        const b = req.body ?? {};
        return { body: { submission: await wrap(() => reg.updateSubmission(uuid(req.params.id, 'id'), a.orgId, {
          status: str(b.status, 'status', 20), registryRef: optStr(b.registryRef, 120), issuedTco2e: num(b.issuedTco2e, 'issuedTco2e', { min: 0, optional: true }),
          serialFrom: optStr(b.serialFrom, 120), serialTo: optStr(b.serialTo, 120), notes: optStr(b.notes, 2000),
        })) } };
      },
    },
    {
      method: 'GET', path: '/carbon/submissions/:id/package', scope: 'read:carbon',
      handler: async (req, a): Promise<Res> => {
        const fmt = req.query.get('format') === 'json' ? 'json' : 'zip';
        const out = await wrap(() => reg.submissionPackage(uuid(req.params.id, 'id'), a.orgId, fmt));
        if ('json' in out) return { body: out.json };
        return { body: out.zip, headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${out.name}"`, 'Cache-Control': 'no-store' } };
      },
    },
  ];
  mount(r, owner, o.auth);

  // ================= Verifier side =================
  const verifierSession = async (req: Req): Promise<VerifierWho> => {
    const token = parseCookies(req.headers.cookie)[VERIFY_COOKIE];
    if (!token) throw new HttpError(401, 'unauthorized');
    const row = (await q(
      `SELECT u.id, u.email, o.id AS org_id, o.name AS org_name FROM sessions s JOIN users u ON u.id = s.user_id JOIN organisations o ON o.id = u.org_id
       WHERE s.id = $1 AND s.expires_at > now() AND u.disabled_at IS NULL AND u.role = 'verifier' AND o.kind = 'verifier'`, [sha256Hex(token)])).rows[0];
    if (!row) throw new HttpError(401, 'unauthorized');
    if (req.method !== 'GET' && req.headers['x-titan-verify'] !== '1') throw new HttpError(403, 'forbidden', 'Missing X-Titan-Verify header');
    return { userId: row.id, email: row.email, orgId: row.org_id, orgName: row.org_name, actor: `user:${row.id}` };
  };
  const verifierKey = async (req: Req, scope: string): Promise<VerifierWho> => {
    const key = await o.apiKey(req, scope);
    const org = (await q(`SELECT id, name FROM organisations WHERE id = $1 AND kind = 'verifier'`, [key.orgId])).rows[0];
    if (!org) throw new HttpError(403, 'forbidden', 'Verification endpoints need a verifier organisation’s key');
    return { userId: '', email: '', orgId: org.id, orgName: org.name, actor: `apikey:${key.id}` };
  };

  const attempts = new Map<string, { n: number; reset: number }>();
  r.post('/verify/api/login', async (req) => {
    const email = str(req.body?.email, 'email', 254).toLowerCase();
    const key = `${req.ip}|${email}`;
    const at = attempts.get(key);
    if (at && at.reset > Date.now() && at.n >= 8) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.');
    const u = (await q(`SELECT u.id, u.password_hash, u.disabled_at FROM users u JOIN organisations o ON o.id = u.org_id WHERE lower(u.email) = $1 AND u.role = 'verifier' AND o.kind = 'verifier'`, [email])).rows[0];
    if (!u || u.disabled_at || !(await verifyPassword(str(req.body?.password, 'password', 500), u.password_hash))) {
      attempts.set(key, { n: (at && at.reset > Date.now() ? at.n : 0) + 1, reset: Date.now() + 15 * 60_000 });
      throw new HttpError(401, 'invalid_login', 'Email or password is incorrect');
    }
    attempts.delete(key);
    const token = randomToken(32);
    await q(`INSERT INTO sessions (id, user_id, expires_at, ip) VALUES ($1,$2, now() + make_interval(days => $3), $4)`, [sha256Hex(token), u.id, SESSION_DAYS, req.ip]);
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
    return { body: { ok: true }, headers: { 'Set-Cookie': sessionCookie(token, o.secureCookies, VERIFY_COOKIE) } };
  });
  r.post('/verify/api/logout', async (req) => {
    const token = parseCookies(req.headers.cookie)[VERIFY_COOKIE];
    if (token) await q(`DELETE FROM sessions WHERE id = $1`, [sha256Hex(token)]);
    return { body: { ok: true }, headers: { 'Set-Cookie': clearCookie(o.secureCookies, VERIFY_COOKIE) } };
  });
  r.get('/verify/api/me', async (req) => {
    const w = await verifierSession(req);
    return { body: { email: w.email, organisation: w.orgName } };
  });

  // Same handlers for the portal (cookie) and /v1/verification (API key).
  type VH = (req: Req, w: VerifierWho) => Promise<Res>;
  const both = (method: 'GET' | 'POST', path: string, scope: string, h: VH) => {
    r.on(method, `/verify/api${path}`, async (req) => h(req, await verifierSession(req)));
    r.on(method, `/v1/verification${path}`, async (req) => h(req, await verifierKey(req, scope)));
  };

  both('GET', '/projects', 'verify:carbon', async (_req, w) => ({ body: { projects: await reg.assignedProjects(w.orgId) } }));
  both('GET', '/projects/:id', 'verify:carbon', async (req, w) => {
    const p = await wrap(() => reg.projectForVerifier(uuid(req.params.id, 'id'), w.orgId));
    const evidence = await reg.evidence(p.id, ids(req.query.get('activities')));
    const all = (await q(`SELECT id, reference, status, started_at, ended_at, device_id, (result->>'netTco2e')::float AS net_tco2e FROM carbon_activities WHERE project_id = $1 AND status <> 'rejected' ORDER BY started_at`, [p.id])).rows;
    return { body: { project: { id: p.id, name: p.name, owner: p.org_name, methodology: p.methodology, registry: p.registry, registryMethodology: p.registry_methodology }, activities: all, evidence, findings: await reg.listFindings(p.id, w.orgId), statements: await reg.listStatements(p.id, w.orgId) } };
  });
  both('POST', '/projects/:id/findings', 'verify:carbon', async (req, w) => ({
    status: 201,
    body: { finding: await wrap(() => reg.raiseFinding(uuid(req.params.id, 'id'), w.orgId, { activityId: optStr(req.body?.activityId, 36), kind: str(req.body?.kind, 'kind', 30), text: str(req.body?.text, 'text', 4000), by: w.actor })) },
  }));
  both('POST', '/findings/:id/close', 'verify:carbon', async (req, w) => ({ body: { finding: await wrap(() => reg.closeFinding(uuid(req.params.id, 'id'), w.orgId)) } }));
  both('POST', '/findings/:id/reopen', 'verify:carbon', async (req, w) => ({ body: { finding: await wrap(() => reg.closeFinding(uuid(req.params.id, 'id'), w.orgId, true)) } }));
  both('POST', '/projects/:id/statements', 'verify:carbon', async (req, w) => ({
    status: 201,
    body: { statement: await wrap(() => reg.sign(uuid(req.params.id, 'id'), w.orgId, {
      activityIds: ids(req.body?.activityIds) ?? [], opinion: str(req.body?.opinion, 'opinion', 20), verifiedTco2e: num(req.body?.verifiedTco2e, 'verifiedTco2e', { min: 0 })!,
      statement: str(req.body?.statement, 'statement', 8000), by: w.actor,
    })) },
  }));

  // Verifier API keys (portal only).
  r.get('/verify/api/keys', async (req) => {
    const w = await verifierSession(req);
    return { body: { keys: (await q(`SELECT id, name, prefix, scopes, last_used_at, revoked_at, created_at FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`, [w.orgId])).rows } };
  });
  r.post('/verify/api/keys', async (req) => {
    const w = await verifierSession(req);
    const raw = `tk_live_${randomToken(24)}`;
    const row = (await q(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [w.orgId, str(req.body?.name, 'name', 80), raw.slice(0, 12), sha256Hex(raw), ['verify:carbon', 'read:carbon']])).rows[0];
    return { status: 201, body: { id: row.id, key: raw, note: 'Shown once. Use it as Authorization: Bearer … on /v1/verification/*' } };
  });
  r.post('/verify/api/keys/:id/revoke', async (req) => {
    const w = await verifierSession(req);
    await q(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2`, [req.params.id, w.orgId]);
    return { body: { ok: true } };
  });
}

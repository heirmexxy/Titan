import { HttpError, type Req, type Router } from '../http/router.js';
import type { OpsAgent } from './ops-agent.js';
import { renderReportHtml } from './ops-agent.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }
type Session = (req: Req, role?: 'admin') => Promise<{ userId: string; role: string }>;
type ConsoleWho = (req: Req) => Promise<{ orgId: string }>;

const wrap = async <T>(fn: () => Promise<T>) => {
  try { return await fn(); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'agent_error', (e as Error).message); }
};

/** Admin routes for the operations agent: /admin/api/agent/* */
export function registerAgentAdmin(r: Router, d: { pool: Pool; agent: OpsAgent; session: Session }) {
  const q = (t: string, v: unknown[] = []) => d.pool.query(t, v);
  const html = (body: string) => ({ body, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  r.get('/admin/api/agent/summary', async (req) => {
    await d.session(req);
    const c = (await q(`SELECT
      (SELECT count(*) FROM incidents WHERE status = 'open')::int AS incidents,
      (SELECT count(*) FROM sensor_findings WHERE status = 'open')::int AS findings,
      (SELECT count(*) FROM sensor_findings WHERE status = 'open' AND severity = 'critical')::int AS critical_findings,
      (SELECT count(*) FROM drafted_messages WHERE status = 'draft')::int AS drafts,
      (SELECT count(*) FROM reports WHERE status = 'draft')::int AS draft_reports`)).rows[0];
    return { body: c };
  });
  r.post('/admin/api/agent/run', async (req) => {
    await d.session(req);
    const what = req.body?.what;
    if (what === 'incidents') return { body: await d.agent.runIncidents() };
    if (what === 'health') return { body: await d.agent.runSensorHealth() };
    throw new HttpError(400, 'invalid_request', 'what must be incidents or health');
  });
  r.get('/admin/api/agent/incidents', async (req) => {
    await d.session(req);
    const s = req.query.get('status');
    return { body: { incidents: await d.agent.listIncidents(s === 'resolved' ? 'resolved' : s === 'all' ? null : 'open') } };
  });
  r.post('/admin/api/agent/incidents/:id/draft', async (req) => {
    await d.session(req);
    return { status: 201, body: { draft: await wrap(() => d.agent.draftIncidentMessage(req.params.id)) } };
  });
  r.get('/admin/api/agent/findings', async (req) => {
    await d.session(req);
    return { body: { findings: await d.agent.listFindings(req.query.get('status') ?? 'open') } };
  });
  r.post('/admin/api/agent/findings/:id/dismiss', async (req) => {
    await d.session(req);
    await d.agent.dismissFinding(req.params.id);
    return { body: { ok: true } };
  });
  r.get('/admin/api/agent/drafts', async (req) => {
    await d.session(req);
    return { body: { drafts: (await q(
      `SELECT m.*, o.name AS org_name, i.title AS incident_title FROM drafted_messages m JOIN organisations o ON o.id = m.org_id LEFT JOIN incidents i ON i.id = m.incident_id
       WHERE m.status = $1 ORDER BY m.created_at DESC LIMIT 100`, [req.query.get('status') ?? 'draft'])).rows } };
  });
  r.get('/admin/api/agent/drafts/:id/recipients', async (req) => {
    await d.session(req);
    const m = (await q(`SELECT org_id FROM drafted_messages WHERE id = $1`, [req.params.id])).rows[0];
    if (!m) throw new HttpError(404, 'not_found');
    return { body: { to: await d.agent.recipientsFor(m.org_id) } };
  });
  r.post('/admin/api/agent/drafts/:id/send', async (req) => {
    const s = await d.session(req);
    const to = typeof req.body?.to === 'string' ? req.body.to.split(/[,\s]+/).filter(Boolean) : req.body?.to;
    return { body: await wrap(() => d.agent.sendMessage(req.params.id, { subject: req.body?.subject, body: req.body?.body, to }, s.userId)) };
  });
  r.post('/admin/api/agent/drafts/:id/discard', async (req) => {
    await d.session(req);
    await q(`UPDATE drafted_messages SET status = 'discarded' WHERE id = $1 AND status = 'draft'`, [req.params.id]);
    return { body: { ok: true } };
  });
  r.get('/admin/api/agent/reports', async (req) => {
    await d.session(req);
    return { body: { reports: (await q(
      `SELECT r.id, r.org_id, r.period, r.status, r.sent_at, r.sent_to, r.created_at, r.narrative, r.data->'totals' AS totals, o.name AS org_name
       FROM reports r JOIN organisations o ON o.id = r.org_id ORDER BY r.period DESC, o.name LIMIT 200`)).rows } };
  });
  r.post('/admin/api/agent/reports', async (req) => {
    await d.session(req);
    const period = String(req.body?.period ?? '');
    if (req.body?.orgId === 'all') {
      const orgs = (await q(`SELECT id FROM organisations WHERE kind <> 'consumer'`)).rows;
      for (const o of orgs) await wrap(() => d.agent.buildReport(o.id, period));
      return { body: { generated: orgs.length } };
    }
    return { status: 201, body: { report: await wrap(() => d.agent.buildReport(String(req.body?.orgId ?? ''), period)) } };
  });
  r.get('/admin/api/agent/reports/:id/html', async (req) => {
    await d.session(req);
    const rep = (await q(`SELECT data, narrative FROM reports WHERE id = $1`, [req.params.id])).rows[0];
    if (!rep) throw new HttpError(404, 'not_found');
    return html(renderReportHtml(rep));
  });
  r.post('/admin/api/agent/reports/:id/send', async (req) => {
    const s = await d.session(req);
    const to = typeof req.body?.to === 'string' ? req.body.to.split(/[,\s]+/).filter(Boolean) : req.body?.to;
    return { body: await wrap(() => d.agent.sendReport(req.params.id, to, `user:${s.userId}`)) };
  });
  r.get('/admin/api/agent/readiness/:activityId', async (req) => {
    await d.session(req);
    return { body: await wrap(() => d.agent.carbonReadiness(req.params.activityId)) };
  });
  r.get('/admin/api/agent/verifier-pack/:projectId', async (req) => {
    await d.session(req);
    const pack = await wrap(() => d.agent.verifierPack(req.params.projectId));
    return { body: pack, headers: { 'Content-Disposition': `attachment; filename="verifier-pack-${req.params.projectId.slice(0, 8)}.json"` } };
  });
}

/** Client console routes: their own sent reports and open incidents. */
export function registerAgentConsole(r: Router, d: { pool: Pool; who: ConsoleWho }) {
  const q = (t: string, v: unknown[] = []) => d.pool.query(t, v);
  r.get('/console/api/reports', async (req) => {
    const w = await d.who(req);
    return { body: { reports: (await q(`SELECT id, period, sent_at, data->'totals' AS totals FROM reports WHERE org_id = $1 AND status = 'sent' ORDER BY period DESC`, [w.orgId])).rows } };
  });
  r.get('/console/api/reports/:id/html', async (req) => {
    const w = await d.who(req);
    const rep = (await q(`SELECT data, narrative FROM reports WHERE id = $1 AND org_id = $2 AND status = 'sent'`, [req.params.id, w.orgId])).rows[0];
    if (!rep) throw new HttpError(404, 'not_found');
    return { body: renderReportHtml(rep), headers: { 'Content-Type': 'text/html; charset=utf-8' } };
  });
  r.get('/console/api/incidents', async (req) => {
    const w = await d.who(req);
    return { body: { incidents: (await q(
      `SELECT i.id, i.title, i.summary, i.cause, i.status, i.opened_at, i.resolved_at, s.name AS site_name FROM incidents i LEFT JOIN sites s ON s.id = i.site_id
       WHERE i.org_id = $1 AND (i.status = 'open' OR i.resolved_at > now() - interval '7 days') ORDER BY i.opened_at DESC LIMIT 50`, [w.orgId])).rows } };
  });
}

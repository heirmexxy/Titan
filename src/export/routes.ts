/**
 * Data export: CSV or Excel for readings, alerts, devices, quality tests, lots and custody, PAYG and carbon.
 * GET {admin|console}/api/export/<dataset>?format=csv|xlsx&from=&to=&site=&device=&metric=&interval=
 * GET /v1/export/<dataset> with an API key holding export:data.
 */
import { date, mount, type Actor, type ActorResolvers, type RouteDef } from '../http/actors.js';
import { HttpError, type Req, type Router } from '../http/router.js';
import { toCsv, toXlsx, type Cell } from './files.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

const MAX_ROWS = { csv: 500_000, xlsx: 200_000 };
const DAY = 86_400_000;

interface Dataset {
  title: string;
  headers: string[];
  /** Returns rows already in column order. */
  rows: (p: { org: string | null; from: Date; to: Date; site: string | null; device: string | null; metrics: string[] | null; interval: string; limit: number }) => Promise<Cell[][]>;
  /** Whether from/to apply (defaults to the last 30 days). */
  timed?: boolean;
}

export function datasets(pool: Pool): Record<string, Dataset> {
  const q = (t: string, v: unknown[]) => pool.query(t, v).then((r) => r.rows);
  const d = (x: unknown) => (x ? new Date(x as string) : null);
  const n = (x: unknown) => (x === null || x === undefined ? null : Number(x));
  return {
    readings: {
      title: 'Readings', timed: true,
      headers: ['time_utc', 'site', 'device', 'metric', 'channel', 'value', 'unit', 'quality', 'readings_in_bucket'],
      rows: async (p) => {
        const bucket = p.interval === 'raw' ? null : p.interval === '1h' ? '1 hour' : p.interval === '1d' ? '1 day' : '1 minute';
        const where = `r.time >= $1 AND r.time < $2 AND ($3::uuid IS NULL OR r.org_id = $3) AND ($4::uuid IS NULL OR r.site_id = $4)
          AND ($5::text IS NULL OR r.device_id = $5) AND ($6::text[] IS NULL OR r.metric = ANY($6)) AND r.quality <> 'rejected'`;
        const rows = bucket
          ? await q(`SELECT date_bin($8::interval, r.time, '2000-01-01') AS t, s.name AS site, r.device_id, r.metric, r.channel, avg(r.value) AS value, m.unit, 'ok' AS quality, count(*)::int AS n
                     FROM readings r LEFT JOIN sites s ON s.id = r.site_id LEFT JOIN metrics m ON m.key = r.metric WHERE ${where}
                     GROUP BY 1, s.name, r.device_id, r.metric, r.channel, m.unit ORDER BY 1, r.device_id, r.metric LIMIT $7`,
            [p.from, p.to, p.org, p.site, p.device, p.metrics, p.limit, bucket])
          : await q(`SELECT r.time AS t, s.name AS site, r.device_id, r.metric, r.channel, r.value, m.unit, r.quality, 1 AS n
                     FROM readings r LEFT JOIN sites s ON s.id = r.site_id LEFT JOIN metrics m ON m.key = r.metric WHERE ${where}
                     ORDER BY r.time, r.device_id, r.metric LIMIT $7`, [p.from, p.to, p.org, p.site, p.device, p.metrics, p.limit]);
        return rows.map((r) => [d(r.t), r.site, r.device_id, r.metric, r.channel, n(r.value) === null ? null : Math.round(Number(r.value) * 1000) / 1000, r.unit, r.quality, n(r.n)]);
      },
    },
    alerts: {
      title: 'Alerts', timed: true,
      headers: ['opened_utc', 'resolved_utc', 'site', 'device', 'channel', 'severity', 'code', 'title', 'value', 'status'],
      rows: async (p) => (await q(
        `SELECT a.*, s.name AS site FROM alerts a LEFT JOIN sites s ON s.id = a.site_id
         WHERE a.opened_at >= $1 AND a.opened_at < $2 AND ($3::uuid IS NULL OR a.org_id = $3) AND ($4::uuid IS NULL OR a.site_id = $4) AND ($5::text IS NULL OR a.device_id = $5)
         ORDER BY a.opened_at LIMIT $6`, [p.from, p.to, p.org, p.site, p.device, p.limit]))
        .map((a) => [d(a.opened_at), d(a.resolved_at), a.site, a.device_id, a.channel, a.severity, a.code, a.title, n(a.value), a.status]),
    },
    devices: {
      title: 'Devices',
      headers: ['device', 'name', 'type', 'organisation', 'site', 'connectivity', 'status', 'last_seen_utc', 'firmware', 'registered_utc'],
      rows: async (p) => (await q(
        `SELECT dv.*, o.name AS org, s.name AS site, f.current_version FROM devices dv JOIN organisations o ON o.id = dv.org_id
         LEFT JOIN sites s ON s.id = dv.site_id LEFT JOIN device_firmware f ON f.device_id = dv.id
         WHERE ($1::uuid IS NULL OR dv.org_id = $1) AND ($2::uuid IS NULL OR dv.site_id = $2) ORDER BY dv.id LIMIT $3`, [p.org, p.site, p.limit]))
        .map((x) => [x.id, x.name, x.type_id, x.org, x.site, x.connectivity, x.status, d(x.last_seen_at), x.current_version, d(x.created_at)]),
    },
    'quality-tests': {
      title: 'Quality tests', timed: true,
      headers: ['tested_utc', 'lot', 'commodity', 'spec', 'outcome', 'failures', 'results', 'site', 'device', 'sample', 'tested_by', 'lat', 'lng'],
      rows: async (p) => (await q(
        `SELECT t.*, l.code AS lot, s.name AS spec, si.name AS site FROM quality_tests t LEFT JOIN lots l ON l.id = t.lot_id
         LEFT JOIN quality_specs s ON s.id = t.spec_id LEFT JOIN sites si ON si.id = t.site_id
         WHERE t.tested_at >= $1 AND t.tested_at < $2 AND ($3::uuid IS NULL OR t.org_id = $3) AND ($4::uuid IS NULL OR t.site_id = $4)
         ORDER BY t.tested_at LIMIT $5`, [p.from, p.to, p.org, p.site, p.limit]))
        .map((t) => [d(t.tested_at), t.lot, t.commodity, t.spec, t.outcome, (t.failures ?? []).map((f: any) => `${f.key} ${f.reason}`).join('; '),
          Object.entries(t.results ?? {}).map(([k, v]) => `${k}=${v}`).join('; '), t.site, t.device_id, t.sample_ref, t.tested_by, n(t.lat), n(t.lng)]),
    },
    lots: {
      title: 'Lots',
      headers: ['lot', 'commodity', 'quantity', 'unit', 'origin', 'origin_lat', 'origin_lng', 'harvested_on', 'status', 'site', 'tests', 'last_outcome', 'created_utc'],
      rows: async (p) => (await q(
        `SELECT l.*, s.name AS site, (SELECT count(*) FROM quality_tests t WHERE t.lot_id = l.id)::int AS tests,
                (SELECT outcome FROM quality_tests t WHERE t.lot_id = l.id ORDER BY tested_at DESC LIMIT 1) AS last_outcome
         FROM lots l LEFT JOIN sites s ON s.id = l.site_id WHERE ($1::uuid IS NULL OR l.org_id = $1) AND ($2::uuid IS NULL OR l.site_id = $2)
         ORDER BY l.created_at LIMIT $3`, [p.org, p.site, p.limit]))
        .map((l) => [l.code, l.commodity, n(l.quantity), l.unit, l.origin, n(l.origin_lat), n(l.origin_lng), l.harvested_on ? String(l.harvested_on).slice(0, 10) : null, l.status, l.site, l.tests, l.last_outcome, d(l.created_at)]),
    },
    custody: {
      title: 'Custody events', timed: true,
      headers: ['time_utc', 'lot', 'event', 'site', 'stack', 'counterparty', 'quantity', 'note', 'lat', 'lng', 'recorded_by'],
      rows: async (p) => (await q(
        `SELECT e.*, l.code AS lot, s.name AS site, st.code AS stack FROM custody_events e JOIN lots l ON l.id = e.lot_id
         LEFT JOIN sites s ON s.id = e.site_id LEFT JOIN stacks st ON st.id = e.stack_id
         WHERE e.at >= $1 AND e.at < $2 AND ($3::uuid IS NULL OR e.org_id = $3) ORDER BY e.at LIMIT $4`, [p.from, p.to, p.org, p.limit]))
        .map((e) => [d(e.at), e.lot, e.kind, e.site, e.stack, e.counterparty, n(e.quantity), e.note, n(e.lat), n(e.lng), e.recorded_by]),
    },
    'payg-payments': {
      title: 'PAYG payments', timed: true,
      headers: ['received_utc', 'account_code', 'device', 'customer', 'customer_ref', 'amount', 'currency', 'source', 'reference', 'hours_added', 'credit_until_utc'],
      rows: async (p) => (await q(
        `SELECT pm.*, a.code, a.device_id, a.customer_name, a.customer_ref FROM payg_payments pm JOIN payg_accounts a ON a.id = pm.account_id
         WHERE pm.received_at >= $1 AND pm.received_at < $2 AND ($3::uuid IS NULL OR pm.org_id = $3) ORDER BY pm.received_at LIMIT $4`, [p.from, p.to, p.org, p.limit]))
        .map((x) => [d(x.received_at), x.code, x.device_id, x.customer_name, x.customer_ref, n(x.amount), x.currency, x.source, x.reference, n(x.hours_added), d(x.credit_until)]),
    },
    'payg-accounts': {
      title: 'PAYG accounts',
      headers: ['account_code', 'device', 'customer', 'phone', 'customer_ref', 'plan', 'status', 'credit_until_utc', 'total_paid', 'currency', 'lock_state', 'created_utc'],
      rows: async (p) => (await q(
        `SELECT a.*, pl.name AS plan, pl.currency FROM payg_accounts a JOIN payg_plans pl ON pl.id = a.plan_id WHERE ($1::uuid IS NULL OR a.org_id = $1) ORDER BY a.created_at LIMIT $2`, [p.org, p.limit]))
        .map((a) => [a.code, a.device_id, a.customer_name, a.customer_phone, a.customer_ref, a.plan, a.status, d(a.credit_until), n(a.total_paid), a.currency, a.lock_state, d(a.created_at)]),
    },
    'carbon-activities': {
      title: 'Carbon activities', timed: true,
      headers: ['project', 'methodology', 'registry', 'reference', 'device', 'started_utc', 'ended_utc', 'status', 'net_tco2e', 'calculated_utc'],
      rows: async (p) => (await q(
        `SELECT a.*, pr.name AS project, pr.methodology, pr.registry FROM carbon_activities a JOIN carbon_projects pr ON pr.id = a.project_id
         WHERE a.started_at >= $1 AND a.started_at < $2 AND ($3::uuid IS NULL OR a.org_id = $3) ORDER BY a.started_at LIMIT $4`, [p.from, p.to, p.org, p.limit]))
        .map((a) => [a.project, a.methodology, a.registry, a.reference, a.device_id, d(a.started_at), d(a.ended_at), a.status, n(a.result?.netTco2e), d(a.calculated_at)]),
    },
  };
}

export async function buildExport(pool: Pool, a: Actor, dataset: string, query: URLSearchParams) {
  const ds = datasets(pool)[dataset];
  if (!ds) throw new HttpError(404, 'unknown_dataset', `Datasets: ${Object.keys(datasets(pool)).join(', ')}`);
  const format = (query.get('format') ?? 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'xlsx') throw new HttpError(400, 'invalid_format', 'format must be csv or xlsx');
  const to = date(query.get('to'), 'to', new Date());
  const from = date(query.get('from'), 'from', new Date(to.getTime() - 30 * DAY));
  if (from >= to) throw new HttpError(400, 'invalid_range', 'from must be before to');
  if (to.getTime() - from.getTime() > 366 * DAY) throw new HttpError(400, 'range_too_large', 'Export at most 366 days at a time');
  const interval = query.get('interval') ?? 'raw';
  if (!['raw', '1m', '1h', '1d'].includes(interval)) throw new HttpError(400, 'invalid_interval', 'interval must be raw, 1m, 1h or 1d');
  const site = query.get('site');
  if (site && !/^[0-9a-f-]{36}$/i.test(site)) throw new HttpError(400, 'invalid_site');
  if (site && a.orgId && !(await pool.query(`SELECT 1 FROM sites WHERE id = $1 AND org_id = $2`, [site, a.orgId])).rows.length) throw new HttpError(404, 'site_not_found');
  const limit = MAX_ROWS[format];
  const rows = await ds.rows({
    org: a.orgId ?? (query.get('org') && /^[0-9a-f-]{36}$/i.test(query.get('org')!) ? query.get('org') : null), from, to, site,
    device: query.get('device'), metrics: query.get('metric')?.split(',').filter(Boolean) ?? null, interval, limit: limit + 1,
  });
  const truncated = rows.length > limit;
  const data = rows.slice(0, limit);
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `titan-${dataset}-${ds.timed ? `${from.toISOString().slice(0, 10)}_to_${to.toISOString().slice(0, 10)}` : stamp}`;
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Titan-Rows': String(data.length), ...(truncated ? { 'X-Titan-Truncated': 'true' } : {}) };
  if (format === 'csv') {
    return { body: toCsv(ds.headers, data), headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}.csv"` } };
  }
  return {
    body: toXlsx([{ name: ds.title, headers: ds.headers, rows: data }]),
    headers: { ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${base}.xlsx"` },
  };
}

export function registerExports(r: Router, pool: Pool, auth: ActorResolvers) {
  const defs: RouteDef[] = [
    { method: 'GET', path: '/export', scope: 'export:data', handler: () => ({ body: { datasets: Object.entries(datasets(pool)).map(([id, x]) => ({ id, title: x.title, columns: x.headers, timed: !!x.timed })) } }) },
    { method: 'GET', path: '/export/:dataset', scope: 'export:data', handler: (req: Req, a: Actor) => buildExport(pool, a, req.params.dataset, req.query) },
  ];
  mount(r, defs, auth);
}

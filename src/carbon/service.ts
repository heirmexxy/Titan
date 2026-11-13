import type { PipelineHook } from '../ingest/pipeline.js';
import type { Device } from '../store/types.js';
import { calculateBiochar, calculateCookstove, detectSessions, heldTemperature, MEASUREMENT_KINDS, type Point } from './methodologies.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export class CarbonError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));

/** Carbon projects, activities (biochar batches, cookstove periods), lab measurements and calculations. */
export class CarbonService implements PipelineHook {
  constructor(private pool: Pool) {}
  private q(t: string, v: unknown[] = []) { return this.pool.query(t, v); }

  async createProject(o: { orgId: string; name: string; methodology: string; registry?: string | null; siteIds: string[]; params?: Record<string, unknown> }) {
    if (!['biochar-v1', 'cookstove-v1'].includes(o.methodology)) throw new CarbonError(400, 'invalid_methodology', 'methodology must be biochar-v1 or cookstove-v1');
    if (o.siteIds.length) {
      const own = (await this.q(`SELECT count(*)::int AS n FROM sites WHERE id = ANY($1::uuid[]) AND org_id = $2`, [o.siteIds, o.orgId])).rows[0];
      if (Number(own.n) !== o.siteIds.length) throw new CarbonError(400, 'invalid_sites', 'Projects can only include the organisation\'s own sites');
    }
    return (await this.q(
      `INSERT INTO carbon_projects (org_id, name, methodology, registry, site_ids, params) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [o.orgId, o.name, o.methodology, o.registry ?? null, o.siteIds, JSON.stringify(o.params ?? {})])).rows[0];
  }

  async updateParams(projectId: string, params: Record<string, unknown>) {
    const r = await this.q(`UPDATE carbon_projects SET params = $2 WHERE id = $1 RETURNING *`, [projectId, JSON.stringify(params)]);
    if (!r.rows[0]) throw new CarbonError(404, 'not_found', 'Project not found');
    return r.rows[0];
  }

  async getProject(id: string) {
    const p = (await this.q(`SELECT * FROM carbon_projects WHERE id = $1`, [id])).rows[0];
    if (!p) throw new CarbonError(404, 'not_found', 'Project not found');
    return p;
  }

  /** Projects owned by an org, or containing a site the org can see (pass visible site IDs). */
  async listProjects(orgId: string | null, visibleSiteIds?: string[]) {
    if (orgId === null) return (await this.q(`SELECT p.*, o.name AS org_name FROM carbon_projects p JOIN organisations o ON o.id = p.org_id ORDER BY p.created_at DESC`)).rows;
    return (await this.q(
      `SELECT * FROM carbon_projects WHERE org_id = $1 OR site_ids && $2::uuid[] ORDER BY created_at DESC`, [orgId, visibleSiteIds ?? []])).rows;
  }

  async summary(projectId: string) {
    const r = (await this.q(
      `SELECT count(*)::int AS activities,
         count(*) FILTER (WHERE status = 'calculated')::int AS calculated,
         count(*) FILTER (WHERE status = 'open')::int AS open,
         coalesce(sum((result->>'netTco2e')::double precision) FILTER (WHERE status = 'calculated' AND result->>'status' = 'ok'), 0) AS net_tco2e
       FROM carbon_activities WHERE project_id = $1`, [projectId])).rows[0];
    return { activities: Number(r.activities), calculated: Number(r.calculated), open: Number(r.open), netTco2e: Math.round(Number(r.net_tco2e) * 1e4) / 1e4 };
  }

  async listActivities(projectId: string, limit = 200) {
    return (await this.q(`SELECT * FROM carbon_activities WHERE project_id = $1 ORDER BY started_at DESC LIMIT $2`, [projectId, limit])).rows;
  }

  async getActivity(id: string) {
    const a = (await this.q(`SELECT * FROM carbon_activities WHERE id = $1`, [id])).rows[0];
    if (!a) throw new CarbonError(404, 'not_found', 'Activity not found');
    const measurements = (await this.q(`SELECT * FROM carbon_measurements WHERE activity_id = $1 ORDER BY created_at`, [id])).rows;
    return { activity: a, measurements };
  }

  async openActivity(o: { projectId: string; kind?: 'batch' | 'period'; siteId?: string | null; deviceId?: string | null; reference?: string | null; startedAt?: Date; endedAt?: Date | null; by: string }) {
    const p = await this.getProject(o.projectId);
    if (p.status !== 'active') throw new CarbonError(409, 'project_inactive', 'Project is not active');
    const kind = o.kind ?? (p.methodology === 'biochar-v1' ? 'batch' : 'period');
    const siteIds: string[] = p.site_ids ?? [];
    if (o.siteId && !siteIds.includes(o.siteId)) throw new CarbonError(400, 'invalid_site', 'Site is not part of this project');
    return (await this.q(
      `INSERT INTO carbon_activities (project_id, org_id, site_id, device_id, kind, reference, started_at, ended_at, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [p.id, p.org_id, o.siteId ?? null, o.deviceId ?? null, kind, o.reference ?? null, o.startedAt ?? new Date(), o.endedAt ?? null,
        o.endedAt ? 'closed' : 'open', o.by])).rows[0];
  }

  async closeActivity(id: string, endedAt = new Date()) {
    const r = await this.q(`UPDATE carbon_activities SET ended_at = $2, status = 'closed' WHERE id = $1 AND status = 'open' AND started_at < $2 RETURNING *`, [id, endedAt]);
    if (!r.rows[0]) throw new CarbonError(409, 'not_open', 'Activity is not open, or the end is before the start');
    return r.rows[0];
  }

  async addMeasurement(o: { activityId: string; kind: string; value: number; sampledAt?: Date | null; documentRef?: string | null; documentSha256?: string | null; note?: string | null; supersedesId?: string | null; by: string }) {
    const spec = MEASUREMENT_KINDS[o.kind];
    if (!spec) throw new CarbonError(400, 'invalid_kind', `kind must be one of ${Object.keys(MEASUREMENT_KINDS).join(', ')}`);
    if (!Number.isFinite(o.value) || o.value < 0) throw new CarbonError(400, 'invalid_value', 'value must be a non-negative number');
    if (spec.unit === '%' && o.value > 100) throw new CarbonError(400, 'invalid_value', 'Percentages must be 0–100');
    if (o.documentSha256 && !/^[0-9a-f]{64}$/i.test(o.documentSha256)) throw new CarbonError(400, 'invalid_hash', 'documentSha256 must be a hex SHA-256');
    const { activity } = await this.getActivity(o.activityId);
    if (activity.status === 'rejected') throw new CarbonError(409, 'rejected', 'Activity was rejected');
    const row = (await this.q(
      `INSERT INTO carbon_measurements (project_id, activity_id, kind, value, unit, sampled_at, document_ref, document_sha256, note, supersedes_id, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [activity.project_id, activity.id, o.kind, o.value, spec.unit, o.sampledAt ?? null, o.documentRef ?? null, o.documentSha256?.toLowerCase() ?? null,
        o.note ?? null, o.supersedesId ?? null, o.by])).rows[0];
    return row;
  }

  /** Latest measurement of each kind that hasn't been superseded. */
  private currentMeasurements(rows: any[]) {
    const superseded = new Set(rows.map((r) => r.supersedes_id).filter(Boolean));
    const out = new Map<string, any>();
    for (const r of rows) if (!superseded.has(r.id)) out.set(r.kind, r); // rows are in created order: later wins
    return out;
  }

  private async series(o: { siteIds: string[]; deviceId: string | null; metric: string; from: Date; to: Date }) {
    return (await this.q(
      `SELECT time, device_id, channel, value, seq FROM readings
       WHERE site_id = ANY($1::uuid[]) AND ($2::text IS NULL OR device_id = $2) AND metric = $3 AND time >= $4 AND time <= $5 AND quality = 'ok'
       ORDER BY time`, [o.siteIds, o.deviceId, o.metric, o.from, o.to])).rows.map((r) => ({ time: new Date(r.time), deviceId: r.device_id, channel: r.channel, value: Number(r.value), seq: num(r.seq) }));
  }

  private lineage(metric: string, rows: { time: Date; deviceId: string; seq: number | null }[]) {
    if (!rows.length) return { metric, readings: 0 };
    const devices = [...new Set(rows.map((r) => r.deviceId))];
    const seqs = rows.map((r) => r.seq).filter((x): x is number => x !== null);
    return { metric, readings: rows.length, devices, from: rows[0].time.toISOString(), to: rows.at(-1)!.time.toISOString(),
      seqRange: seqs.length ? [Math.min(...seqs), Math.max(...seqs)] : null };
  }

  /** Runs the project's methodology over the activity window and stores the result with its inputs. */
  async calculate(activityId: string) {
    const { activity: a, measurements } = await this.getActivity(activityId);
    if (a.status === 'open') throw new CarbonError(409, 'still_open', 'Close the activity before calculating');
    if (a.status === 'rejected') throw new CarbonError(409, 'rejected', 'Activity was rejected');
    const p = await this.getProject(a.project_id);
    const params = p.params ?? {};
    const from = new Date(a.started_at), to = new Date(a.ended_at);
    const siteIds: string[] = a.site_id ? [a.site_id] : p.site_ids ?? [];
    const m = this.currentMeasurements(measurements);
    const used = (k: string) => (m.get(k) ? { id: m.get(k).id, value: Number(m.get(k).value), unit: m.get(k).unit, document: m.get(k).document_ref, sha256: m.get(k).document_sha256 } : null);
    let result: Record<string, unknown>;

    if (p.methodology === 'biochar-v1') {
      const kiln = await this.series({ siteIds, deviceId: a.device_id, metric: 'kiln.temperature', from, to });
      // Kiln nodes have several probes; the held temperature uses the coolest probe at each minute so the whole charge is counted.
      const byMinute = new Map<number, number>();
      for (const r of kiln) {
        const k = Math.floor(r.time.getTime() / 60_000) * 60_000;
        byMinute.set(k, Math.min(byMinute.get(k) ?? Infinity, r.value));
      }
      const points: Point[] = [...byMinute.entries()].sort((x, y) => x[0] - y[0]).map(([t, v]) => ({ time: new Date(t), value: v }));
      const held = heldTemperature(points, Number(params.minHoldMinutes ?? 10));
      const weighed = await this.series({ siteIds, deviceId: a.device_id, metric: 'biochar.mass', from, to });
      const manualMass = used('biochar.mass_kg');
      const massKg = manualMass ? manualMass.value : weighed.length ? weighed.reduce((s, r) => s + r.value, 0) : null;
      const calc = calculateBiochar({
        biocharMassKg: massKg,
        moisturePct: used('biochar.moisture_pct')?.value ?? null,
        organicCarbonPct: used('lab.organic_carbon_pct')?.value ?? null,
        hCorg: used('lab.h_corg')?.value ?? null,
        heldTempC: held,
      }, params);
      result = {
        ...calc,
        inputs: {
          biocharMass: manualMass ? { source: 'measurement', ...manualMass } : { source: 'scale', kg: massKg, ...this.lineage('biochar.mass', weighed) },
          moisture: used('biochar.moisture_pct'), organicCarbon: used('lab.organic_carbon_pct'), hCorg: used('lab.h_corg'),
          feedstock: used('feedstock.mass_kg'),
          kiln: { ...this.lineage('kiln.temperature', kiln), heldTempC: held === null ? null : Math.round(held), minHoldMinutes: Number(params.minHoldMinutes ?? 10) },
        },
        params,
      };
    } else {
      const temps = await this.series({ siteIds, deviceId: a.device_id, metric: 'stove.temperature', from, to });
      const byDevice: Record<string, Point[]> = {};
      for (const r of temps) (byDevice[r.deviceId] ??= []).push({ time: r.time, value: r.value });
      const sessions = Object.fromEntries(Object.entries(byDevice).map(([d, pts]) => [d, detectSessions(pts, params)]));
      const calc = calculateCookstove(sessions, params);
      result = {
        ...calc,
        inputs: { stoveTemperature: this.lineage('stove.temperature', temps), perDevice: Object.fromEntries(Object.entries(sessions).map(([d, s]) => [d, { sessions: s.length, minutes: s.reduce((n, x) => n + x.minutes, 0) }])) },
        params,
      };
    }
    result.period = { from: from.toISOString(), to: to.toISOString() };
    result.calculatedAt = new Date().toISOString();
    const row = (await this.q(
      `UPDATE carbon_activities SET result = $2, status = 'calculated', calculated_at = now() WHERE id = $1 RETURNING *`,
      [activityId, JSON.stringify(result)])).rows[0];
    return row;
  }

  async reject(id: string) {
    const r = await this.q(`UPDATE carbon_activities SET status = 'rejected' WHERE id = $1 RETURNING *`, [id]);
    if (!r.rows[0]) throw new CarbonError(404, 'not_found', 'Activity not found');
    return r.rows[0];
  }

  // ---------- Pipeline hook: kiln nodes open and close batches with events ----------
  async onEvent(device: Device, ev: { code: string; msg?: string }, time: Date) {
    if (ev.code !== 'batch_start' && ev.code !== 'batch_end') return;
    if (!device.siteId) return;
    const p = (await this.q(
      `SELECT id FROM carbon_projects WHERE status = 'active' AND methodology = 'biochar-v1' AND $1::uuid = ANY(site_ids) LIMIT 1`, [device.siteId])).rows[0];
    if (!p) return;
    const open = (await this.q(
      `SELECT id FROM carbon_activities WHERE project_id = $1 AND device_id = $2 AND status = 'open' ORDER BY started_at DESC LIMIT 1`, [p.id, device.id])).rows[0];
    if (ev.code === 'batch_start') {
      if (open) await this.closeActivity(open.id, time); // a missed batch_end: close the previous batch at the new start
      await this.openActivity({ projectId: p.id, kind: 'batch', siteId: device.siteId, deviceId: device.id, reference: ev.msg ?? null, startedAt: time, by: `device:${device.id}` });
    } else if (open) {
      await this.closeActivity(open.id, time);
      await this.calculate(open.id); // usually "incomplete" until lab results are entered; recalculated then
    }
  }
}

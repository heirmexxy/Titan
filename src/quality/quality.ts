/**
 * GradeGuard: produce quality against buyer specifications, and lot traceability.
 *
 * - A spec is a buyer's grade: parameters with min/max (moisture ≤ 14 %, foreign matter ≤ 2 %, aflatoxin ≤ 10 ppb…).
 * - A test is one sample's results. It comes from a GradeGuard device (signed telemetry with `qt`), from the field
 *   app (works offline, deduplicated by client_ref) or from the API, and is scored pass/fail against its spec.
 * - A lot is a traceable quantity of produce with a code on its tag. Custody events record where it came from,
 *   where it was stored and where it went; the trace joins tests, custody and warehouse conditions.
 */
import type { Body, MessageKind } from '../core/envelope.js';
import type { PipelineHook } from '../ingest/pipeline.js';
import type { Device, ReadingRow } from '../store/types.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export class QualityError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface SpecParam { key: string; label?: string; unit?: string; min?: number | null; max?: number | null }

/** Common sample parameters (GradeGuard sends them as metrics `sample.<key>`). */
export const SAMPLE_PARAMS: Record<string, { label: string; unit: string }> = {
  moisture: { label: 'Moisture', unit: '%' }, temperature: { label: 'Sample temperature', unit: '°C' },
  foreign_matter: { label: 'Foreign matter', unit: '%' }, broken: { label: 'Broken grains', unit: '%' },
  discoloured: { label: 'Discoloured grains', unit: '%' }, aflatoxin: { label: 'Aflatoxin', unit: 'ppb' },
  hectolitre_mass: { label: 'Hectolitre mass', unit: 'kg/hl' },
};

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const CUSTODY_KINDS = ['created', 'aggregated', 'tested', 'received', 'stored', 'moved', 'dispatched', 'delivered', 'merged', 'note'] as const;

export function cleanParams(x: unknown): SpecParam[] {
  if (!Array.isArray(x) || !x.length) throw new QualityError(400, 'invalid_parameters', 'A spec needs at least one parameter');
  return x.slice(0, 30).map((p: any) => {
    const key = String(p?.key ?? '').trim().toLowerCase();
    if (!KEY.test(key)) throw new QualityError(400, 'invalid_parameters', `Parameter key "${key}" must be lowercase letters, digits or _`);
    const n = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
    const min = n(p.min), max = n(p.max);
    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) throw new QualityError(400, 'invalid_parameters', `${key}: min and max must be numbers`);
    if (min === null && max === null) throw new QualityError(400, 'invalid_parameters', `${key} needs a min, a max or both`);
    if (min !== null && max !== null && min > max) throw new QualityError(400, 'invalid_parameters', `${key}: min is above max`);
    return { key, label: String(p.label ?? SAMPLE_PARAMS[key]?.label ?? key).slice(0, 60), unit: String(p.unit ?? SAMPLE_PARAMS[key]?.unit ?? '').slice(0, 12), min, max };
  });
}

/** Scores results against a spec. Missing results for a spec parameter count as failures. Pure. */
export function evaluate(params: SpecParam[] | null, results: Record<string, number>) {
  if (!params) return { outcome: 'no_spec' as const, failures: [] as { key: string; value: number | null; min: number | null; max: number | null; reason: string }[] };
  const failures: { key: string; value: number | null; min: number | null; max: number | null; reason: string }[] = [];
  for (const p of params) {
    const v = results[p.key];
    const min = p.min ?? null, max = p.max ?? null;
    if (v === undefined || v === null || !Number.isFinite(v)) failures.push({ key: p.key, value: null, min, max, reason: 'not measured' });
    else if (max !== null && v > max) failures.push({ key: p.key, value: v, min, max, reason: `above ${max}` });
    else if (min !== null && v < min) failures.push({ key: p.key, value: v, min, max, reason: `below ${min}` });
  }
  return { outcome: failures.length ? ('fail' as const) : ('pass' as const), failures };
}

export function cleanResults(x: unknown): Record<string, number> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new QualityError(400, 'invalid_results', 'results must be an object like {"moisture": 13.2}');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>).slice(0, 40)) {
    const key = k.trim().toLowerCase();
    if (!KEY.test(key)) throw new QualityError(400, 'invalid_results', `Result key "${k}" is not valid`);
    if (v === '' || v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new QualityError(400, 'invalid_results', `${key} must be a number`);
    out[key] = n;
  }
  if (!Object.keys(out).length) throw new QualityError(400, 'invalid_results', 'Enter at least one result');
  return out;
}

const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

export class QualityService implements PipelineHook {
  constructor(readonly pool: Pool) {}
  private q(t: string, v: unknown[] = []) { return this.pool.query(t, v); }

  // ---------- Specs ----------
  async createSpec(o: { orgId: string; name: string; buyer?: string | null; commodity: string; parameters: unknown }) {
    const params = cleanParams(o.parameters);
    return (await this.q(`INSERT INTO quality_specs (org_id, name, buyer, commodity, parameters) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [o.orgId, o.name, o.buyer ?? null, o.commodity.toLowerCase(), JSON.stringify(params)])).rows[0];
  }
  async listSpecs(orgId: string | null, all = false) {
    return (await this.q(`SELECT s.*, o.name AS org_name FROM quality_specs s JOIN organisations o ON o.id = s.org_id
      WHERE ($1::uuid IS NULL OR s.org_id = $1) AND ($2 OR s.active) ORDER BY s.active DESC, s.commodity, s.name`, [orgId, all])).rows;
  }
  async setSpecActive(id: string, orgId: string | null, active: boolean) {
    const r = await this.q(`UPDATE quality_specs SET active = $3 WHERE id = $1 AND ($2::uuid IS NULL OR org_id = $2)`, [id, orgId, active]);
    if (!r.rowCount) throw new QualityError(404, 'not_found', 'Spec not found');
  }

  // ---------- Lots ----------
  async createLot(o: { orgId: string; code?: string | null; commodity: string; quantity?: number | null; unit?: string | null; origin?: string | null; lat?: number | null; lng?: number | null; harvestedOn?: string | null; siteId?: string | null; by: string; clientRef?: string | null }) {
    const code = (o.code ?? '').trim().toUpperCase() || `LOT-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    if (!/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(code)) throw new QualityError(400, 'invalid_code', 'Lot codes use letters, digits and . _ / - (max 40)');
    if (o.siteId) await this.assertSite(o.siteId, o.orgId);
    const existing = (await this.q(`SELECT * FROM lots WHERE org_id = $1 AND code = $2`, [o.orgId, code])).rows[0];
    if (existing) {
      if (o.clientRef) return existing; // offline app re-sending
      throw new QualityError(409, 'lot_exists', `Lot ${code} already exists`);
    }
    const lot = (await this.q(
      `INSERT INTO lots (org_id, code, commodity, quantity, unit, origin, origin_lat, origin_lng, harvested_on, site_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [o.orgId, code, o.commodity.toLowerCase(), o.quantity ?? null, o.unit ?? 'kg', o.origin ?? null, o.lat ?? null, o.lng ?? null, o.harvestedOn ?? null, o.siteId ?? null, o.by])).rows[0];
    await this.q(`INSERT INTO custody_events (org_id, lot_id, kind, site_id, quantity, note, lat, lng, recorded_by) VALUES ($1,$2,'created',$3,$4,$5,$6,$7,$8)`,
      [o.orgId, lot.id, o.siteId ?? null, o.quantity ?? null, o.origin ? `Origin: ${o.origin}` : null, o.lat ?? null, o.lng ?? null, o.by]);
    return lot;
  }
  async findLot(codeOrId: string, orgId: string | null) {
    const lot = (await this.q(`SELECT l.*, s.name AS site_name, st.code AS stack_code FROM lots l LEFT JOIN sites s ON s.id = l.site_id LEFT JOIN stacks st ON st.id = l.stack_id
      WHERE ($1::uuid IS NULL OR l.org_id = $1) AND (l.code = upper($2) OR l.id::text = $2) ORDER BY l.created_at DESC LIMIT 1`, [orgId, codeOrId])).rows[0];
    if (!lot) throw new QualityError(404, 'lot_not_found', `No lot ${codeOrId}`);
    return lot;
  }
  async listLots(orgId: string | null, f: { q?: string | null; status?: string | null; siteId?: string | null } = {}) {
    return (await this.q(
      `SELECT l.*, s.name AS site_name, o.name AS org_name,
        (SELECT outcome FROM quality_tests t WHERE t.lot_id = l.id ORDER BY tested_at DESC LIMIT 1) AS last_outcome,
        (SELECT count(*) FROM quality_tests t WHERE t.lot_id = l.id)::int AS tests
       FROM lots l JOIN organisations o ON o.id = l.org_id LEFT JOIN sites s ON s.id = l.site_id
       WHERE ($1::uuid IS NULL OR l.org_id = $1) AND ($2::text IS NULL OR l.code ILIKE '%' || $2 || '%' OR l.origin ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR l.status = $3) AND ($4::uuid IS NULL OR l.site_id = $4)
       ORDER BY l.created_at DESC LIMIT 500`, [orgId, f.q ?? null, f.status ?? null, f.siteId ?? null])).rows;
  }

  private async assertSite(siteId: string, orgId: string) {
    if (!isUuid(siteId) || !(await this.q(`SELECT 1 FROM sites WHERE id = $1 AND org_id = $2`, [siteId, orgId])).rows.length) throw new QualityError(400, 'invalid_site', 'Unknown site');
  }

  /** Adds a custody event and keeps the lot's location and status in step. */
  async addEvent(o: { orgId: string | null; lot: string; kind: string; siteId?: string | null; stack?: string | null; counterparty?: string | null; quantity?: number | null; note?: string | null; lat?: number | null; lng?: number | null; at?: Date | null; by: string; clientRef?: string | null; mergeFrom?: string[] }) {
    if (!(CUSTODY_KINDS as readonly string[]).includes(o.kind) || o.kind === 'created') throw new QualityError(400, 'invalid_kind', `kind must be one of ${CUSTODY_KINDS.filter((k) => k !== 'created').join(', ')}`);
    const lot = await this.findLot(o.lot, o.orgId);
    if (o.clientRef) {
      const dup = (await this.q(`SELECT * FROM custody_events WHERE org_id = $1 AND client_ref = $2`, [lot.org_id, o.clientRef])).rows[0];
      if (dup) return dup;
    }
    if (o.siteId) await this.assertSite(o.siteId, lot.org_id);
    let stackId: string | null = null;
    if (o.stack && o.siteId) {
      const [zone, stack] = o.stack.split('/');
      stackId = (await this.q(`SELECT st.id FROM stacks st JOIN zones z ON z.id = st.zone_id WHERE z.site_id = $1 AND z.code = $2 AND st.code = $3`, [o.siteId, zone, stack])).rows[0]?.id ?? null;
      if (!stackId) throw new QualityError(400, 'invalid_stack', `No stack ${o.stack} on that site`);
    }
    if (o.kind === 'merged') {
      for (const code of o.mergeFrom ?? []) {
        const src = await this.findLot(code, lot.org_id);
        await this.q(`UPDATE lots SET status = 'closed' WHERE id = $1`, [src.id]);
        await this.q(`UPDATE lots SET parent_ids = array_append(parent_ids, $2) WHERE id = $1 AND NOT ($2 = ANY(parent_ids))`, [lot.id, src.id]);
      }
    }
    const ev = (await this.q(
      `INSERT INTO custody_events (org_id, lot_id, kind, site_id, stack_id, counterparty, quantity, note, lat, lng, at, recorded_by, client_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11, now()),$12,$13) RETURNING *`,
      [lot.org_id, lot.id, o.kind, o.siteId ?? null, stackId, o.counterparty ?? null, o.quantity ?? null, o.note ?? null, o.lat ?? null, o.lng ?? null, o.at ?? null, o.by, o.clientRef ?? null])).rows[0];
    const status = o.kind === 'stored' || o.kind === 'received' ? 'stored' : o.kind === 'dispatched' ? 'dispatched' : o.kind === 'delivered' ? 'closed' : null;
    await this.q(`UPDATE lots SET site_id = coalesce($2, site_id), stack_id = CASE WHEN $2::uuid IS NOT NULL THEN $3 ELSE stack_id END,
                  status = coalesce($4, status), quantity = CASE WHEN $5::numeric IS NOT NULL AND $6 IN ('aggregated','received','merged') THEN $5 ELSE quantity END WHERE id = $1`,
      [lot.id, o.siteId ?? null, stackId, status, o.quantity ?? null, o.kind]);
    return ev;
  }

  // ---------- Tests ----------
  async recordTest(o: { orgId: string; lot?: string | null; specId?: string | null; siteId?: string | null; deviceId?: string | null; sampleRef?: string | null; commodity?: string | null; results: unknown; lat?: number | null; lng?: number | null; testedAt?: Date | null; by: string; clientRef?: string | null; deviceSeq?: number | null }) {
    if (o.clientRef) {
      const dup = (await this.q(`SELECT * FROM quality_tests WHERE org_id = $1 AND client_ref = $2`, [o.orgId, o.clientRef])).rows[0];
      if (dup) return dup;
    }
    const results = cleanResults(o.results);
    const lot = o.lot ? await this.findLot(o.lot, o.orgId) : null;
    const spec = o.specId ? (await this.q(`SELECT * FROM quality_specs WHERE id = $1 AND org_id = $2`, [isUuid(o.specId) ? o.specId : null, o.orgId])).rows[0] : null;
    if (o.specId && !spec) throw new QualityError(400, 'invalid_spec', 'Unknown spec');
    if (o.siteId) await this.assertSite(o.siteId, o.orgId);
    const commodity = (o.commodity ?? spec?.commodity ?? lot?.commodity ?? '').toLowerCase();
    if (!commodity) throw new QualityError(400, 'invalid_request', 'commodity is required');
    const { outcome, failures } = evaluate(spec ? spec.parameters : null, results);
    const test = (await this.q(
      `INSERT INTO quality_tests (org_id, lot_id, spec_id, site_id, device_id, sample_ref, commodity, results, outcome, failures, lat, lng, tested_at, tested_by, client_ref, device_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13, now()),$14,$15,$16) ON CONFLICT (org_id, client_ref) DO NOTHING RETURNING *`,
      [o.orgId, lot?.id ?? null, spec?.id ?? null, o.siteId ?? lot?.site_id ?? null, o.deviceId ?? null, o.sampleRef ?? null, commodity, JSON.stringify(results), outcome, JSON.stringify(failures),
        o.lat ?? null, o.lng ?? null, o.testedAt ?? null, o.by, o.clientRef ?? null, o.deviceSeq ?? null])).rows[0];
    if (!test) return (await this.q(`SELECT * FROM quality_tests WHERE org_id = $1 AND client_ref = $2`, [o.orgId, o.clientRef])).rows[0];
    if (lot) {
      await this.q(`INSERT INTO custody_events (org_id, lot_id, kind, site_id, note, lat, lng, at, recorded_by) VALUES ($1,$2,'tested',$3,$4,$5,$6,$7,$8)`,
        [o.orgId, lot.id, test.site_id, `${outcome.toUpperCase()}${spec ? ` against ${spec.name}` : ''}${failures.length ? ': ' + failures.map((f) => `${f.key} ${f.reason}`).join(', ') : ''}`, o.lat ?? null, o.lng ?? null, test.tested_at, o.by]);
    }
    return test;
  }

  async listTests(orgId: string | null, f: { lotId?: string | null; siteId?: string | null; outcome?: string | null; from?: Date | null; to?: Date | null; limit?: number } = {}) {
    return (await this.q(
      `SELECT t.*, l.code AS lot_code, s.name AS spec_name, si.name AS site_name
       FROM quality_tests t LEFT JOIN lots l ON l.id = t.lot_id LEFT JOIN quality_specs s ON s.id = t.spec_id LEFT JOIN sites si ON si.id = t.site_id
       WHERE ($1::uuid IS NULL OR t.org_id = $1) AND ($2::uuid IS NULL OR t.lot_id = $2) AND ($3::uuid IS NULL OR t.site_id = $3)
         AND ($4::text IS NULL OR t.outcome = $4) AND ($5::timestamptz IS NULL OR t.tested_at >= $5) AND ($6::timestamptz IS NULL OR t.tested_at < $6)
       ORDER BY t.tested_at DESC LIMIT $7`,
      [orgId, f.lotId ?? null, f.siteId ?? null, f.outcome ?? null, f.from ?? null, f.to ?? null, Math.min(f.limit ?? 500, 50_000)])).rows;
  }

  /** Everything known about a lot: origin, merged parents, tests, custody and storage conditions. */
  async trace(code: string, orgId: string | null) {
    const lot = await this.findLot(code, orgId);
    const parentIds: string[] = Array.isArray(lot.parent_ids) ? lot.parent_ids : [];
    const parents = parentIds.length
      ? (await this.q(`SELECT id, code, commodity, quantity, unit, origin, origin_lat, origin_lng, harvested_on FROM lots WHERE id = ANY($1::uuid[])`, [parentIds])).rows : [];
    const events = (await this.q(
      `SELECT e.*, s.name AS site_name, st.code AS stack_code FROM custody_events e LEFT JOIN sites s ON s.id = e.site_id LEFT JOIN stacks st ON st.id = e.stack_id
       WHERE e.lot_id = ANY($1::uuid[]) ORDER BY e.at`, [[lot.id, ...parentIds]])).rows;
    const tests = await this.listTests(lot.org_id, { lotId: lot.id, limit: 200 });
    // Storage periods: from each stored/received event to the next move/dispatch.
    const storage: { siteId: string; siteName: string; from: string; to: string; conditions: any[] }[] = [];
    const mine = events.filter((e) => e.lot_id === lot.id);
    mine.forEach((e, i) => {
      if (!['stored', 'received'].includes(e.kind) || !e.site_id) return;
      const end = mine.slice(i + 1).find((x) => ['moved', 'dispatched', 'delivered', 'stored', 'received'].includes(x.kind));
      storage.push({ siteId: e.site_id, siteName: e.site_name, from: new Date(e.at).toISOString(), to: end ? new Date(end.at).toISOString() : new Date().toISOString(), conditions: [] });
    });
    for (const s of storage) {
      s.conditions = (await this.q(
        `SELECT metric, round(min(value)::numeric, 2) AS min, round(max(value)::numeric, 2) AS max, round(avg(value)::numeric, 2) AS avg, count(*)::int AS readings
         FROM readings WHERE site_id = $1 AND time >= $2 AND time < $3 AND quality <> 'rejected'
           AND metric IN ('produce.moisture','air.temperature','air.humidity','produce.emc')
         GROUP BY metric ORDER BY metric`, [s.siteId, s.from, s.to])).rows;
    }
    return { lot, parents, events, tests, storage };
  }

  // ---------- GradeGuard devices ----------
  async onMessage(device: Device, kind: MessageKind, body: Body, time: Date, rows: ReadingRow[]) {
    if (kind !== 'telemetry' || !body.qt || typeof body.qt !== 'object') return;
    const results: Record<string, number> = {};
    for (const r of rows) if (r.metric.startsWith('sample.') && r.quality !== 'rejected') results[r.metric.slice(7)] = r.value;
    if (!Object.keys(results).length) return;
    const qt = body.qt;
    let lot: string | null = typeof qt.lot === 'string' && qt.lot ? qt.lot : null;
    if (lot && !(await this.q(`SELECT 1 FROM lots WHERE org_id = $1 AND code = upper($2)`, [device.orgId, lot])).rows.length) lot = null;
    const spec = typeof qt.spec === 'string' && isUuid(qt.spec) && (await this.q(`SELECT 1 FROM quality_specs WHERE id = $1 AND org_id = $2`, [qt.spec, device.orgId])).rows.length ? qt.spec : null;
    const commodity = spec ? null : lot ? null : 'unspecified';
    await this.recordTest({
      orgId: device.orgId, lot, specId: spec, siteId: device.siteId, deviceId: device.id, sampleRef: typeof qt.sample === 'string' ? qt.sample.slice(0, 60) : null,
      commodity, results, lat: Number.isFinite(qt.lat) ? qt.lat : null, lng: Number.isFinite(qt.lng) ? qt.lng : null, testedAt: time,
      by: `device:${device.id}`, clientRef: `dev:${device.id}:${body.seq}`, deviceSeq: body.seq,
    });
  }
}

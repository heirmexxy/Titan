import type { AggregatedReading, Alert } from '../store/types.js';

export interface MetricSummary {
  metric: string;
  channel: string;
  min: number;
  max: number;
  avg: number;
  readings: number;
  first: string;
  last: string;
}

export interface ConditionReport {
  from: string;
  to: string;
  scope: { zone: string | null; stack: string | null };
  bucket: '1h' | '1d';
  completeness: number; // share of buckets in the window that have any reading, 0..1
  metrics: MetricSummary[];
  alerts: { total: number; critical: number; byCode: Record<string, number>; items: Pick<Alert, 'id' | 'code' | 'severity' | 'title' | 'channel' | 'openedAt' | 'resolvedAt' | 'status'>[] };
  integrity: { unverifiedMessagesRejected: number; note: string };
  crop: { crop: string; safeMoisture: number | null; maxMoisture: number | null; exceededSafeMoisture: boolean | null } | null;
}

/** Which channels belong to a zone/stack scope: stack-level produce readings, plus zone-level air readings. */
export function inScope(channel: string, metric: string, zone: string | null, stack: string | null): boolean {
  if (!zone) return true;
  const seg = channel.split('/');
  if (seg[0] !== zone) return false;
  if (!stack) return true;
  if (seg[1] === stack) return true;
  // zone-level sensors (zone/sensor) count for every stack in the zone, except produce readings, which are per stack
  return seg.length === 2 && !metric.startsWith('produce.');
}

export function buildConditionReport(
  rows: AggregatedReading[],
  alerts: Alert[],
  o: { from: Date; to: Date; bucket: '1h' | '1d'; zone: string | null; stack: string | null; crop: { crop: string; safeMoisture: number | null } | null },
): ConditionReport {
  const scoped = rows.filter((r) => inScope(r.channel, r.metric, o.zone, o.stack));
  const groups = new Map<string, { metric: string; channel: string; min: number; max: number; sum: number; n: number; first: Date; last: Date }>();
  const buckets = new Set<number>();
  for (const r of scoped) {
    buckets.add(r.time.getTime());
    const k = `${r.metric}|${r.channel}`;
    const g = groups.get(k) ?? { metric: r.metric, channel: r.channel, min: Infinity, max: -Infinity, sum: 0, n: 0, first: r.time, last: r.time };
    g.min = Math.min(g.min, r.min);
    g.max = Math.max(g.max, r.max);
    g.sum += r.avg * r.count;
    g.n += r.count;
    if (r.time < g.first) g.first = r.time;
    if (r.time > g.last) g.last = r.time;
    groups.set(k, g);
  }
  const size = o.bucket === '1h' ? 3_600_000 : 86_400_000;
  const expected = Math.max(1, Math.ceil((o.to.getTime() - o.from.getTime()) / size));
  const round = (x: number) => Math.round(x * 100) / 100;

  const metrics = [...groups.values()]
    .sort((a, b) => a.metric.localeCompare(b.metric) || a.channel.localeCompare(b.channel))
    .map((g) => ({ metric: g.metric, channel: g.channel, min: round(g.min), max: round(g.max), avg: round(g.sum / g.n), readings: g.n, first: g.first.toISOString(), last: g.last.toISOString() }));

  const scopedAlerts = alerts.filter((a) => !a.channel || inScope(a.channel, 'zone-level', o.zone, o.stack));
  const byCode: Record<string, number> = {};
  for (const a of scopedAlerts) byCode[a.code] = (byCode[a.code] ?? 0) + 1;

  let crop: ConditionReport['crop'] = null;
  if (o.crop) {
    const moist = metrics.filter((m) => m.metric === 'produce.moisture');
    const maxMoisture = moist.length ? Math.max(...moist.map((m) => m.max)) : null;
    crop = {
      crop: o.crop.crop,
      safeMoisture: o.crop.safeMoisture,
      maxMoisture,
      exceededSafeMoisture: maxMoisture === null || o.crop.safeMoisture === null ? null : maxMoisture > o.crop.safeMoisture,
    };
  }

  return {
    from: o.from.toISOString(),
    to: o.to.toISOString(),
    scope: { zone: o.zone, stack: o.stack },
    bucket: o.bucket,
    completeness: round(Math.min(1, buckets.size / expected)),
    metrics,
    alerts: {
      total: scopedAlerts.length,
      critical: scopedAlerts.filter((a) => a.severity === 'critical').length,
      byCode,
      items: scopedAlerts.map(({ id, code, severity, title, channel, openedAt, resolvedAt, status }) => ({ id, code, severity, title, channel, openedAt, resolvedAt, status })),
    },
    integrity: {
      unverifiedMessagesRejected: byCode['tamper'] ?? 0,
      note: 'Every stored reading passed device signature verification; any reading can be re-checked with GET /v1/readings/proof.',
    },
    crop,
  };
}

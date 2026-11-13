/** Pure analysis used by the operations agent. No database access here, so every rule is unit-tested. */

// ---------- Incidents: group alerts by likely cause ----------

export interface OpenAlert {
  id: string; orgId: string; siteId: string | null; siteName?: string | null; deviceId: string | null;
  code: string; severity: string; metric?: string | null; openedAt: Date;
}
export interface DeviceInfo { id: string; siteId: string | null; gatewayId: string | null; typeId: string; status: string }
export interface SiteEvent { siteId: string | null; deviceId: string; code: string; time: Date }

export interface IncidentDraft {
  key: string; orgId: string; siteId: string | null; cause: 'gateway_down' | 'power_outage' | 'site_connectivity' | 'site_condition';
  title: string; summary: string; alertIds: string[]; deviceIds: string[]; severity: 'warning' | 'critical'; openedAt: Date;
}

const WINDOW_MS = 15 * 60_000;
const sevMax = (alerts: OpenAlert[]) => (alerts.some((a) => a.severity === 'critical') ? 'critical' : 'warning') as 'warning' | 'critical';
const earliest = (alerts: OpenAlert[]) => new Date(Math.min(...alerts.map((a) => a.openedAt.getTime())));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Splits alerts into clusters whose opening times are each within `WINDOW_MS` of the previous one. */
function clusters(alerts: OpenAlert[]): OpenAlert[][] {
  const sorted = [...alerts].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  const out: OpenAlert[][] = [];
  for (const a of sorted) {
    const last = out.at(-1);
    if (last && a.openedAt.getTime() - last.at(-1)!.openedAt.getTime() <= WINDOW_MS) last.push(a);
    else out.push([a]);
  }
  return out;
}

/**
 * Groups open alerts into incidents with a probable cause:
 * 1. Nodes behind one LoRa gateway going offline together → the gateway.
 * 2. Several devices at one site going offline together → power (if a power_lost event or mains reading says so) or connectivity.
 * 3. The same reading breaching limits on several devices or channels at one site → a site-wide condition.
 * Alerts that don't group stay as single alerts.
 */
export function correlate(alerts: OpenAlert[], devices: Map<string, DeviceInfo>, events: SiteEvent[]): IncidentDraft[] {
  const out: IncidentDraft[] = [];
  const used = new Set<string>();
  const offline = alerts.filter((a) => a.code === 'device_offline' && a.deviceId);

  // 1. Gateways
  const byGateway = new Map<string, OpenAlert[]>();
  for (const a of offline) {
    const d = devices.get(a.deviceId!);
    const gw = d?.gatewayId ?? (d?.typeId === 'titan-lora-gateway-v1' ? d.id : null);
    if (gw) byGateway.set(gw, [...(byGateway.get(gw) ?? []), a]);
  }
  for (const [gw, list] of byGateway) {
    const nodes = list.filter((a) => a.deviceId !== gw);
    const gatewayItself = list.some((a) => a.deviceId === gw);
    if (nodes.length < 2 && !(gatewayItself && nodes.length >= 1)) continue;
    const site = list[0];
    out.push({
      key: `gateway_down:${gw}`, orgId: site.orgId, siteId: site.siteId, cause: 'gateway_down',
      title: `LoRa gateway ${gw} looks down${site.siteName ? ` at ${site.siteName}` : ''}`,
      summary: `${plural(nodes.length, 'node')} that report through ${gw} went offline${gatewayItself ? ', and the gateway itself is offline' : ' at about the same time'}. Check the gateway's power and internet before visiting the nodes.`,
      alertIds: list.map((a) => a.id), deviceIds: list.map((a) => a.deviceId!), severity: 'warning', openedAt: earliest(list),
    });
    list.forEach((a) => used.add(a.id));
  }

  // 2. Site-wide offline
  const bySite = new Map<string, OpenAlert[]>();
  for (const a of offline) if (!used.has(a.id) && a.siteId) bySite.set(a.siteId, [...(bySite.get(a.siteId) ?? []), a]);
  for (const [siteId, list] of bySite) {
    for (const c of clusters(list)) {
      if (c.length < 2) continue;
      const from = earliest(c).getTime() - WINDOW_MS, to = earliest(c).getTime() + WINDOW_MS;
      const power = events.some((e) => e.siteId === siteId && e.code === 'power_lost' && e.time.getTime() >= from && e.time.getTime() <= to);
      const name = c[0].siteName ?? 'the site';
      out.push({
        key: `${power ? 'power_outage' : 'site_connectivity'}:${siteId}`, orgId: c[0].orgId, siteId,
        cause: power ? 'power_outage' : 'site_connectivity',
        title: power ? `Power is out at ${name}` : `${name} has lost its connection`,
        summary: power
          ? `${plural(c.length, 'device')} went offline within minutes of each other, and a device reported mains power lost. The generator or mains supply is the likely cause.`
          : `${plural(c.length, 'device')} went offline within minutes of each other with no power-loss report. The site's internet or GSM coverage is the likely cause; the devices keep recording and will send their readings when they reconnect.`,
        alertIds: c.map((a) => a.id), deviceIds: c.map((a) => a.deviceId!), severity: power ? 'critical' : 'warning', openedAt: earliest(c),
      });
      c.forEach((a) => used.add(a.id));
    }
  }

  // 3. Site-wide condition (same metric, several devices or channels)
  const byMetric = new Map<string, OpenAlert[]>();
  for (const a of alerts) {
    if (used.has(a.id) || a.code !== 'threshold' || !a.metric || !a.siteId) continue;
    const k = `${a.siteId}|${a.metric}`;
    byMetric.set(k, [...(byMetric.get(k) ?? []), a]);
  }
  for (const [k, list] of byMetric) {
    if (list.length < 2) continue;
    const [siteId, metric] = k.split('|');
    const name = list[0].siteName ?? 'the site';
    out.push({
      key: `site_condition:${siteId}:${metric}`, orgId: list[0].orgId, siteId, cause: 'site_condition',
      title: `${metric} out of range across ${name}`,
      summary: `${plural(list.length, 'alert')} for ${metric} are open at ${name} at once. This points to a site-wide condition (weather, ventilation, a door left open) rather than one faulty sensor.`,
      alertIds: list.map((a) => a.id), deviceIds: [...new Set(list.map((a) => a.deviceId).filter(Boolean) as string[])], severity: sevMax(list), openedAt: earliest(list),
    });
  }
  return out;
}

// ---------- Sensor health ----------

export interface Sample { time: Date; value: number }

/** Per-metric limits: how flat is "stuck", how big a jump is a "spike", how far from peers is "drift". */
export const HEALTH_LIMITS: Record<string, { flat: number; jump: number; drift: number }> = {
  'air.temperature': { flat: 0.05, jump: 8, drift: 2 },
  'air.humidity': { flat: 0.1, jump: 25, drift: 8 },
  'produce.moisture': { flat: 0.01, jump: 3, drift: 1 },
  'produce.temperature': { flat: 0.05, jump: 8, drift: 2 },
  'water.do': { flat: 0.01, jump: 4, drift: 1 },
  'water.ph': { flat: 0.005, jump: 1.5, drift: 0.4 },
  'water.temperature': { flat: 0.05, jump: 5, drift: 1.5 },
  'kiln.temperature': { flat: 0.5, jump: 300, drift: 60 },
  'stove.temperature': { flat: 0.05, jump: 200, drift: 15 },
};

/** A sensor that reports the same value for a day is usually disconnected, frozen or covered. */
export function isStuck(samples: Sample[], metric: string, minSamples = 20): { stuck: boolean; value?: number } {
  const lim = HEALTH_LIMITS[metric];
  if (!lim || samples.length < minSamples) return { stuck: false };
  const vals = samples.map((s) => s.value);
  const range = Math.max(...vals) - Math.min(...vals);
  return range <= lim.flat ? { stuck: true, value: vals[0] } : { stuck: false };
}

/** Jumps between consecutive readings (within 10 minutes) that are physically implausible. */
export function countSpikes(samples: Sample[], metric: string): number {
  const lim = HEALTH_LIMITS[metric];
  if (!lim) return 0;
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].time.getTime() - samples[i - 1].time.getTime();
    if (dt > 0 && dt <= 10 * 60_000 && Math.abs(samples[i].value - samples[i - 1].value) > lim.jump) n++;
  }
  return n;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Drift against peers: for a metric with 3+ channels at one site, each channel's offset from the peer
 * median this week vs last week. A sensor whose offset moved by more than the drift limit is drifting
 * (peers cancel out weather and seasons).
 */
export function findDrift(metric: string, lastWeek: Record<string, number>, thisWeek: Record<string, number>) {
  const lim = HEALTH_LIMITS[metric];
  const channels = Object.keys(thisWeek).filter((c) => c in lastWeek);
  if (!lim || channels.length < 3) return [];
  const out: { channel: string; before: number; after: number; shift: number }[] = [];
  for (const c of channels) {
    const peersNow = channels.filter((x) => x !== c).map((x) => thisWeek[x]);
    const peersBefore = channels.filter((x) => x !== c).map((x) => lastWeek[x]);
    const before = lastWeek[c] - median(peersBefore);
    const after = thisWeek[c] - median(peersNow);
    const shift = after - before;
    if (Math.abs(shift) > lim.drift) out.push({ channel: c, before: round(before), after: round(after), shift: round(shift) });
  }
  return out;
}

/** Sequence numbers are never reused by healthy firmware; a drop means a reflash, a reset that lost state, or a cloned device. */
export function seqResets(seqsInReceiveOrder: number[]): number {
  let n = 0;
  for (let i = 1; i < seqsInReceiveOrder.length; i++) if (seqsInReceiveOrder[i] < seqsInReceiveOrder[i - 1] - 1000) n++;
  return n;
}

const round = (x: number) => Math.round(x * 100) / 100;

// ---------- Carbon readiness ----------

export interface ReadinessItem { ok: boolean; level: 'blocker' | 'warning' | 'info'; label: string; detail?: string }

export function biocharReadiness(a: {
  status: string; result: any; measurements: { kind: string; documentSha256: string | null; supersedesId: string | null }[];
  kiln: { readings: number; minutes: number; gaps: number; estimatedTime: number; buffered: number };
  params: Record<string, unknown>; signedDevice: boolean;
}): ReadinessItem[] {
  const has = (k: string) => a.measurements.some((m) => m.kind === k);
  const cert = (k: string) => a.measurements.filter((m) => m.kind === k).every((m) => !!m.documentSha256);
  const items: ReadinessItem[] = [
    { ok: a.status !== 'open', level: 'blocker', label: 'Batch is closed', detail: a.status === 'open' ? 'End the batch first.' : undefined },
    { ok: a.result?.status === 'ok', level: 'blocker', label: 'Calculation complete', detail: a.result?.status && a.result.status !== 'ok' ? `${a.result.status}: ${[...(a.result.missing ?? []), ...(a.result.problems ?? [])].join('; ')}` : a.result ? undefined : 'Not calculated yet.' },
    { ok: has('lab.organic_carbon_pct') && has('lab.h_corg'), level: 'blocker', label: 'Lab results for organic carbon and H/Corg' },
    { ok: cert('lab.organic_carbon_pct') && cert('lab.h_corg'), level: 'blocker', label: 'Lab certificates fingerprinted', detail: 'Each lab result should carry the SHA-256 of its certificate file.' },
    { ok: has('biochar.moisture_pct'), level: 'blocker', label: 'Biochar moisture recorded' },
    { ok: a.kiln.readings > 0 && a.kiln.gaps === 0, level: a.kiln.readings ? 'warning' : 'blocker', label: 'Continuous kiln temperature record',
      detail: a.kiln.readings ? (a.kiln.gaps ? `${a.kiln.gaps} gap(s) of more than 5 minutes in ${a.kiln.minutes} minutes of record.` : undefined) : 'No kiln readings in the batch window.' },
    { ok: a.kiln.estimatedTime === 0, level: 'warning', label: 'Device clock was set', detail: a.kiln.estimatedTime ? `${a.kiln.estimatedTime} readings have estimated times.` : undefined },
    { ok: a.signedDevice, level: 'warning', label: 'Readings signed by the device\'s own key (Ed25519)', detail: a.signedDevice ? undefined : 'Some readings came from a shared-secret device.' },
    { ok: typeof a.params.emissionsTco2ePerT === 'number', level: 'warning', label: 'Project emissions parameter set', detail: 'Without it, emissions are counted as zero.' },
    { ok: typeof a.params.bufferPct === 'number', level: 'info', label: 'Buffer percentage set' },
  ];
  return items;
}

export function readinessStatus(items: ReadinessItem[]): 'ready' | 'needs_attention' | 'blocked' {
  if (items.some((i) => !i.ok && i.level === 'blocker')) return 'blocked';
  if (items.some((i) => !i.ok && i.level === 'warning')) return 'needs_attention';
  return 'ready';
}

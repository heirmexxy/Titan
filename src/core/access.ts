import type { Grant, Store } from '../store/types.js';

export interface SiteAccess {
  owned: boolean;
  /** null = every metric */
  metrics: Set<string> | null;
  from: Date | null;
  to: Date | null;
}

/**
 * What an organisation may read: its own sites in full, plus sites shared with it through grants.
 * Several grants over one site are merged (union of metrics, widest window).
 */
export async function resolveAccess(store: Store, orgId: string): Promise<Map<string, SiteAccess>> {
  const access = new Map<string, SiteAccess>();
  for (const s of await store.listSitesForOrg(orgId)) access.set(s.id, { owned: true, metrics: null, from: null, to: null });

  const grants = await store.listActiveGrantsFor(orgId);
  const allSitesOwners = new Map<string, Grant[]>();
  for (const g of grants) {
    if (g.siteIds) for (const id of g.siteIds) merge(access, id, g);
    else allSitesOwners.set(g.ownerOrgId, [...(allSitesOwners.get(g.ownerOrgId) ?? []), g]);
  }
  for (const [owner, gs] of allSitesOwners) {
    for (const s of await store.listSitesForOrg(owner)) for (const g of gs) merge(access, s.id, g);
  }
  return access;
}

function merge(access: Map<string, SiteAccess>, siteId: string, g: Grant) {
  const cur = access.get(siteId);
  if (cur?.owned) return;
  const metrics = g.metrics ? new Set(g.metrics) : null;
  if (!cur) {
    access.set(siteId, { owned: false, metrics, from: g.validFrom, to: g.validTo });
    return;
  }
  cur.metrics = cur.metrics === null || metrics === null ? null : new Set([...cur.metrics, ...metrics]);
  cur.from = cur.from === null || g.validFrom === null ? null : (g.validFrom < cur.from ? g.validFrom : cur.from);
  cur.to = cur.to === null || g.validTo === null ? null : (g.validTo > cur.to ? g.validTo : cur.to);
}

/** Clamps a requested window and metric list to what the access allows. Returns null if nothing is visible. */
export function clampQuery(a: SiteAccess, from: Date, to: Date, metrics?: string[]): { from: Date; to: Date; metrics?: string[] } | null {
  const f = a.from && a.from > from ? a.from : from;
  const t = a.to && a.to < to ? a.to : to;
  if (f > t) return null;
  let m = metrics;
  if (a.metrics) {
    m = (metrics ?? [...a.metrics]).filter((x) => a.metrics!.has(x));
    if (!m.length) return null;
  }
  return { from: f, to: t, metrics: m };
}

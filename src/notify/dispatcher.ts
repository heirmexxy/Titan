import { webhookSignature } from '../core/crypto.js';
import type { Notifier } from '../ingest/pipeline.js';
import type { Alert, Grant, Store } from '../store/types.js';
import type { EmailSender, SmsSender } from './providers.js';

const SEV_RANK = { info: 0, warning: 1, critical: 2 } as const;
const MAX_ATTEMPTS = 6;

function grantCovers(g: Grant, siteId: string | null, at = new Date()): boolean {
  if (!g.live) return false;
  if (g.validTo && g.validTo < at) return false;
  if (g.validFrom && g.validFrom > at) return false;
  if (g.siteIds && (!siteId || !g.siteIds.includes(siteId))) return false;
  return true;
}

/** Filters an event payload down to what a grantee may see. Returns null if nothing is left. */
function scopeForGrant(event: string, data: any, g: Grant): unknown | null {
  if (!g.metrics) return data;
  if (event === 'reading.created') {
    const readings = (data.readings ?? []).filter((r: any) => g.metrics!.includes(r.metric));
    return readings.length ? { ...data, readings } : null;
  }
  return data;
}

export class Dispatcher implements Notifier {
  constructor(private store: Store, private email: EmailSender, private sms: SmsSender, private publicUrl: string) {}

  async emit(event: string, ctx: { orgId: string; siteId: string | null }, data: unknown): Promise<void> {
    // Webhooks: the owner, plus every organisation holding a live grant over this site.
    const targets: { orgId: string; payload: unknown }[] = [{ orgId: ctx.orgId, payload: data }];
    for (const g of await this.store.listActiveGrantsFrom(ctx.orgId)) {
      if (!grantCovers(g, ctx.siteId)) continue;
      const scoped = scopeForGrant(event, data, g);
      if (scoped !== null) targets.push({ orgId: g.granteeOrgId, payload: scoped });
    }
    const hooks = await this.store.listWebhooks([...new Set(targets.map((t) => t.orgId))], event);
    for (const h of hooks) {
      const payload = targets.find((t) => t.orgId === h.orgId)!.payload;
      await this.store.enqueueDelivery(h.id, event, { event, created_at: new Date().toISOString(), data: payload });
    }

    if (event === 'alert.opened' || event === 'alert.resolved') await this.notifyPeople(event, data as Alert);
  }

  private async notifyPeople(event: string, a: Alert) {
    const contacts = (await this.store.listContacts(a.orgId)).filter(
      (c) => SEV_RANK[a.severity] >= SEV_RANK[c.minSeverity] && (!c.siteId || c.siteId === a.siteId),
    );
    if (!contacts.length) return;
    const resolved = event === 'alert.resolved';
    const head = resolved ? `Resolved: ${a.title}` : `${a.severity.toUpperCase()}: ${a.title}`;
    const when = (resolved ? a.resolvedAt : a.openedAt)?.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const text = `${head}\nDevice: ${a.deviceId ?? '-'}${a.channel ? ` (${a.channel})` : ''}\nTime: ${when}\n${this.publicUrl}/admin/alerts/${a.id}`;
    for (const c of contacts) {
      if (c.channel === 'email') await this.email.send(c.address, `[Titan] ${head}`, text);
      else await this.sms.send(c.address, `Titan ${head}. ${a.deviceId ?? ''} ${when}`.slice(0, 300));
    }
  }

  /** Delivers due webhooks with exponential backoff (1m, 2m, 4m… up to MAX_ATTEMPTS). */
  async deliverDue(now = new Date()): Promise<number> {
    const due = await this.store.dueDeliveries(now, 50);
    for (const d of due) {
      const body = JSON.stringify(d.body);
      let ok = false;
      let status: number | null = null;
      try {
        const res = await fetch(d.webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Titan-Event': d.event, 'X-Titan-Signature': webhookSignature(d.webhook.secret, body) },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        ok = res.ok;
      } catch {
        ok = false;
      }
      const attempts = d.attempts + 1;
      const next = ok || attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + 60_000 * 2 ** (attempts - 1));
      await this.store.recordDelivery(d.id, ok, status, next);
      await this.store.addUsage(d.webhook.orgId, now.toISOString().slice(0, 10), { webhooks: 1 });
    }
    return due.length;
  }
}

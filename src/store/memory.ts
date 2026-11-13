import { randomUUID } from 'node:crypto';
import type { DeviceKeyRecord } from '../core/envelope.js';
import type { AlertRule, RuleState } from '../core/rules.js';
import type {
  AggregatedReading, Alert, ApiKey, Contact, CropProfile, Device, EventRow, Grant, MessageRow, Metric, Plan, ReadingRow,
  ReadingsQuery, Site, Store, UsageDelta, Webhook,
} from './types.js';

const BUCKET_MS = { '1m': 60_000, '1h': 3_600_000, '1d': 86_400_000 } as const;

/** In-memory store used by tests and local experiments. Not for production. */
export class MemoryStore implements Store {
  devices = new Map<string, Device>();
  keys = new Map<string, DeviceKeyRecord>();
  metrics = new Map<string, Metric>();
  zoneCrops = new Map<string, Map<string, { stack: string; crop: CropProfile }[]>>();
  messages = new Map<string, MessageRow>();
  readings: ReadingRow[] = [];
  events: EventRow[] = [];
  rules: AlertRule[] = [];
  ruleStates = new Map<string, RuleState>();
  alerts: Alert[] = [];
  contacts = new Map<string, Contact[]>();
  apiKeys = new Map<string, ApiKey>();
  sites: Site[] = [];
  grants: Grant[] = [];
  webhooks: Webhook[] = [];
  deliveries: { id: string; webhookId: string; event: string; body: unknown; attempts: number; status: string; next: Date }[] = [];
  usage = new Map<string, Required<UsageDelta>>();
  activeDevices = new Set<string>();
  plans: Plan[] = [];
  configs: { deviceId: string; version: number; doc: Record<string, unknown> }[] = [];
  demos: unknown[] = [];
  auditLog: unknown[] = [];

  async getDevice(id: string) { return this.devices.get(id) ?? null; }
  async getDeviceKey(deviceId: string, keyId: string) { return this.keys.get(`${deviceId}/${keyId}`) ?? null; }
  async addDeviceKey(deviceId: string, key: DeviceKeyRecord) { this.keys.set(`${deviceId}/${key.keyId}`, key); }
  async countDeviceKeys(deviceId: string) { return [...this.keys.keys()].filter((k) => k.startsWith(`${deviceId}/`)).length; }
  async completeProvisioning(deviceId: string, tokenHash: string) {
    const d = this.devices.get(deviceId)!;
    Object.assign(d, { tokenHash, provisionCodeHash: null, provisionExpiresAt: null });
  }
  async setProvisionCode(deviceId: string, codeHash: string, expiresAt: Date) {
    Object.assign(this.devices.get(deviceId)!, { provisionCodeHash: codeHash, provisionExpiresAt: expiresAt });
  }
  async getMetrics() { return this.metrics; }
  async getZoneCrops(siteId: string) { return this.zoneCrops.get(siteId) ?? new Map(); }
  async markDeviceSeen(deviceId: string, at: Date, seq: number | null, _state?: Record<string, unknown>) {
    const d = this.devices.get(deviceId)!;
    const was = d.status;
    d.lastSeenAt = at;
    d.status = 'online';
    return was === 'online' ? 'already_online' as const : 'came_online' as const;
  }
  async markDeviceOffline(deviceId: string) {
    const d = this.devices.get(deviceId);
    if (!d || d.status !== 'online') return false;
    d.status = 'offline';
    return true;
  }
  async listStaleDevices(now: Date) {
    return [...this.devices.values()].filter(
      (d) => d.status === 'online' && d.lastSeenAt && now.getTime() - d.lastSeenAt.getTime() > 3 * d.heartbeatS * 1000,
    );
  }
  async saveConfig(deviceId: string, version: number, doc: Record<string, unknown>) {
    this.configs.push({ deviceId, version, doc });
    this.devices.get(deviceId)!.configVersion = version;
  }
  async ackConfig(deviceId: string, version: number) {
    const d = this.devices.get(deviceId)!;
    d.configAckedVersion = Math.max(d.configAckedVersion, version);
  }

  async insertMessage(m: MessageRow) {
    const k = `${m.deviceId}/${m.seq}`;
    if (this.messages.has(k)) return false;
    this.messages.set(k, m);
    return true;
  }
  async insertReadings(rows: ReadingRow[]) { this.readings.push(...rows); }
  async insertEvent(e: EventRow) { this.events.push(e); }
  async getMessage(deviceId: string, seq: number) { return this.messages.get(`${deviceId}/${seq}`) ?? null; }

  async listRulesFor(orgId: string) { return this.rules.filter((r) => r.orgId === orgId); }
  async getRuleState(ruleId: string, deviceId: string, channel: string) {
    return this.ruleStates.get(`${ruleId}/${deviceId}/${channel}`) ?? { breachSince: null, alertId: null };
  }
  async setRuleState(ruleId: string, deviceId: string, channel: string, s: RuleState) {
    this.ruleStates.set(`${ruleId}/${deviceId}/${channel}`, { ...s });
  }
  async openAlert(a: Omit<Alert, 'id' | 'status' | 'ackedAt' | 'resolvedAt'>) {
    const alert: Alert = { ...a, id: randomUUID(), status: 'open', ackedAt: null, resolvedAt: null };
    this.alerts.push(alert);
    return alert;
  }
  async resolveAlert(id: string, at: Date) {
    const a = this.alerts.find((x) => x.id === id && x.status !== 'resolved');
    if (!a) return null;
    a.status = 'resolved';
    a.resolvedAt = at;
    return a;
  }
  async findOpenAlert(orgId: string, deviceId: string, code: string, channel: string | null) {
    return this.alerts.find((a) => a.orgId === orgId && a.deviceId === deviceId && a.code === code && a.channel === channel && a.status !== 'resolved') ?? null;
  }
  async listAlerts(siteIds: string[], status: string | null, limit: number) {
    return this.alerts.filter((a) => a.siteId && siteIds.includes(a.siteId) && (!status || a.status === status)).slice(-limit).reverse();
  }
  async listContacts(orgId: string) { return this.contacts.get(orgId) ?? []; }

  async getApiKeyByHash(hash: string) { return this.apiKeys.get(hash) ?? null; }
  async touchApiKey() {}
  async createApiKey(orgId: string, _name: string, _prefix: string, hash: string, scopes: string[]) {
    const id = randomUUID();
    this.apiKeys.set(hash, { id, orgId, scopes, revokedAt: null });
    return id;
  }
  async listSitesForOrg(orgId: string) { return this.sites.filter((s) => s.orgId === orgId); }
  async listActiveGrantsFor(granteeOrgId: string) { return this.grants.filter((g) => g.granteeOrgId === granteeOrgId && !g.revokedAt); }
  async listActiveGrantsFrom(ownerOrgId: string) { return this.grants.filter((g) => g.ownerOrgId === ownerOrgId && !g.revokedAt); }
  async createGrant(g: Omit<Grant, 'id' | 'revokedAt'>) {
    const grant = { ...g, id: randomUUID(), revokedAt: null };
    this.grants.push(grant);
    return grant;
  }
  async revokeGrant(id: string, ownerOrgId: string) {
    const g = this.grants.find((x) => x.id === id && x.ownerOrgId === ownerOrgId && !x.revokedAt);
    if (!g) return false;
    g.revokedAt = new Date();
    return true;
  }
  async getSites(ids: string[]) { return this.sites.filter((s) => ids.includes(s.id)); }
  async listDevices(siteIds: string[]) { return [...this.devices.values()].filter((d) => d.siteId && siteIds.includes(d.siteId)); }
  async queryReadings(q: ReadingsQuery): Promise<(ReadingRow | AggregatedReading)[]> {
    const rows = this.readings.filter(
      (r) => r.siteId && q.siteIds.includes(r.siteId) && r.time >= q.from && r.time <= q.to &&
        (!q.deviceId || r.deviceId === q.deviceId) && (!q.metrics || q.metrics.includes(r.metric)) && (!q.channel || r.channel === q.channel) &&
        r.quality !== 'rejected',
    ).sort((a, b) => a.time.getTime() - b.time.getTime());
    if (q.interval === 'raw') return rows.slice(0, q.limit);
    const size = BUCKET_MS[q.interval];
    const buckets = new Map<string, AggregatedReading & { sum: number }>();
    for (const r of rows) {
      const t = new Date(Math.floor(r.time.getTime() / size) * size);
      const k = `${t.getTime()}|${r.deviceId}|${r.channel}|${r.metric}`;
      const b = buckets.get(k) ?? { time: t, deviceId: r.deviceId, channel: r.channel, metric: r.metric, avg: 0, min: Infinity, max: -Infinity, count: 0, sum: 0 };
      b.sum += r.value; b.count++; b.min = Math.min(b.min, r.value); b.max = Math.max(b.max, r.value); b.avg = b.sum / b.count;
      buckets.set(k, b);
    }
    return [...buckets.values()].map(({ sum: _s, ...b }) => b).slice(0, q.limit);
  }
  async latestReadings(siteIds: string[], metrics?: string[]) {
    const latest = new Map<string, ReadingRow>();
    for (const r of this.readings) {
      if (!r.siteId || !siteIds.includes(r.siteId) || (metrics && !metrics.includes(r.metric)) || r.quality === 'rejected') continue;
      const k = `${r.deviceId}|${r.channel}|${r.metric}`;
      const cur = latest.get(k);
      if (!cur || cur.time <= r.time) latest.set(k, r);
    }
    return [...latest.values()];
  }

  async listWebhooks(orgIds: string[], event: string) {
    return this.webhooks.filter((w) => w.active && orgIds.includes(w.orgId) && w.events.some((e) => e === event || (e.endsWith('.*') && event.startsWith(e.slice(0, -1)))));
  }
  async createWebhook(orgId: string, url: string, events: string[], secret: string) {
    const w = { id: randomUUID(), orgId, url, events, secret, active: true };
    this.webhooks.push(w);
    return w;
  }
  async deleteWebhook(id: string, orgId: string) {
    const w = this.webhooks.find((x) => x.id === id && x.orgId === orgId && x.active);
    if (!w) return false;
    w.active = false;
    return true;
  }
  async listOrgWebhooks(orgId: string) { return this.webhooks.filter((w) => w.orgId === orgId && w.active); }
  async enqueueDelivery(webhookId: string, event: string, body: unknown) {
    const id = randomUUID();
    this.deliveries.push({ id, webhookId, event, body, attempts: 0, status: 'pending', next: new Date(0) });
    return id;
  }
  async dueDeliveries(now: Date, limit: number) {
    return this.deliveries.filter((d) => d.status === 'pending' && d.next <= now).slice(0, limit)
      .map((d) => ({ id: d.id, webhook: this.webhooks.find((w) => w.id === d.webhookId)!, event: d.event, body: d.body, attempts: d.attempts }));
  }
  async recordDelivery(id: string, ok: boolean, _code: number | null, next: Date | null) {
    const d = this.deliveries.find((x) => x.id === id)!;
    d.attempts++;
    d.status = ok ? 'delivered' : next ? 'pending' : 'failed';
    if (next) d.next = next;
  }

  async addUsage(orgId: string, day: string, d: UsageDelta) {
    const k = `${orgId}/${day}`;
    const u = this.usage.get(k) ?? { messages: 0, readings: 0, apiCalls: 0, webhooks: 0 };
    u.messages += d.messages ?? 0; u.readings += d.readings ?? 0; u.apiCalls += d.apiCalls ?? 0; u.webhooks += d.webhooks ?? 0;
    this.usage.set(k, u);
  }
  async markActiveDevice(orgId: string, day: string, deviceId: string) { this.activeDevices.add(`${orgId}/${day}/${deviceId}`); }
  async listPublishedPlans() { return this.plans.filter((p) => p.published); }

  async saveDemoRequest(r: unknown) { this.demos.push(r); }
  async audit(actor: string, orgId: string | null, action: string, target: string | null, detail?: unknown) {
    this.auditLog.push({ actor, orgId, action, target, detail });
  }
}

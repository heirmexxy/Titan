import pg from 'pg';
import type { DeviceKeyRecord } from '../core/envelope.js';
import type { AlertRule, RuleState } from '../core/rules.js';
import type {
  AggregatedReading, Alert, ApiKey, Contact, CropProfile, Device, EventRow, Grant, MessageRow, Metric, Plan, ReadingRow,
  ReadingsQuery, Site, Store, UsageDelta, Webhook,
} from './types.js';

const BUCKET = { '1m': '1 minute', '1h': '1 hour', '1d': '1 day' } as const;
const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));

const deviceRow = (r: any): Device => ({
  id: r.id, orgId: r.org_id, siteId: r.site_id, siteKind: r.site_kind ?? null, typeId: r.type_id, connectivity: r.connectivity,
  tokenHash: r.token_hash, status: r.status, heartbeatS: r.heartbeat_s, lastSeenAt: r.last_seen_at, configVersion: r.config_version,
  configAckedVersion: r.config_acked_version, configOverride: r.config_override ?? {}, typeDefaults: r.type_defaults ?? {},
  provisionCodeHash: r.provision_code_hash, provisionExpiresAt: r.provision_expires_at,
});
const alertRow = (r: any): Alert => ({
  id: r.id, orgId: r.org_id, siteId: r.site_id, deviceId: r.device_id, channel: r.channel, ruleId: r.rule_id, code: r.code,
  severity: r.severity, title: r.title, value: num(r.value), status: r.status, openedAt: r.opened_at, ackedAt: r.acked_at, resolvedAt: r.resolved_at,
});
const readingRow = (r: any): ReadingRow => ({
  time: r.time, orgId: r.org_id, siteId: r.site_id, deviceId: r.device_id, channel: r.channel, metric: r.metric, value: Number(r.value),
  quality: r.quality, flags: r.flags, seq: num(r.seq), cal: r.cal,
});
const grantRow = (r: any): Grant => ({
  id: r.id, ownerOrgId: r.owner_org_id, granteeOrgId: r.grantee_org_id, siteIds: r.site_ids, metrics: r.metrics,
  validFrom: r.valid_from, validTo: r.valid_to, live: r.live, revokedAt: r.revoked_at,
});
const siteRow = (r: any): Site => ({ id: r.id, orgId: r.org_id, name: r.name, kind: r.kind, externalRef: r.external_ref, lat: num(r.lat), lng: num(r.lng) });
const webhookRow = (r: any): Webhook => ({ id: r.id, orgId: r.org_id, url: r.url, events: r.events, secret: r.secret, active: r.active });

export class PostgresStore implements Store {
  private metricsCache: { at: number; map: Map<string, Metric> } | null = null;
  private timescale: boolean | null = null;

  constructor(public pool: pg.Pool) {}

  static fromUrl(url: string) {
    return new PostgresStore(new pg.Pool({ connectionString: url, max: 20 }));
  }

  private q(text: string, values: unknown[] = []) {
    return this.pool.query(text, values);
  }

  async hasTimescale(): Promise<boolean> {
    if (this.timescale === null) {
      const r = await this.q(`SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'`);
      this.timescale = (r.rowCount ?? 0) > 0;
    }
    return this.timescale;
  }

  // ---------- Devices & registry ----------
  async getDevice(id: string) {
    const r = await this.q(
      `SELECT d.*, s.kind AS site_kind, t.defaults AS type_defaults FROM devices d
       LEFT JOIN sites s ON s.id = d.site_id JOIN device_types t ON t.id = d.type_id WHERE d.id = $1`, [id]);
    return r.rows[0] ? deviceRow(r.rows[0]) : null;
  }
  async getDeviceKey(deviceId: string, keyId: string) {
    const r = await this.q(`SELECT key_id, alg, public_key, retired_at FROM device_keys WHERE device_id = $1 AND key_id = $2`, [deviceId, keyId]);
    const k = r.rows[0];
    return k ? { keyId: k.key_id, alg: k.alg, publicKey: k.public_key, retiredAt: k.retired_at } : null;
  }
  async addDeviceKey(deviceId: string, key: DeviceKeyRecord) {
    await this.q(`INSERT INTO device_keys (device_id, key_id, alg, public_key) VALUES ($1,$2,$3,$4)`, [deviceId, key.keyId, key.alg, key.publicKey]);
  }
  async countDeviceKeys(deviceId: string) {
    const r = await this.q(`SELECT count(*)::int AS n FROM device_keys WHERE device_id = $1`, [deviceId]);
    return Number(r.rows[0].n);
  }
  async completeProvisioning(deviceId: string, tokenHash: string) {
    await this.q(`UPDATE devices SET token_hash = $2, provision_code_hash = NULL, provision_expires_at = NULL WHERE id = $1`, [deviceId, tokenHash]);
  }
  async setProvisionCode(deviceId: string, codeHash: string, expiresAt: Date) {
    await this.q(`UPDATE devices SET provision_code_hash = $2, provision_expires_at = $3 WHERE id = $1`, [deviceId, codeHash, expiresAt]);
  }
  async getMetrics() {
    if (this.metricsCache && Date.now() - this.metricsCache.at < 60_000) return this.metricsCache.map;
    const r = await this.q(`SELECT * FROM metrics`);
    const map = new Map<string, Metric>();
    for (const m of r.rows) {
      map.set(m.key, { key: m.key, unit: m.unit, label: m.label, kind: m.kind, minValid: num(m.min_valid), maxValid: num(m.max_valid), derived: m.derived });
    }
    this.metricsCache = { at: Date.now(), map };
    return map;
  }
  async getZoneCrops(siteId: string) {
    const r = await this.q(
      `SELECT z.code AS zone, st.code AS stack, c.* FROM zones z JOIN stacks st ON st.zone_id = z.id
       JOIN crop_profiles c ON c.crop = st.commodity WHERE z.site_id = $1`, [siteId]);
    const out = new Map<string, { stack: string; crop: CropProfile }[]>();
    for (const row of r.rows) {
      const list = out.get(row.zone) ?? [];
      list.push({
        stack: row.stack,
        crop: { crop: row.crop, hendersonK: num(row.henderson_k), hendersonN: num(row.henderson_n), hendersonC: num(row.henderson_c), safeMoisture: num(row.safe_moisture) },
      });
      out.set(row.zone, list);
    }
    return out;
  }
  async markDeviceSeen(deviceId: string, at: Date, seq: number | null, state?: Record<string, unknown>) {
    const r = await this.q(
      `WITH o AS (SELECT status FROM devices WHERE id = $1 FOR UPDATE)
       UPDATE devices d SET last_seen_at = GREATEST(d.last_seen_at, $2::timestamptz), status = 'online',
         last_seq = GREATEST(d.last_seq, $3::bigint), last_state = COALESCE($4::jsonb, d.last_state)
       FROM o WHERE d.id = $1 RETURNING o.status AS old_status`, [deviceId, at, seq, state ? JSON.stringify(state) : null]);
    return r.rows[0]?.old_status === 'online' ? 'already_online' as const : 'came_online' as const;
  }
  async markDeviceOffline(deviceId: string) {
    const r = await this.q(`UPDATE devices SET status = 'offline' WHERE id = $1 AND status = 'online'`, [deviceId]);
    return (r.rowCount ?? 0) > 0;
  }
  async listStaleDevices(now: Date) {
    const r = await this.q(
      `SELECT d.*, s.kind AS site_kind, t.defaults AS type_defaults FROM devices d
       LEFT JOIN sites s ON s.id = d.site_id JOIN device_types t ON t.id = d.type_id
       WHERE d.status = 'online' AND d.last_seen_at < $1::timestamptz - make_interval(secs => 3 * d.heartbeat_s)`, [now]);
    return r.rows.map(deviceRow);
  }
  async saveConfig(deviceId: string, version: number, doc: Record<string, unknown>, by: string | null) {
    const hb = (doc as any)?.interval?.heartbeat_s;
    await this.q(`INSERT INTO device_configs (device_id, version, doc, created_by) VALUES ($1,$2,$3,$4)`, [deviceId, version, JSON.stringify(doc), by]);
    await this.q(`UPDATE devices SET config_version = $2, heartbeat_s = COALESCE($3, heartbeat_s) WHERE id = $1`, [deviceId, version, hb ?? null]);
  }
  async ackConfig(deviceId: string, version: number, at: Date) {
    await this.q(`UPDATE device_configs SET acked_at = $3 WHERE device_id = $1 AND version = $2 AND acked_at IS NULL`, [deviceId, version, at]);
    await this.q(`UPDATE devices SET config_acked_version = GREATEST(config_acked_version, $2) WHERE id = $1`, [deviceId, version]);
  }

  // ---------- Ingestion ----------
  async insertMessage(m: MessageRow) {
    const r = await this.q(
      `INSERT INTO messages (device_id, seq, kind, key_id, payload_b64, sig_b64, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (device_id, seq) DO NOTHING`, [m.deviceId, m.seq, m.kind, m.keyId, m.payloadB64, m.sigB64, m.receivedAt]);
    return (r.rowCount ?? 0) > 0;
  }
  async insertReadings(rows: ReadingRow[]) {
    if (!rows.length) return;
    const cols = 11;
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(r.time, r.orgId, r.siteId, r.deviceId, r.channel, r.metric, r.value, r.quality, r.flags, r.seq, r.cal);
      return `(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(',')})`;
    });
    await this.q(`INSERT INTO readings (time, org_id, site_id, device_id, channel, metric, value, quality, flags, seq, cal) VALUES ${tuples.join(',')}`, values);
  }
  async insertEvent(e: EventRow) {
    await this.q(
      `INSERT INTO events (time, org_id, site_id, device_id, code, severity, channel, message, seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.time, e.orgId, e.siteId, e.deviceId, e.code, e.severity, e.channel, e.message, e.seq]);
  }
  async getMessage(deviceId: string, seq: number) {
    const r = await this.q(`SELECT * FROM messages WHERE device_id = $1 AND seq = $2`, [deviceId, seq]);
    const m = r.rows[0];
    return m ? { deviceId: m.device_id, seq: Number(m.seq), kind: m.kind, keyId: m.key_id, payloadB64: m.payload_b64, sigB64: m.sig_b64, receivedAt: m.received_at } : null;
  }

  // ---------- Alerts ----------
  async listRulesFor(orgId: string): Promise<AlertRule[]> {
    const r = await this.q(`SELECT * FROM alert_rules WHERE org_id = $1 AND enabled`, [orgId]);
    return r.rows.map((x: any) => ({
      id: x.id, orgId: x.org_id, siteId: x.site_id, deviceId: x.device_id, channel: x.channel, metric: x.metric, op: x.op,
      threshold: Number(x.threshold), durationS: x.duration_s, hysteresis: Number(x.hysteresis), severity: x.severity, name: x.name,
    }));
  }
  async getRuleState(ruleId: string, deviceId: string, channel: string): Promise<RuleState> {
    const r = await this.q(`SELECT breach_since, alert_id FROM rule_state WHERE rule_id = $1 AND device_id = $2 AND channel = $3`, [ruleId, deviceId, channel]);
    return r.rows[0] ? { breachSince: r.rows[0].breach_since, alertId: r.rows[0].alert_id } : { breachSince: null, alertId: null };
  }
  async setRuleState(ruleId: string, deviceId: string, channel: string, s: RuleState) {
    await this.q(
      `INSERT INTO rule_state (rule_id, device_id, channel, breach_since, alert_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (rule_id, device_id, channel) DO UPDATE SET breach_since = EXCLUDED.breach_since, alert_id = EXCLUDED.alert_id`,
      [ruleId, deviceId, channel, s.breachSince, s.alertId]);
  }
  async openAlert(a: Omit<Alert, 'id' | 'status' | 'ackedAt' | 'resolvedAt'>) {
    const r = await this.q(
      `INSERT INTO alerts (org_id, site_id, device_id, channel, rule_id, code, severity, title, value, opened_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [a.orgId, a.siteId, a.deviceId, a.channel, a.ruleId, a.code, a.severity, a.title, a.value, a.openedAt]);
    return alertRow(r.rows[0]);
  }
  async resolveAlert(id: string, at: Date) {
    const r = await this.q(`UPDATE alerts SET status = 'resolved', resolved_at = $2 WHERE id = $1 AND status <> 'resolved' RETURNING *`, [id, at]);
    return r.rows[0] ? alertRow(r.rows[0]) : null;
  }
  async findOpenAlert(orgId: string, deviceId: string, code: string, channel: string | null) {
    const r = await this.q(
      `SELECT * FROM alerts WHERE org_id = $1 AND device_id = $2 AND code = $3 AND channel IS NOT DISTINCT FROM $4 AND status <> 'resolved'
       ORDER BY opened_at DESC LIMIT 1`, [orgId, deviceId, code, channel]);
    return r.rows[0] ? alertRow(r.rows[0]) : null;
  }
  async listAlerts(siteIds: string[], status: string | null, limit: number) {
    const r = await this.q(
      `SELECT * FROM alerts WHERE site_id = ANY($1::uuid[]) AND ($2::text IS NULL OR status = $2) ORDER BY opened_at DESC LIMIT $3`,
      [siteIds, status, limit]);
    return r.rows.map(alertRow);
  }
  async listContacts(orgId: string): Promise<Contact[]> {
    const r = await this.q(`SELECT channel, address, min_severity, site_id FROM notification_contacts WHERE org_id = $1`, [orgId]);
    return r.rows.map((c: any) => ({ channel: c.channel, address: c.address, minSeverity: c.min_severity, siteId: c.site_id }));
  }

  // ---------- Sharing & API ----------
  async getApiKeyByHash(hash: string): Promise<ApiKey | null> {
    const r = await this.q(`SELECT id, org_id, scopes, revoked_at FROM api_keys WHERE key_hash = $1`, [hash]);
    const k = r.rows[0];
    return k ? { id: k.id, orgId: k.org_id, scopes: k.scopes, revokedAt: k.revoked_at } : null;
  }
  async touchApiKey(id: string) {
    await this.q(`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [id]);
  }
  async createApiKey(orgId: string, name: string, prefix: string, hash: string, scopes: string[]) {
    const r = await this.q(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, name, prefix, hash, scopes]);
    return r.rows[0].id as string;
  }
  async listSitesForOrg(orgId: string) {
    const r = await this.q(`SELECT * FROM sites WHERE org_id = $1 ORDER BY name`, [orgId]);
    return r.rows.map(siteRow);
  }
  async listActiveGrantsFor(granteeOrgId: string) {
    const r = await this.q(`SELECT * FROM data_grants WHERE grantee_org_id = $1 AND revoked_at IS NULL`, [granteeOrgId]);
    return r.rows.map(grantRow);
  }
  async listActiveGrantsFrom(ownerOrgId: string) {
    const r = await this.q(`SELECT * FROM data_grants WHERE owner_org_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`, [ownerOrgId]);
    return r.rows.map(grantRow);
  }
  async createGrant(g: Omit<Grant, 'id' | 'revokedAt'>) {
    const r = await this.q(
      `INSERT INTO data_grants (owner_org_id, grantee_org_id, site_ids, metrics, valid_from, valid_to, live)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [g.ownerOrgId, g.granteeOrgId, g.siteIds, g.metrics, g.validFrom, g.validTo, g.live]);
    return grantRow(r.rows[0]);
  }
  async revokeGrant(id: string, ownerOrgId: string) {
    const r = await this.q(`UPDATE data_grants SET revoked_at = now() WHERE id = $1 AND owner_org_id = $2 AND revoked_at IS NULL`, [id, ownerOrgId]);
    return (r.rowCount ?? 0) > 0;
  }
  async getSites(ids: string[]) {
    if (!ids.length) return [];
    const r = await this.q(`SELECT * FROM sites WHERE id = ANY($1::uuid[]) ORDER BY name`, [ids]);
    return r.rows.map(siteRow);
  }
  async listDevices(siteIds: string[]) {
    if (!siteIds.length) return [];
    const r = await this.q(
      `SELECT d.*, s.kind AS site_kind, t.defaults AS type_defaults FROM devices d
       LEFT JOIN sites s ON s.id = d.site_id JOIN device_types t ON t.id = d.type_id
       WHERE d.site_id = ANY($1::uuid[]) ORDER BY d.id`, [siteIds]);
    return r.rows.map(deviceRow);
  }
  async queryReadings(q: ReadingsQuery): Promise<(ReadingRow | AggregatedReading)[]> {
    const where = [`site_id = ANY($1::uuid[])`, `time >= $2`, `time <= $3`, `quality <> 'rejected'`];
    const vals: unknown[] = [q.siteIds, q.from, q.to];
    if (q.deviceId) { vals.push(q.deviceId); where.push(`device_id = $${vals.length}`); }
    if (q.metrics?.length) { vals.push(q.metrics); where.push(`metric = ANY($${vals.length}::text[])`); }
    if (q.channel) { vals.push(q.channel); where.push(`channel = $${vals.length}`); }
    vals.push(q.limit);
    const lim = `$${vals.length}`;
    if (q.interval === 'raw') {
      const r = await this.q(`SELECT * FROM readings WHERE ${where.join(' AND ')} ORDER BY time LIMIT ${lim}`, vals);
      return r.rows.map(readingRow);
    }
    const bucket = (await this.hasTimescale())
      ? `time_bucket(interval '${BUCKET[q.interval]}', time)`
      : `date_bin(interval '${BUCKET[q.interval]}', time, timestamptz '2000-01-01')`;
    const r = await this.q(
      `SELECT ${bucket} AS bucket, device_id, channel, metric, avg(value) AS avg, min(value) AS min, max(value) AS max, count(*)::int AS count
       FROM readings WHERE ${where.join(' AND ')} GROUP BY 1,2,3,4 ORDER BY 1 LIMIT ${lim}`, vals);
    return r.rows.map((x: any) => ({
      time: x.bucket, deviceId: x.device_id, channel: x.channel, metric: x.metric, avg: Number(x.avg), min: Number(x.min), max: Number(x.max), count: x.count,
    }));
  }
  async latestReadings(siteIds: string[], metrics?: string[]) {
    if (!siteIds.length) return [];
    const r = await this.q(
      `SELECT DISTINCT ON (device_id, channel, metric) * FROM readings
       WHERE site_id = ANY($1::uuid[]) AND time > now() - interval '7 days' AND quality <> 'rejected'
         AND ($2::text[] IS NULL OR metric = ANY($2::text[]))
       ORDER BY device_id, channel, metric, time DESC`, [siteIds, metrics?.length ? metrics : null]);
    return r.rows.map(readingRow);
  }

  // ---------- Webhooks ----------
  async listWebhooks(orgIds: string[], event: string) {
    if (!orgIds.length) return [];
    const wildcard = event.split('.')[0] + '.*';
    const r = await this.q(
      `SELECT * FROM webhooks WHERE active AND org_id = ANY($1::uuid[]) AND ($2 = ANY(events) OR $3 = ANY(events))`, [orgIds, event, wildcard]);
    return r.rows.map(webhookRow);
  }
  async createWebhook(orgId: string, url: string, events: string[], secret: string) {
    const r = await this.q(`INSERT INTO webhooks (org_id, url, events, secret) VALUES ($1,$2,$3,$4) RETURNING *`, [orgId, url, events, secret]);
    return webhookRow(r.rows[0]);
  }
  async deleteWebhook(id: string, orgId: string) {
    const r = await this.q(`UPDATE webhooks SET active = false WHERE id = $1 AND org_id = $2 AND active`, [id, orgId]);
    return (r.rowCount ?? 0) > 0;
  }
  async listOrgWebhooks(orgId: string) {
    const r = await this.q(`SELECT * FROM webhooks WHERE org_id = $1 AND active ORDER BY created_at`, [orgId]);
    return r.rows.map(webhookRow);
  }
  async enqueueDelivery(webhookId: string, event: string, body: unknown) {
    const r = await this.q(`INSERT INTO webhook_deliveries (webhook_id, event, body) VALUES ($1,$2,$3) RETURNING id`, [webhookId, event, JSON.stringify(body)]);
    return r.rows[0].id as string;
  }
  async dueDeliveries(now: Date, limit: number) {
    const r = await this.q(
      `UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '5 minutes'
       FROM webhooks w WHERE d.id IN (
         SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED
       ) AND w.id = d.webhook_id
       RETURNING d.id, d.event, d.body, d.attempts, w.id AS webhook_id, w.org_id, w.url, w.events, w.secret, w.active`, [now, limit]);
    return r.rows.map((x: any) => ({ id: x.id, event: x.event, body: x.body, attempts: x.attempts, webhook: webhookRow({ ...x, id: x.webhook_id }) }));
  }
  async recordDelivery(id: string, ok: boolean, statusCode: number | null, nextAttemptAt: Date | null) {
    await this.q(
      `UPDATE webhook_deliveries SET attempts = attempts + 1, last_status_code = $3,
         status = CASE WHEN $2 THEN 'delivered' WHEN $4::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
         next_attempt_at = COALESCE($4, next_attempt_at) WHERE id = $1`, [id, ok, statusCode, nextAttemptAt]);
  }

  // ---------- Billing & metering ----------
  async addUsage(orgId: string, day: string, d: UsageDelta) {
    await this.q(
      `INSERT INTO usage_daily (org_id, day, messages, readings, api_calls, webhooks) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, day) DO UPDATE SET messages = usage_daily.messages + EXCLUDED.messages,
         readings = usage_daily.readings + EXCLUDED.readings, api_calls = usage_daily.api_calls + EXCLUDED.api_calls,
         webhooks = usage_daily.webhooks + EXCLUDED.webhooks`,
      [orgId, day, d.messages ?? 0, d.readings ?? 0, d.apiCalls ?? 0, d.webhooks ?? 0]);
  }
  async markActiveDevice(orgId: string, day: string, deviceId: string) {
    await this.q(`INSERT INTO usage_devices_daily (org_id, day, device_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [orgId, day, deviceId]);
  }
  async listPublishedPlans(): Promise<Plan[]> {
    const r = await this.q(`SELECT * FROM plans WHERE published ORDER BY sort, price_per_device`);
    return r.rows.map((p: any) => ({
      id: p.id, name: p.name, currency: p.currency, pricePerDevice: Number(p.price_per_device), baseFee: Number(p.base_fee),
      includedApiCalls: Number(p.included_api_calls), overagePer1kCalls: Number(p.overage_per_1k_calls), features: p.features, published: p.published,
    }));
  }

  // ---------- Misc ----------
  async saveDemoRequest(r: { name: string; email: string; company?: string; phone?: string; useCase?: string; message?: string }) {
    await this.q(`INSERT INTO demo_requests (name, email, company, phone, use_case, message) VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.name, r.email, r.company ?? null, r.phone ?? null, r.useCase ?? null, r.message ?? null]);
  }
  async audit(actor: string, orgId: string | null, action: string, target: string | null, detail?: unknown) {
    await this.q(`INSERT INTO audit_log (actor, org_id, action, target, detail) VALUES ($1,$2,$3,$4,$5)`,
      [actor, orgId, action, target, detail === undefined ? null : JSON.stringify(detail)]);
  }
}

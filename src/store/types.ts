import type { AlertRule, RuleState } from '../core/rules.js';
import type { DeviceKeyRecord } from '../core/envelope.js';

export interface Device {
  id: string;
  orgId: string;
  siteId: string | null;
  siteKind: string | null;
  typeId: string;
  connectivity: 'wifi' | 'gsm';
  tokenHash: string | null;
  status: 'registered' | 'online' | 'offline' | 'disabled';
  heartbeatS: number;
  lastSeenAt: Date | null;
  configVersion: number;
  configAckedVersion: number;
  configOverride: Record<string, unknown>;
  typeDefaults: Record<string, unknown>;
  provisionCodeHash: string | null;
  provisionExpiresAt: Date | null;
}

export interface Metric {
  key: string;
  unit: string;
  label: string;
  kind: 'gauge' | 'binary' | 'counter';
  minValid: number | null;
  maxValid: number | null;
  derived: boolean;
}

export interface CropProfile {
  crop: string;
  hendersonK: number | null;
  hendersonN: number | null;
  hendersonC: number | null;
  safeMoisture: number | null;
}

export interface ReadingRow {
  time: Date;
  orgId: string;
  siteId: string | null;
  deviceId: string;
  channel: string;
  metric: string;
  value: number;
  quality: 'ok' | 'suspect' | 'fault' | 'rejected';
  flags: number;
  seq: number | null;
  cal: string | null;
}

export const FLAG_BUFFERED = 1;
export const FLAG_TIME_ESTIMATED = 2;
export const FLAG_DERIVED = 4;
export const FLAG_SHARED_SECRET = 8;

export interface MessageRow {
  deviceId: string;
  seq: number;
  kind: string;
  keyId: string;
  payloadB64: string;
  sigB64: string;
  receivedAt: Date;
}

export interface EventRow {
  time: Date;
  orgId: string;
  siteId: string | null;
  deviceId: string;
  code: string;
  severity: string;
  channel: string | null;
  message: string | null;
  seq: number | null;
}

export interface Alert {
  id: string;
  orgId: string;
  siteId: string | null;
  deviceId: string | null;
  channel: string | null;
  ruleId: string | null;
  code: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  value: number | null;
  status: 'open' | 'acknowledged' | 'resolved';
  openedAt: Date;
  ackedAt: Date | null;
  resolvedAt: Date | null;
}

export interface ApiKey {
  id: string;
  orgId: string;
  scopes: string[];
  revokedAt: Date | null;
}

export interface Grant {
  id: string;
  ownerOrgId: string;
  granteeOrgId: string;
  siteIds: string[] | null;
  metrics: string[] | null;
  validFrom: Date | null;
  validTo: Date | null;
  live: boolean;
  revokedAt: Date | null;
}

export interface Site {
  id: string;
  orgId: string;
  name: string;
  kind: string;
  externalRef: string | null;
  lat: number | null;
  lng: number | null;
}

export interface Webhook {
  id: string;
  orgId: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
}

export interface Contact {
  channel: 'email' | 'sms';
  address: string;
  minSeverity: 'info' | 'warning' | 'critical';
  siteId: string | null;
}

export interface UsageDelta {
  messages?: number;
  readings?: number;
  apiCalls?: number;
  webhooks?: number;
}

export interface ReadingsQuery {
  siteIds: string[];
  deviceId?: string;
  metrics?: string[];
  channel?: string;
  from: Date;
  to: Date;
  interval: 'raw' | '1m' | '1h' | '1d';
  limit: number;
}

export interface AggregatedReading {
  time: Date;
  deviceId: string;
  channel: string;
  metric: string;
  avg: number;
  min: number;
  max: number;
  count: number;
}

export interface Plan {
  id: string;
  name: string;
  currency: string;
  pricePerDevice: number;
  baseFee: number;
  includedApiCalls: number;
  overagePer1kCalls: number;
  features: string[];
  published: boolean;
}

export interface Store {
  // Devices & registry
  getDevice(id: string): Promise<Device | null>;
  getDeviceKey(deviceId: string, keyId: string): Promise<DeviceKeyRecord | null>;
  addDeviceKey(deviceId: string, key: DeviceKeyRecord): Promise<void>;
  countDeviceKeys(deviceId: string): Promise<number>;
  completeProvisioning(deviceId: string, tokenHash: string): Promise<void>;
  setProvisionCode(deviceId: string, codeHash: string, expiresAt: Date): Promise<void>;
  getMetrics(): Promise<Map<string, Metric>>;
  getZoneCrops(siteId: string): Promise<Map<string, { stack: string; crop: CropProfile }[]>>;
  markDeviceSeen(deviceId: string, at: Date, seq: number | null, state?: Record<string, unknown>): Promise<'came_online' | 'already_online'>;
  markDeviceOffline(deviceId: string): Promise<boolean>;
  listStaleDevices(now: Date): Promise<Device[]>;
  saveConfig(deviceId: string, version: number, doc: Record<string, unknown>, by: string | null): Promise<void>;
  ackConfig(deviceId: string, version: number, at: Date): Promise<void>;

  // Ingestion
  insertMessage(m: MessageRow): Promise<boolean>; // false if (device, seq) already stored
  insertReadings(rows: ReadingRow[]): Promise<void>;
  insertEvent(e: EventRow): Promise<void>;
  getMessage(deviceId: string, seq: number): Promise<MessageRow | null>;

  // Alerts
  listRulesFor(orgId: string): Promise<AlertRule[]>;
  getRuleState(ruleId: string, deviceId: string, channel: string): Promise<RuleState>;
  setRuleState(ruleId: string, deviceId: string, channel: string, s: RuleState): Promise<void>;
  openAlert(a: Omit<Alert, 'id' | 'status' | 'ackedAt' | 'resolvedAt'>): Promise<Alert>;
  resolveAlert(id: string, at: Date): Promise<Alert | null>;
  findOpenAlert(orgId: string, deviceId: string, code: string, channel: string | null): Promise<Alert | null>;
  listAlerts(siteIds: string[], status: string | null, limit: number): Promise<Alert[]>;
  listContacts(orgId: string): Promise<Contact[]>;

  // Sharing & API
  getApiKeyByHash(hash: string): Promise<ApiKey | null>;
  touchApiKey(id: string): Promise<void>;
  createApiKey(orgId: string, name: string, prefix: string, hash: string, scopes: string[]): Promise<string>;
  listSitesForOrg(orgId: string): Promise<Site[]>;
  listActiveGrantsFor(granteeOrgId: string): Promise<Grant[]>;
  listActiveGrantsFrom(ownerOrgId: string): Promise<Grant[]>;
  createGrant(g: Omit<Grant, 'id' | 'revokedAt'>): Promise<Grant>;
  revokeGrant(id: string, ownerOrgId: string): Promise<boolean>;
  getSites(ids: string[]): Promise<Site[]>;
  listDevices(siteIds: string[]): Promise<Device[]>;
  queryReadings(q: ReadingsQuery): Promise<(ReadingRow | AggregatedReading)[]>;
  latestReadings(siteIds: string[], metrics?: string[]): Promise<ReadingRow[]>;

  // Webhooks
  listWebhooks(orgIds: string[], event: string): Promise<Webhook[]>;
  createWebhook(orgId: string, url: string, events: string[], secret: string): Promise<Webhook>;
  deleteWebhook(id: string, orgId: string): Promise<boolean>;
  listOrgWebhooks(orgId: string): Promise<Webhook[]>;
  enqueueDelivery(webhookId: string, event: string, body: unknown): Promise<string>;
  dueDeliveries(now: Date, limit: number): Promise<{ id: string; webhook: Webhook; event: string; body: unknown; attempts: number }[]>;
  recordDelivery(id: string, ok: boolean, statusCode: number | null, nextAttemptAt: Date | null): Promise<void>;

  // Billing & metering
  addUsage(orgId: string, day: string, d: UsageDelta): Promise<void>;
  markActiveDevice(orgId: string, day: string, deviceId: string): Promise<void>;
  listPublishedPlans(): Promise<Plan[]>;

  // Misc
  saveDemoRequest(r: { name: string; email: string; company?: string; phone?: string; useCase?: string; message?: string }): Promise<void>;
  audit(actor: string, orgId: string | null, action: string, target: string | null, detail?: unknown): Promise<void>;
}

import { generateKeyPairSync, sign } from 'node:crypto';
import { MemoryStore } from '../src/store/memory.js';
import type { Device, Metric } from '../src/store/types.js';

export function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string; // base64url raw 32 bytes
  return {
    publicKey: raw,
    envelope(body: object, keyId = 'k1') {
      const bytes = Buffer.from(JSON.stringify(body));
      return JSON.stringify({ k: keyId, p: bytes.toString('base64url'), s: sign(null, bytes, privateKey).toString('base64url') });
    },
  };
}

export const ORG = '00000000-0000-0000-0000-00000000000a';
export const SITE = '00000000-0000-0000-0000-0000000000s1'.replace('s1', '51');

const metric = (key: string, unit: string, min: number | null, max: number | null, derived = false): Metric =>
  ({ key, unit, label: key, kind: 'gauge', minValid: min, maxValid: max, derived });

export function seededStore(overrides: Partial<Device> = {}) {
  const store = new MemoryStore();
  for (const m of [
    metric('air.temperature', '°C', -40, 85), metric('air.humidity', '%RH', 0, 100), metric('produce.moisture', '% wb', 0, 60),
    metric('produce.moisture_raw', 'raw', null, null), metric('security.motion', 'state', 0, 1), metric('water.ph', 'pH', 0, 14),
    metric('air.dew_point', '°C', null, null, true), metric('produce.emc', '% wb', null, null, true), metric('air.vpd', 'kPa', null, null, true),
  ]) store.metrics.set(m.key, m);
  store.sites.push({ id: SITE, orgId: ORG, name: 'Iseyin Warehouse', kind: 'warehouse', externalRef: 'SX-1', lat: null, lng: null });
  store.zoneCrops.set(SITE, new Map([['z1', [{ stack: 'stack-a', crop: { crop: 'maize', hendersonK: 8.6541e-5, hendersonN: 1.8634, hendersonC: 49.81, safeMoisture: 13 } }]]]));
  const device: Device = {
    id: 'WG-000123', orgId: ORG, siteId: SITE, siteKind: 'warehouse', typeId: 'wareguard-v1', connectivity: 'wifi', tokenHash: null,
    status: 'registered', heartbeatS: 60, lastSeenAt: null, configVersion: 0, configAckedVersion: 0, configOverride: {},
    typeDefaults: { wifi: { telemetry_s: 10, moisture_s: 60, heartbeat_s: 60 }, gsm: { telemetry_s: 60, moisture_s: 300, heartbeat_s: 300 } },
    provisionCodeHash: null, provisionExpiresAt: null, ...overrides,
  };
  store.devices.set(device.id, device);
  return { store, device };
}

export class RecordingNotifier {
  events: { event: string; data: any }[] = [];
  async emit(event: string, _ctx: unknown, data: unknown) { this.events.push({ event, data }); }
  of(event: string) { return this.events.filter((e) => e.event === event); }
}

let seq = 1000;
export function body(over: Record<string, unknown> = {}) {
  return { v: 1, dev: 'WG-000123', seq: seq++, ts: Math.floor(Date.now() / 1000), up: 1000, buf: false, ...over };
}

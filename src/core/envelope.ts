import { b64urlDecode, verifyEd25519, verifyHmacSha256 } from './crypto.js';

export type MessageKind = 'telemetry' | 'event' | 'state' | 'ack';
export const MESSAGE_KINDS: MessageKind[] = ['telemetry', 'event', 'state', 'ack'];

export interface Envelope {
  k: string;
  p: string;
  s: string;
}

export interface ReadingIn {
  m: string;
  v: number;
  ch: string;
  cal?: string;
  q?: 'ok' | 'suspect' | 'fault';
}

export interface Body {
  v: 1;
  dev: string;
  seq: number;
  ts: number;
  up: number;
  upn?: number;
  buf: boolean;
  fw?: string;
  r?: ReadingIn[];
  ev?: { code: string; ch?: string; sev?: 'info' | 'warning' | 'critical'; msg?: string };
  st?: Record<string, unknown>;
  ack?: { cfg?: number; id?: string; ok: boolean; msg?: string };
  /** GradeGuard: marks a telemetry message as one quality test of a sample (Device Protocol v1 §16). */
  qt?: { lot?: string; spec?: string; sample?: string; lat?: number; lng?: number };
}

export interface DeviceKeyRecord {
  keyId: string;
  alg: 'ed25519' | 'hmac-sha256';
  publicKey: string;
  retiredAt?: Date | null;
}

export class EnvelopeError extends Error {
  constructor(public code: 'malformed' | 'unknown_key' | 'bad_signature' | 'device_mismatch' | 'invalid_body', msg: string) {
    super(msg);
  }
}

export function parseEnvelope(raw: string | Buffer): Envelope {
  let obj: unknown;
  try {
    obj = JSON.parse(raw.toString());
  } catch {
    throw new EnvelopeError('malformed', 'Envelope is not valid JSON');
  }
  const e = obj as Partial<Envelope>;
  if (!e || typeof e.k !== 'string' || typeof e.p !== 'string' || typeof e.s !== 'string') {
    throw new EnvelopeError('malformed', 'Envelope must have string fields k, p, s');
  }
  return e as Envelope;
}

/** Verifies the signature over the exact body bytes and returns the decoded body bytes. */
export function verifyEnvelope(env: Envelope, key: DeviceKeyRecord | null): Buffer {
  if (!key) throw new EnvelopeError('unknown_key', `Unknown key ${env.k}`);
  const body = b64urlDecode(env.p);
  const sig = b64urlDecode(env.s);
  const ok = key.alg === 'ed25519' ? verifyEd25519(key.publicKey, body, sig) : verifyHmacSha256(key.publicKey, body, sig);
  if (!ok) throw new EnvelopeError('bad_signature', 'Signature verification failed');
  return body;
}

const isInt = (x: unknown) => typeof x === 'number' && Number.isInteger(x);

/**
 * Protocol v1.1 compact readings for LoRa and other small links: a reading may be an array
 * [metric, value, channel, cal?], and the metric may be one of these short codes.
 */
export const SHORT_METRICS: Record<string, string> = {
  at: 'air.temperature', ah: 'air.humidity', ac: 'air.co2', pm: 'produce.moisture', pr: 'produce.moisture_raw',
  pt: 'produce.temperature', pw: 'produce.weight', sm: 'security.motion', sd: 'security.door', wt: 'water.temperature',
  wp: 'water.ph', wd: 'water.do', we: 'water.ec', wl: 'water.level', sl: 'soil.moisture', kt: 'kiln.temperature',
  fm: 'feedstock.mass', bm: 'biochar.mass', st: 'stove.temperature', se: 'stove.energy', lm: 'lpg.mass',
  so: 'solar.energy', sp: 'solar.power', bs: 'power.battery_soc', pv: 'power.voltage', es: 'equipment.state',
  al: 'appliance.locked', ad: 'appliance.door_opens',
};

function normaliseReading(r: unknown): unknown {
  let out: any = r;
  if (Array.isArray(r)) {
    const [m, v, ch, cal] = r;
    out = { m, v, ch, ...(cal !== undefined ? { cal } : {}) };
  }
  if (out && typeof out.m === 'string' && SHORT_METRICS[out.m]) out = { ...out, m: SHORT_METRICS[out.m] };
  return out;
}

export function parseBody(bytes: Buffer, kind: MessageKind, expectedDevice: string): Body {
  let b: Body;
  try {
    b = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new EnvelopeError('invalid_body', 'Body is not valid JSON');
  }
  const fail = (m: string) => {
    throw new EnvelopeError('invalid_body', m);
  };
  if (b.v !== 1) fail('Unsupported body version');
  if (b.dev !== expectedDevice) throw new EnvelopeError('device_mismatch', `Body device ${b.dev} does not match ${expectedDevice}`);
  if (!isInt(b.seq) || b.seq < 0 || b.seq > 0xffffffff) fail('seq must be a uint32');
  if (!isInt(b.ts) || b.ts < 0) fail('ts must be a non-negative integer');
  if (!isInt(b.up) || b.up < 0) fail('up must be a non-negative integer');
  if (typeof b.buf !== 'boolean') fail('buf must be boolean');
  if (b.ts === 0 && !isInt(b.upn)) fail('upn is required when ts is 0');
  if (b.r !== undefined) {
    if (!Array.isArray(b.r)) fail('r must be an array');
    b.r = b.r.map(normaliseReading) as ReadingIn[];
    for (const r of b.r) {
      if (!r || typeof r.m !== 'string' || typeof r.ch !== 'string' || typeof r.v !== 'number' || !Number.isFinite(r.v)) {
        fail('Each reading needs string m, string ch and finite numeric v');
      }
    }
  }
  if (kind === 'telemetry' && (!b.r || b.r.length === 0)) fail('telemetry needs readings');
  if (kind === 'event' && (!b.ev || typeof b.ev.code !== 'string')) fail('event needs ev.code');
  if (kind === 'state' && (!b.st || typeof b.st !== 'object')) fail('state needs st');
  if (kind === 'ack' && (!b.ack || typeof b.ack.ok !== 'boolean')) fail('ack needs ack.ok');
  return b;
}

/** Reading time: device clock if synced, otherwise estimated from uptime. */
export function readingTime(b: Body, receivedAt: Date): { time: Date; estimated: boolean } {
  if (b.ts > 0) return { time: new Date(b.ts * 1000), estimated: false };
  const ageMs = Math.max(0, (b.upn ?? b.up) - b.up);
  return { time: new Date(receivedAt.getTime() - ageMs), estimated: true };
}

/** titan/v1/<deviceId>/up/<kind> */
export function parseUplinkTopic(topic: string): { deviceId: string; kind: MessageKind | 'lwt' } | null {
  const m = /^titan\/v1\/([A-Za-z0-9_-]{3,64})\/up\/(telemetry|event|state|ack|lwt)$/.exec(topic);
  return m ? { deviceId: m[1], kind: m[2] as MessageKind | 'lwt' } : null;
}

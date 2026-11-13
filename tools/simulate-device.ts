// Titan device simulator: a reference implementation of Device Protocol v1 in ~150 lines.
// Hardware engineers can compare their firmware's bytes against this, and teams can demo Titan without hardware.
//
//   npx tsx tools/simulate-device.ts provision --url https://titan.kitovu.com.ng --device WG-000001 --code <provisioning code>
//   npx tsx tools/simulate-device.ts run       --url https://titan.kitovu.com.ng --device WG-000001 --profile wareguard --interval 10
//   npx tsx tools/simulate-device.ts event     --url … --device WG-000001 --code intruder_detected --sev critical
//   npx tsx tools/simulate-device.ts show      --device WG-000001     (prints a signed envelope without sending it)
//
// Uses the HTTPS fallback (Protocol §12). Real devices should use MQTT; the envelope is identical.
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:4600' }, device: { type: 'string' }, code: { type: 'string' },
    profile: { type: 'string', default: 'wareguard' }, interval: { type: 'string', default: '10' }, count: { type: 'string' },
    sev: { type: 'string', default: 'warning' }, msg: { type: 'string' }, channel: { type: 'string' },
  },
});
const cmd = positionals[0];
const id = values.device;
if (!id) throw new Error('--device is required');
const stateFile = `.titan-device-${id}.json`;
type State = { privateKeyPem: string; publicKey: string; keyId: string; token: string; seq: number; boot: number };
const load = (): State => {
  if (!existsSync(stateFile)) throw new Error(`No ${stateFile}. Run "provision" first.`);
  return JSON.parse(readFileSync(stateFile, 'utf8'));
};
const save = (s: State) => writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 });

/** Builds the signed envelope exactly as firmware must: sign the body's bytes, base64url both. */
function envelope(s: State, body: Record<string, unknown>) {
  s.seq += 1; // every uplink message gets the next sequence number, persisted
  save(s);
  const full = { v: 1, dev: id, seq: s.seq, ts: Math.floor(Date.now() / 1000), up: Date.now() - s.boot, buf: false, ...body };
  const bytes = Buffer.from(JSON.stringify(full), 'utf8');
  const sig = sign(null, bytes, createPrivateKey(s.privateKeyPem));
  return { body: full, envelope: JSON.stringify({ k: s.keyId, p: bytes.toString('base64url'), s: sig.toString('base64url') }) };
}

async function send(s: State, kind: 'telemetry' | 'event' | 'state' | 'ack', body: Record<string, unknown>) {
  const e = envelope(s, body);
  const res = await fetch(`${values.url}/api/ingest`, {
    method: 'POST',
    headers: { Authorization: `Device ${id}:${s.token}`, 'X-Titan-Kind': kind, 'Content-Type': 'application/json' },
    body: e.envelope,
  });
  console.log(`${new Date().toISOString()} ${kind} seq=${e.body.seq} → ${res.status} ${await res.text()}`);
}

const rnd = (a: number, b: number, dp = 1) => Math.round((a + Math.random() * (b - a)) * 10 ** dp) / 10 ** dp;
const PROFILES: Record<string, () => unknown[]> = {
  wareguard: () => [
    { m: 'air.temperature', v: rnd(26, 31), ch: 'z1/dht22' }, { m: 'air.humidity', v: rnd(62, 78), ch: 'z1/dht22' },
    { m: 'produce.moisture_raw', v: Math.round(rnd(2200, 2400, 0)), ch: 'z1/stack-a/mst1' },
    { m: 'produce.moisture', v: rnd(12.2, 13.4), ch: 'z1/stack-a/mst1', cal: 'maize-cap-v2' }, { m: 'security.motion', v: 0, ch: 'z1/pir1' },
  ],
  aquaponics: () => [{ m: 'water.do', v: rnd(4.5, 7.5), ch: 't1/do1' }, { m: 'water.ph', v: rnd(6.8, 7.4, 2), ch: 't1/ph1' }, { m: 'water.temperature', v: rnd(26, 29), ch: 't1/temp' }],
  kiln: () => [{ m: 'kiln.temperature', v: rnd(600, 680, 0), ch: 'k1/top' }, { m: 'kiln.temperature', v: rnd(580, 640, 0), ch: 'k1/bottom' }],
  cookstove: () => [['st', rnd(25, 190), 's1'], ['bs', rnd(70, 95, 0), 'bat']], // compact form (Protocol §14)
  solar: () => [{ m: 'solar.power', v: rnd(0, 900, 0), ch: 'inv1' }, { m: 'power.battery_soc', v: rnd(40, 100, 0), ch: 'bat1' }],
};

if (cmd === 'provision') {
  if (!values.code) throw new Error('--code is required');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'); // on hardware: generated on the device, never leaves it
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  const res = await fetch(`${values.url}/api/provision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: id, code: values.code, publicKey: raw }),
  });
  const out: any = await res.json();
  if (!res.ok) throw new Error(`Provisioning failed: ${out.error} ${out.message ?? ''}`);
  save({ privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: raw, keyId: out.keyId, token: out.token, seq: 0, boot: Date.now() });
  console.log(`Provisioned ${id} with key ${out.keyId}. MQTT: ${out.mqtt.host}:${out.mqtt.port}. State saved to ${stateFile}.`);
} else if (cmd === 'run') {
  const s = load();
  const profile = PROFILES[values.profile!] ?? PROFILES.wareguard;
  const every = Math.max(1, Number(values.interval)) * 1000;
  let left = values.count ? Number(values.count) : Infinity;
  await send(s, 'state', { fw: 'sim-1.0.0', st: { net: 'wifi', rssi: -60, bufq: 0, cfg: 0, time: 'ntp', err: [] } });
  while (left-- > 0) {
    await send(s, 'telemetry', { r: profile() });
    if (left > 0) await new Promise((r) => setTimeout(r, every));
  }
} else if (cmd === 'event') {
  const s = load();
  await send(s, 'event', { ev: { code: values.code ?? 'boot', sev: values.sev, ch: values.channel, msg: values.msg } });
} else if (cmd === 'show') {
  const s = load();
  s.seq -= 1; // don't consume a sequence number for a dry run
  const e = envelope(s, { r: (PROFILES[values.profile!] ?? PROFILES.wareguard)() });
  console.log('Body (these exact bytes are signed):\n' + JSON.stringify(e.body) + '\n\nEnvelope sent on the wire:\n' + e.envelope);
} else {
  console.log('Commands: provision, run, event, show. See the comments at the top of this file.');
}

// Actuators, automations, carbon and retention end to end on a real Postgres (through psql). Skipped unless TITAN_TEST_PSQL is set.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { ActuatorService } from '../src/actuators/service.js';
import { CarbonService } from '../src/carbon/service.js';
import { sha256Hex } from '../src/core/crypto.js';
import { createApp } from '../src/http/app.js';
import { DeviceService } from '../src/ingest/devices.js';
import { IngestPipeline } from '../src/ingest/pipeline.js';
import { Dispatcher } from '../src/notify/dispatcher.js';
import { PostgresStore } from '../src/store/postgres.js';
import { applyRetention } from '../src/workers/workers.js';
import { deviceKeys } from './helpers.js';
import { PsqlPool } from './psql-pool.js';

const args = process.env.TITAN_TEST_PSQL?.split(' ').filter(Boolean);
const skip = !args;
const pool = skip ? null : new PsqlPool(args!);
const q = (t: string, v: unknown[] = []) => pool!.query(t, v);
const n = Date.now() % 1_000_000;
const pad = (x: number) => String(x).padStart(6, '0');
const SENSOR = `WG-${pad(n)}`, FAN = `TC-${pad(n)}`, KILN = `KN-${pad(n)}`;
const OWNER_KEY = `tk_live_owner_${n}_aaaaaaaaaaaaaaaaaaaa`, LENDER_KEY = `tk_live_lender_${n}_bbbbbbbbbbbbbbbbbb`;
const published: { topic: string; payload: any }[] = [];
let server: Server, base = '', org = '', lender = '', site = '', pipeline: IngestPipeline, carbon: CarbonService;
const keys = { sensor: deviceKeys(), kiln: deviceKeys() };
let seq = 1;

const call = async (method: string, path: string, key: string, json?: unknown) => {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
};
const send = (dev: string, k: ReturnType<typeof deviceKeys>, kind: 'telemetry' | 'event' | 'ack', body: Record<string, unknown>) =>
  pipeline.handle(dev, kind, k.envelope({ v: 1, dev, seq: seq++, ts: Math.floor(Date.now() / 1000), up: 1, buf: false, ...body }));

before(async () => {
  if (skip) return;
  const store = new PostgresStore(pool as any);
  const broker = { async publish(topic: string, payload: string) { published.push({ topic, payload: JSON.parse(payload) }); } };
  const actuators = new ActuatorService(pool!, broker);
  carbon = new CarbonService(pool!);
  const email = { async send() { return true; } };
  pipeline = new IngestPipeline(store, new Dispatcher(store, email, { async send() { return true; } }, 'x'), [actuators, carbon]);
  const app = createApp({ store, pipeline, devices: new DeviceService(store, broker), email, billing: null, internalSecret: 's', publicUrl: 'x', demoInbox: 'x', mqtt: { host: 'm', port: 1 }, actuators, carbon });
  org = (await q(`INSERT INTO organisations (name) VALUES ('Biochar Co ${n}') RETURNING id`)).rows[0].id;
  lender = (await q(`INSERT INTO organisations (name, kind) VALUES ('Verifier ${n}', 'consumer') RETURNING id`)).rows[0].id;
  site = (await q(`INSERT INTO sites (org_id, name, kind) VALUES ($1, 'Kiln yard', 'other') RETURNING id`, [org])).rows[0].id;
  await q(`INSERT INTO devices (id, org_id, site_id, type_id, status) VALUES ($1,$2,$3,'wareguard-v1','offline'),($4,$2,$3,'titan-controller-v1','offline'),($5,$2,$3,'titan-kiln-v1','offline')`, [SENSOR, org, site, FAN, KILN]);
  await q(`INSERT INTO device_keys (device_id, key_id, alg, public_key) VALUES ($1,'k1','ed25519',$2),($3,'k1','ed25519',$4)`, [SENSOR, keys.sensor.publicKey, KILN, keys.kiln.publicKey]);
  await q(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes) VALUES ($1,'owner','x',$2,'{read:readings,control:devices,read:carbon,write:carbon,manage:grants}'),($3,'lender','y',$4,'{read:readings,read:carbon}')`,
    [org, sha256Hex(OWNER_KEY), lender, sha256Hex(LENDER_KEY)]);
  server = createServer(app.handler());
  server.keepAliveTimeout = 120_000; // psql calls in tests block the event loop for seconds
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

test('device commands through the API: catalogue, policy, arguments, acknowledgement', { skip }, async () => {
  const cat = await call('GET', `/v1/devices/${FAN}/commands`, OWNER_KEY);
  assert.ok(cat.json.available.find((c: any) => c.name === 'relay.set'));
  const ok = await call('POST', `/v1/devices/${FAN}/commands`, OWNER_KEY, { command: 'relay.set', args: { channel: 'fan1', on: true } });
  assert.equal(ok.status, 202);
  assert.deepEqual(published.at(-1)!.payload, { v: 1, id: ok.json.command.id, cmd: 'relay.set', args: { channel: 'fan1', on: true } });
  assert.equal((await call('POST', `/v1/devices/${FAN}/commands`, OWNER_KEY, { command: 'relay.set', args: { channel: 'fan1' } })).status, 400);
  assert.equal((await call('POST', `/v1/devices/${FAN}/commands`, OWNER_KEY, { command: 'reboot' })).status, 403, 'reboot is admin/ops only');
  assert.equal((await call('POST', `/v1/devices/${FAN}/commands`, OWNER_KEY, { command: 'paygo.lock' })).status, 400, 'not in this type');
  assert.equal((await call('POST', `/v1/devices/${FAN}/commands`, LENDER_KEY, { command: 'relay.set', args: { channel: 'fan1', on: true } })).status, 403, 'lender key lacks control scope');
  // the device acknowledges (acks are signed like everything else; reuse the sensor's key on its own ack path)
  await q(`INSERT INTO device_keys (device_id, key_id, alg, public_key) VALUES ($1,'k1','ed25519',$2)`, [FAN, keys.sensor.publicKey]);
  await send(FAN, keys.sensor, 'ack', { dev: FAN, ack: { id: ok.json.command.id, ok: true } });
  const hist = await call('GET', `/v1/devices/${FAN}/commands`, OWNER_KEY);
  assert.equal(hist.json.history.find((c: any) => c.id === ok.json.command.id).status, 'acked');
});

test('automation: humidity above 75 turns the fan on, clearing turns it off, with cooldown', { skip }, async () => {
  await q(`INSERT INTO automations (org_id, name, site_id, metric, op, threshold, hysteresis, target_device_id, command, args, clear_command, clear_args, cooldown_s)
    VALUES ($1,'Dry the bay',$2,'air.humidity','gt',75,3,$3,'relay.set','{"channel":"fan1","on":true}','relay.set','{"channel":"fan1","on":false}',0)`, [org, site, FAN]);
  const before = published.length;
  await send(SENSOR, keys.sensor, 'telemetry', { r: [{ m: 'air.humidity', v: 70, ch: 'z1/dht22' }] });
  assert.equal(published.length, before, 'below threshold: nothing');
  await send(SENSOR, keys.sensor, 'telemetry', { r: [{ m: 'air.humidity', v: 78, ch: 'z1/dht22' }] });
  assert.deepEqual(published.at(-1)!.payload.args, { channel: 'fan1', on: true });
  await send(SENSOR, keys.sensor, 'telemetry', { r: [{ m: 'air.humidity', v: 79, ch: 'z1/dht22' }] });
  assert.equal(published.length, before + 1, 'already on: not sent again');
  await send(SENSOR, keys.sensor, 'telemetry', { r: [{ m: 'air.humidity', v: 74, ch: 'z1/dht22' }] });
  assert.equal(published.length, before + 1, 'inside hysteresis band');
  await send(SENSOR, keys.sensor, 'telemetry', { r: [{ m: 'air.humidity', v: 71, ch: 'z1/dht22' }] });
  assert.deepEqual(published.at(-1)!.payload.args, { channel: 'fan1', on: false });
  const log = (await q(`SELECT source, actor FROM commands WHERE device_id = $1 AND source = 'automation'`, [FAN])).rows;
  assert.equal(log.length, 2);
});

test('biochar batch: kiln events open and close it; lab results complete it; verifier reads it', { skip }, async () => {
  const project = await carbon.createProject({ orgId: org, name: 'Oyo biochar', methodology: 'biochar-v1', registry: 'Puro.earth', siteIds: [site], params: { bufferPct: 10 } });
  const start = Math.floor(Date.now() / 1000) - 3600;
  const ev = (code: string, ts: number, msg?: string) =>
    pipeline.handle(KILN, 'event', keys.kiln.envelope({ v: 1, dev: KILN, seq: seq++, ts, up: 1, buf: false, ev: { code, sev: 'info', msg } }));
  await ev('batch_start', start, 'B-0042');
  for (let i = 0; i < 30; i++) {
    const ts = start + 60 + i * 60;
    await pipeline.handle(KILN, 'telemetry', keys.kiln.envelope({ v: 1, dev: KILN, seq: seq++, ts, up: 1, buf: false,
      r: [{ m: 'kiln.temperature', v: 640 + (i % 3), ch: 'k1/top' }, { m: 'kiln.temperature', v: 610, ch: 'k1/bottom' }] }));
  }
  await pipeline.handle(KILN, 'telemetry', keys.kiln.envelope({ v: 1, dev: KILN, seq: seq++, ts: start + 2000, up: 1, buf: false, r: [{ m: 'biochar.mass', v: 420, ch: 'scale1' }, { m: 'biochar.mass', v: 380, ch: 'scale1' }] }));
  await ev('batch_end', start + 2100);

  const acts = await carbon.listActivities(project.id);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].reference, 'B-0042');
  assert.equal(acts[0].status, 'calculated');
  assert.equal(acts[0].result.status, 'incomplete');
  assert.equal(acts[0].result.inputs.kiln.heldTempC, 610, 'coolest probe governs');
  assert.equal(acts[0].result.inputs.biocharMass.kg, 800);

  const id = acts[0].id;
  for (const [kind, value] of [['biochar.moisture_pct', 5], ['lab.organic_carbon_pct', 80], ['lab.h_corg', 0.3]] as const) {
    const m = await call('POST', `/v1/carbon/activities/${id}/measurements`, OWNER_KEY, { kind, value, documentRef: 'lab-cert-0042.pdf', documentSha256: 'a'.repeat(64) });
    assert.equal(m.status, 201);
  }
  assert.equal((await call('POST', `/v1/carbon/activities/${id}/measurements`, OWNER_KEY, { kind: 'lab.organic_carbon_pct', value: 140 })).status, 400);
  const calc = await call('POST', `/v1/carbon/activities/${id}/calculate`, OWNER_KEY);
  assert.equal(calc.json.activity.result.status, 'ok');
  // 800 kg × 0.95 × 0.80 × 0.89 × 44/12, less 10% buffer
  const expected = Math.round(0.76 * 0.8 * 0.89 * (44 / 12) * 1e4) / 1e4;
  assert.equal(calc.json.activity.result.grossTco2e, expected);
  assert.ok(calc.json.activity.result.inputs.kiln.seqRange, 'lineage back to signed device messages');

  // verifier: nothing until granted, then read-only
  assert.equal((await call('GET', `/v1/carbon/projects/${project.id}`, LENDER_KEY)).status, 404);
  await call('POST', '/v1/grants', OWNER_KEY, { granteeOrgId: lender, siteIds: [site] });
  const seen = await call('GET', `/v1/carbon/projects/${project.id}`, LENDER_KEY);
  assert.equal(seen.status, 200);
  assert.ok(seen.json.summary.netTco2e > 0);
  assert.equal((await call('POST', `/v1/carbon/activities/${id}/calculate`, LENDER_KEY)).status, 403);
});

test('retention follows each organisation\'s setting', { skip }, async () => {
  await q(`INSERT INTO readings (time, org_id, site_id, device_id, channel, metric, value) VALUES (now() - interval '40 days', $1, $2, $3, 'z1/dht22', 'air.humidity', 60)`, [org, site, SENSOR]);
  await q(`UPDATE organisations SET retention_days = 30 WHERE id = $1`, [org]);
  await applyRetention(pool!);
  const left = (await q(`SELECT count(*)::int AS n FROM readings WHERE org_id = $1 AND time < now() - interval '30 days'`, [org])).rows[0].n;
  assert.equal(left, 0);
  const recent = (await q(`SELECT count(*)::int AS n FROM readings WHERE org_id = $1`, [org])).rows[0].n;
  assert.ok(recent > 0, 'recent readings kept');
});

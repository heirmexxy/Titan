import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { priceInvoice } from '../src/billing/billing.js';
import { sha256Hex, webhookSignature } from '../src/core/crypto.js';
import { buildDeviceConfig } from '../src/core/device-config.js';
import { createApp } from '../src/http/app.js';
import { DeviceService } from '../src/ingest/devices.js';
import { IngestPipeline } from '../src/ingest/pipeline.js';
import { Dispatcher } from '../src/notify/dispatcher.js';
import { body, deviceKeys, ORG, seededStore, SITE } from './helpers.js';

const LENDER = '00000000-0000-0000-0000-0000000000b1';
const { store, device } = seededStore();
const published: { topic: string; payload: string; retain: boolean }[] = [];
const sent: { to: unknown; subject: string }[] = [];
const email = { async send(to: string | string[], subject: string) { sent.push({ to, subject }); return true; } };
const sms = { async send() { return true; } };
const broker = { async publish(topic: string, payload: string, o: { retain: boolean }) { published.push({ topic, payload, retain: o.retain }); } };
const dispatcher = new Dispatcher(store, email, sms, 'https://titan.test');
const pipeline = new IngestPipeline(store, dispatcher);
const devices = new DeviceService(store, broker);
const app = createApp({
  store, pipeline, devices, email, billing: null, internalSecret: 'secret', publicUrl: 'https://titan.test',
  demoInbox: 'titan@kitovu.com.ng', mqtt: { host: 'mqtt.test', port: 8883 },
});

let server: Server;
let base = '';
const OWNER_KEY = 'tk_live_owner_aaaaaaaaaaaaaaaaaaaaaaaa';
const LENDER_KEY = 'tk_live_lender_bbbbbbbbbbbbbbbbbbbbbbbb';
const call = async (method: string, path: string, opts: { key?: string; json?: unknown; headers?: Record<string, string>; raw?: string } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.raw ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

before(async () => {
  server = createServer(app.handler());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await store.createApiKey(ORG, 'owner', 'tk_live_own', sha256Hex(OWNER_KEY), ['read:readings', 'read:alerts', 'manage:webhooks', 'manage:grants']);
  await store.createApiKey(LENDER, 'lender', 'tk_live_len', sha256Hex(LENDER_KEY), ['read:readings', 'read:alerts', 'manage:webhooks']);
});
after(() => server.close());

let token = '';
let keys: ReturnType<typeof deviceKeys>;

test('provisioning: one-time code, device key registered, config pushed', async () => {
  const code = await devices.issueProvisionCode(device.id);
  keys = deviceKeys();
  const bad = await call('POST', '/api/provision', { json: { deviceId: device.id, code: 'wrong', publicKey: keys.publicKey } });
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/api/provision', { json: { deviceId: device.id, code, publicKey: keys.publicKey } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.keyId, 'k1');
  token = ok.json.token;
  const again = await call('POST', '/api/provision', { json: { deviceId: device.id, code, publicKey: keys.publicKey } });
  assert.equal(again.status, 400, 'code cannot be reused');
  assert.equal(published[0].topic, 'titan/v1/WG-000123/down/config');
  assert.equal(published[0].retain, true);
  assert.equal(JSON.parse(published[0].payload).interval.telemetry_s, 10);
});

test('EMQX auth and ACL hooks', async () => {
  const h = { 'X-Titan-Internal': 'secret' };
  assert.equal((await call('POST', '/internal/emqx/auth', { json: { username: device.id, password: token, clientid: device.id }, headers: h })).json.result, 'allow');
  assert.equal((await call('POST', '/internal/emqx/auth', { json: { username: device.id, password: 'nope', clientid: device.id }, headers: h })).json.result, 'deny');
  assert.equal((await call('POST', '/internal/emqx/auth', { json: { username: device.id, password: token, clientid: device.id } })).status, 401);
  const acl = async (topic: string, action: string) => (await call('POST', '/internal/emqx/acl', { json: { username: device.id, topic, action }, headers: h })).json.result;
  assert.equal(await acl('titan/v1/WG-000123/up/telemetry', 'publish'), 'allow');
  assert.equal(await acl('titan/v1/WG-000124/up/telemetry', 'publish'), 'deny');
  assert.equal(await acl('titan/v1/WG-000123/down/#', 'subscribe'), 'allow');
  assert.equal(await acl('titan/v1/WG-000123/down/config', 'publish'), 'deny');
});

test('messages arrive through the EMQX hook and the HTTPS fallback', async () => {
  const h = { 'X-Titan-Internal': 'secret' };
  const env1 = keys.envelope(body({ r: [{ m: 'air.temperature', v: 26, ch: 'z1/dht22' }, { m: 'air.humidity', v: 72, ch: 'z1/dht22' }, { m: 'produce.moisture', v: 13.1, ch: 'z1/stack-a/mst1', cal: 'maize-cap-v2' }] }));
  const r1 = await call('POST', '/internal/emqx/message', { json: { topic: 'titan/v1/WG-000123/up/telemetry', payload: env1, username: device.id }, headers: h });
  assert.equal(r1.json.status, 'accepted');
  const env2 = keys.envelope(body({ r: [{ m: 'air.temperature', v: 27, ch: 'z1/dht22' }] }));
  const r2 = await call('POST', '/api/ingest', { raw: env2, headers: { Authorization: `Device ${device.id}:${token}`, 'X-Titan-Kind': 'telemetry' } });
  assert.equal(r2.json.status, 'accepted');
  const r3 = await call('POST', '/api/ingest', { raw: env2, headers: { Authorization: `Device ${device.id}:bad`, 'X-Titan-Kind': 'telemetry' } });
  assert.equal(r3.status, 401);
});

test('owner reads sites, latest values, history and proofs', async () => {
  assert.equal((await call('GET', '/v1/sites')).status, 401);
  const sites = await call('GET', '/v1/sites', { key: OWNER_KEY });
  assert.equal(sites.json.sites.length, 1);
  assert.equal(sites.json.sites[0].access.owned, true);
  const latest = await call('GET', `/v1/latest?site=${SITE}`, { key: OWNER_KEY });
  assert.equal(latest.json.readings.find((r: any) => r.metric === 'air.temperature').value, 27);
  const hist = await call('GET', `/v1/readings?site=${SITE}&metric=air.temperature&interval=1h`, { key: OWNER_KEY });
  assert.equal(hist.json.readings[0].count, 2);
  assert.equal(hist.json.readings[0].avg, 26.5);
  const raw = await call('GET', `/v1/readings?site=${SITE}&metric=produce.moisture`, { key: OWNER_KEY });
  assert.equal(raw.json.readings[0].integrity, 'device-signed');
  const proof = await call('GET', `/v1/readings/proof?device=${device.id}&seq=${raw.json.readings[0].seq}`, { key: OWNER_KEY });
  assert.equal(proof.json.signatureValid, true);
  assert.equal(proof.json.body.dev, device.id);
});

test('StorageX: find warehouse by reference and get a receipt condition report for a lot', async () => {
  store.stackRefs.push({ siteId: SITE, zone: 'z1', stack: 'stack-a', ref: 'LOT-77' });
  const byRef = await call('GET', '/v1/sites?ref=SX-1', { key: OWNER_KEY });
  assert.equal(byRef.json.sites[0].id, SITE);
  assert.equal((await call('GET', '/v1/sites?ref=nope', { key: OWNER_KEY })).json.sites.length, 0);
  const from = new Date(Date.now() - 3 * 3600_000).toISOString();
  const rep = await call('GET', `/v1/sites/${SITE}/conditions?lot=LOT-77&from=${from}`, { key: OWNER_KEY });
  assert.equal(rep.status, 200);
  assert.deepEqual(rep.json.scope, { zone: 'z1', stack: 'stack-a' });
  assert.equal(rep.json.bucket, '1h');
  const moisture = rep.json.metrics.find((m: any) => m.metric === 'produce.moisture');
  assert.equal(moisture.max, 13.1);
  assert.ok(rep.json.metrics.find((m: any) => m.metric === 'air.temperature'), 'zone-level air readings included');
  assert.equal(rep.json.crop.crop, 'maize');
  assert.equal(rep.json.crop.exceededSafeMoisture, true);
  assert.ok(rep.json.completeness > 0);
  assert.equal((await call('GET', `/v1/sites/${SITE}/conditions?lot=missing`, { key: OWNER_KEY })).status, 404);
});

test('grants: lender sees only granted metrics, revocation removes access', async () => {
  assert.equal((await call('GET', '/v1/sites', { key: LENDER_KEY })).json.sites.length, 0);
  assert.equal((await call('GET', `/v1/readings?site=${SITE}`, { key: LENDER_KEY })).status, 404);
  const g = await call('POST', '/v1/grants', { key: OWNER_KEY, json: { granteeOrgId: LENDER, siteIds: [SITE], metrics: ['produce.moisture', 'air.humidity'] } });
  assert.equal(g.status, 201);
  const sites = await call('GET', '/v1/sites', { key: LENDER_KEY });
  assert.deepEqual(sites.json.sites[0].access.metrics.sort(), ['air.humidity', 'produce.moisture']);
  const r = await call('GET', `/v1/readings?site=${SITE}`, { key: LENDER_KEY });
  assert.ok(r.json.readings.length > 0);
  assert.ok(r.json.readings.every((x: any) => ['produce.moisture', 'air.humidity'].includes(x.metric)));
  const blocked = await call('GET', `/v1/readings?site=${SITE}&metric=air.temperature`, { key: LENDER_KEY });
  assert.equal(blocked.json.readings.length, 0);
  assert.equal((await call('POST', '/v1/grants', { key: LENDER_KEY, json: { granteeOrgId: ORG } })).status, 403, 'lender key lacks manage:grants');
  assert.equal((await call('DELETE', `/v1/grants/${g.json.grant.id}`, { key: OWNER_KEY })).status, 204);
  assert.equal((await call('GET', '/v1/sites', { key: LENDER_KEY })).json.sites.length, 0);
});

test('webhooks: lender with a live grant receives alerts; payload is signed', async () => {
  await call('POST', '/v1/grants', { key: OWNER_KEY, json: { granteeOrgId: LENDER, siteIds: [SITE] } });
  const w = await call('POST', '/v1/webhooks', { key: LENDER_KEY, json: { url: 'https://lender.example/hook', events: ['alert.*'] } });
  assert.equal(w.status, 201);
  assert.match(w.json.webhook.secret, /^whsec_/);
  assert.equal((await call('POST', '/v1/webhooks', { key: LENDER_KEY, json: { url: 'http://insecure', events: ['alert.*'] } })).status, 400);
  await pipeline.handle(device.id, 'event', keys.envelope(body({ ev: { code: 'intruder_detected', ch: 'z1/pir1', sev: 'critical' } })));
  const d = store.deliveries.find((x) => x.event === 'alert.opened');
  assert.ok(d, 'delivery queued for lender');
  const alerts = await call('GET', `/v1/alerts?site=${SITE}&status=open`, { key: LENDER_KEY });
  assert.equal(alerts.json.alerts[0].code, 'intruder_detected');
  assert.match(webhookSignature('s', '{}', 1), /^t=1,v1=[0-9a-f]{64}$/);
});

test('alert emails go to contacts at or above their severity', async () => {
  store.contacts.set(ORG, [{ channel: 'email', address: 'ops@kitovu.com.ng', minSeverity: 'warning', siteId: null }]);
  sent.length = 0;
  await pipeline.deviceOffline(device.id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /WARNING: WG-000123 is offline/);
});

test('demo requests are stored and emailed to the Titan inbox', async () => {
  sent.length = 0;
  const bad = await call('POST', '/api/public/demo', { json: { name: 'A', email: 'not-an-email' } });
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/api/public/demo', { json: { name: 'Ada', email: 'ada@farm.ng', company: 'Ada Farms', useCase: 'aquaponics' } });
  assert.equal(ok.status, 201);
  assert.equal(sent[0].to, 'titan@kitovu.com.ng');
  assert.equal(store.demos.length, 1);
});

test('device config: type defaults by connectivity, then per-device override', () => {
  const gsm = buildDeviceConfig({ ...device, connectivity: 'gsm' }, 2);
  assert.deepEqual(gsm.interval, { telemetry_s: 60, moisture_s: 300, heartbeat_s: 300 });
  const o = buildDeviceConfig({ ...device, configOverride: { interval: { telemetry_s: 30 }, thresholds: { 'air.temperature': { max: 35 } } } }, 3);
  assert.equal(o.interval.telemetry_s, 30);
  assert.equal(o.thresholds['air.temperature'].max, 35);
  assert.throws(() => buildDeviceConfig({ ...device, configOverride: { interval: { telemetry_s: 0 } } }, 4));
});

test('invoice pricing', () => {
  const plan = { name: 'Growth', baseFee: 10000, pricePerDevice: 2500, includedApiCalls: 100_000, overagePer1kCalls: 50 };
  const inv = priceInvoice(plan, { activeDevices: 12, apiCalls: 102_001 });
  assert.equal(inv.amount, 10000 + 12 * 2500 + 3 * 50);
  assert.equal(inv.lines.length, 3);
  assert.equal(priceInvoice(plan, { activeDevices: 0, apiCalls: 0 }).amount, 10000);
});

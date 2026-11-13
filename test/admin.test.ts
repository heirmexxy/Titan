// Admin/Ops API against a real Postgres (through psql). Skipped unless TITAN_TEST_PSQL is set.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/admin/auth.js';
import { registerAdmin } from '../src/admin/routes.js';
import { createApp } from '../src/http/app.js';
import { DeviceService } from '../src/ingest/devices.js';
import { IngestPipeline } from '../src/ingest/pipeline.js';
import { Dispatcher } from '../src/notify/dispatcher.js';
import { PostgresStore } from '../src/store/postgres.js';
import { PsqlPool } from './psql-pool.js';

const args = process.env.TITAN_TEST_PSQL?.split(' ').filter(Boolean);
const skip = !args;

test('password hashing', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', h));
  assert.ok(!(await verifyPassword('wrong password!!', h)));
  await assert.rejects(hashPassword('short'));
});

let server: Server;
let base = '';
const published: { topic: string; payload: string }[] = [];
const pool = skip ? null : new PsqlPool(args!);
const stamp = Date.now() % 1_000_000;
const adminEmail = `admin${stamp}@kitovu.com.ng`;
const opsEmail = `ops${stamp}@kitovu.com.ng`;

before(async () => {
  if (skip) return;
  const store = new PostgresStore(pool as any);
  const email = { async send() { return true; } };
  const dispatcher = new Dispatcher(store, email, { async send() { return true; } }, 'https://titan.test');
  const devices = new DeviceService(store, { async publish(topic, payload) { published.push({ topic, payload }); } });
  const app = createApp({ store, pipeline: new IngestPipeline(store, dispatcher), devices, email, billing: null, internalSecret: 's', publicUrl: 'https://titan.test', demoInbox: 'x@y.z', mqtt: { host: 'm', port: 8883 } });
  registerAdmin(app, { pool: pool!, devices, secureCookies: false });
  const kitovu = (await pool!.query(`SELECT id FROM organisations WHERE kind = 'kitovu' LIMIT 1`)).rows[0].id;
  await pool!.query(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1,$2,'admin',$3)`, [kitovu, adminEmail, await hashPassword('admin-password-1')]);
  await pool!.query(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1,$2,'ops',$3)`, [kitovu, opsEmail, await hashPassword('ops-password-12')]);
  server = createServer(app.handler());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function login(email: string, password: string) {
  const res = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { status: res.status, cookie };
}
function client(cookie: string) {
  return async (method: string, path: string, json?: unknown, csrf = true) => {
    const res = await fetch(base + path, {
      method,
      headers: { Cookie: cookie, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Titan-Admin': '1' } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

test('admin dashboard API end to end', { skip }, async () => {
  assert.equal((await login(adminEmail, 'wrong-password')).status, 401);
  assert.equal((await fetch(`${base}/admin/api/overview`)).status, 401);
  const { cookie } = await login(adminEmail, 'admin-password-1');
  const api = client(cookie);

  assert.equal((await api('GET', '/admin/api/me')).json.role, 'admin');
  const org = (await api('POST', '/admin/api/orgs', { name: `Agro Fish ${stamp}`, kind: 'client' })).json.org;
  assert.equal((await api('POST', '/admin/api/orgs', { name: 'Dup', devicePrefix: 'WG' })).status, 409);
  assert.equal((await api('POST', '/admin/api/orgs', { name: 'No CSRF' }, false)).status, 403, 'writes need X-Titan-Admin');
  const site = (await api('POST', '/admin/api/sites', { orgId: org.id, name: 'Iseyin WH', kind: 'warehouse', externalRef: `SX-${stamp}`, lat: 7.97, lng: 3.59 })).json.site;
  assert.equal((await api('POST', `/admin/api/sites/${site.id}/zones`, { code: 'z1', name: 'Bay 1' })).status, 201);
  assert.equal((await api('POST', `/admin/api/sites/${site.id}/zones`, { code: 'Bad Code' })).status, 400);
  assert.equal((await api('POST', `/admin/api/sites/${site.id}/stacks`, { zone: 'z1', code: 'stack-a', commodity: 'maize', externalRef: `LOT-${stamp}` })).status, 201);

  const devId = `WG-${String(stamp).padStart(6, '0')}`;
  const reg = await api('POST', '/admin/api/devices', { id: devId, siteId: site.id, connectivity: 'gsm' });
  assert.equal(reg.status, 201);
  assert.ok(reg.json.provisioningCode.length >= 12);
  assert.equal((await api('POST', '/admin/api/devices', { id: devId, siteId: site.id })).status, 409);

  const cfg = await api('POST', `/admin/api/devices/${devId}/config`, { interval: { telemetry_s: 120 }, thresholds: { 'air.temperature': { max: 35 } } });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.config.interval.telemetry_s, 120);
  assert.equal(cfg.json.config.interval.heartbeat_s, 300, 'GSM default from device type');
  assert.equal(published.at(-1)!.topic, `titan/v1/${devId}/down/config`);
  assert.equal((await api('POST', `/admin/api/devices/${devId}/config`, { interval: { telemetry_s: 0 } })).status, 400);
  assert.ok((await api('POST', `/admin/api/devices/${devId}/command`, { cmd: 'time_sync' })).json.commandId);

  const detail = (await api('GET', `/admin/api/devices/${devId}`)).json;
  assert.equal(detail.device.id, devId);
  assert.equal(detail.device.token_hash, undefined, 'secrets are not returned');
  assert.equal(detail.configs.length, 1);
  assert.equal((await api('GET', `/admin/api/devices/${devId}/series?metric=air.temperature&hours=24`)).status, 200);

  const types = (await api('GET', '/admin/api/device-types')).json.types;
  assert.ok(types.find((t: any) => t.id === 'wareguard-v1'));
  const freq = await api('POST', '/admin/api/device-types/wareguard-v1', { wifi: { telemetry_s: 15, moisture_s: 60, heartbeat_s: 60 }, gsm: { telemetry_s: 90, moisture_s: 300, heartbeat_s: 300 } });
  assert.equal(freq.status, 200);
  assert.equal(freq.json.defaults.wifi.telemetry_s, 15);

  const rule = await api('POST', '/admin/api/rules', { orgId: org.id, siteId: site.id, metric: 'air.humidity', op: 'gt', threshold: 75, durationS: 600, hysteresis: 3, severity: 'warning' });
  assert.equal(rule.status, 201);
  assert.equal((await api('POST', `/admin/api/rules/${rule.json.rule.id}/toggle`)).status, 200);
  assert.equal((await api('POST', '/admin/api/contacts', { orgId: org.id, channel: 'sms', address: '2348012345678', minSeverity: 'critical' })).status, 201);
  assert.equal((await api('POST', '/admin/api/contacts', { orgId: org.id, channel: 'sms', address: 'abc' })).status, 400);

  const key = await api('POST', '/admin/api/apikeys', { orgId: org.id, name: 'StorageX', scopes: ['read:readings', 'read:alerts', 'manage:webhooks'] });
  assert.match(key.json.key, /^tk_live_/);
  const sites = await fetch(`${base}/v1/sites?ref=SX-${stamp}`, { headers: { Authorization: `Bearer ${key.json.key}` } });
  const sj = await sites.json();
  assert.equal(sj.sites?.[0]?.id, site.id, `new key works on the public API: ${JSON.stringify(sj)}`);

  const plan = await api('POST', '/admin/api/plans', { id: `growth-${stamp}`, name: 'Growth', pricePerDevice: 2500, baseFee: 10000, includedApiCalls: 100000, features: 'Alerts by SMS\nAPI access', published: true });
  assert.equal(plan.status, 200);
  const pub = await (await fetch(`${base}/api/public/plans`)).json();
  assert.ok(pub.plans.find((p: any) => p.id === `growth-${stamp}`), 'published plan shows on the landing page');
  assert.equal((await api('POST', '/admin/api/subscriptions', { orgId: org.id, planId: `growth-${stamp}` })).status, 200);

  const alert = (await pool!.query(`INSERT INTO alerts (org_id, site_id, device_id, code, severity, title) VALUES ($1,$2,$3,'intruder_detected','critical','Motion') RETURNING id`, [org.id, site.id, devId])).rows[0].id;
  const overview = (await api('GET', '/admin/api/overview')).json;
  assert.ok(overview.counts.critical >= 1);
  assert.ok(overview.alerts.find((a: any) => a.id === alert));
  assert.equal((await api('POST', `/admin/api/alerts/${alert}/ack`)).status, 200);
  assert.equal((await api('POST', `/admin/api/alerts/${alert}/ack`)).status, 409);
  assert.equal((await api('POST', `/admin/api/alerts/${alert}/resolve`)).status, 200);

  const siteDetail = (await api('GET', `/admin/api/sites/${site.id}`)).json;
  assert.equal(siteDetail.stacks[0].commodity, 'maize');
  assert.equal((await api('GET', '/admin/api/usage')).status, 200);
  assert.equal((await api('GET', '/admin/api/demo-requests')).status, 200);
  assert.equal((await api('GET', '/admin/api/metrics')).status, 200);
  const nu = await api('POST', '/admin/api/users', { email: `new${stamp}@kitovu.com.ng`, role: 'ops' });
  assert.ok(nu.json.temporaryPassword);

  // Ops can operate but not change pricing, frequencies or keys
  const ops = client((await login(opsEmail, 'ops-password-12')).cookie);
  assert.equal((await ops('GET', '/admin/api/overview')).status, 200);
  assert.equal((await ops('POST', '/admin/api/plans', { id: 'x', name: 'x' })).status, 403);
  assert.equal((await ops('POST', '/admin/api/device-types/wareguard-v1', { wifi: {} })).status, 403);
  assert.equal((await ops('POST', '/admin/api/apikeys', { orgId: org.id, name: 'x' })).status, 403);
  assert.equal((await ops('POST', `/admin/api/devices/${devId}/command`, { cmd: 'send_state' })).status, 200);

  const out = await api('POST', '/admin/api/logout');
  assert.equal(out.status, 200);
  assert.equal((await api('GET', '/admin/api/me')).status, 401);
});

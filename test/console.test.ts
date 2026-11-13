// Client console API on a real Postgres (through psql). Skipped unless TITAN_TEST_PSQL is set.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { hashPassword } from '../src/admin/auth.js';
import { ActuatorService } from '../src/actuators/service.js';
import { CarbonService } from '../src/carbon/service.js';
import { registerConsole } from '../src/console/routes.js';
import { createApp } from '../src/http/app.js';
import { DeviceService } from '../src/ingest/devices.js';
import { IngestPipeline } from '../src/ingest/pipeline.js';
import { Dispatcher } from '../src/notify/dispatcher.js';
import { PostgresStore } from '../src/store/postgres.js';
import { PsqlPool } from './psql-pool.js';

const args = process.env.TITAN_TEST_PSQL?.split(' ').filter(Boolean);
const skip = !args;
const pool = skip ? null : new PsqlPool(args!);
const q = (t: string, v: unknown[] = []) => pool!.query(t, v);
const n = Date.now() % 1_000_000;
const letters = (x: number) => String.fromCharCode(65 + (x % 26), 65 + (Math.floor(x / 26) % 26), 65 + (Math.floor(x / 676) % 26));
const PREFIX = 'Z' + letters(n);
let server: Server, base = '', org = '', other = '', otherSite = '';

before(async () => {
  if (skip) return;
  const store = new PostgresStore(pool as any);
  const broker = { async publish() {} };
  const email = { async send() { return true; } };
  const actuators = new ActuatorService(pool!, broker);
  const carbon = new CarbonService(pool!);
  const devices = new DeviceService(store, broker);
  const app = createApp({ store, pipeline: new IngestPipeline(store, new Dispatcher(store, email, { async send() { return true; } }, 'x')), devices, email, billing: null, internalSecret: 's', publicUrl: 'x', demoInbox: 'x', mqtt: { host: 'm', port: 1 }, actuators, carbon });
  registerConsole(app, { pool: pool!, store, devices, actuators, carbon, billing: null, publicUrl: 'https://titan.test', secureCookies: false });
  org = (await q(`INSERT INTO organisations (name, device_prefix) VALUES ($1, $2) RETURNING id`, [`Agro Fish ${n}`, PREFIX])).rows[0].id;
  other = (await q(`INSERT INTO organisations (name, kind) VALUES ($1, 'consumer') RETURNING id`, [`Lender ${n}`])).rows[0].id;
  otherSite = (await q(`INSERT INTO sites (org_id, name) VALUES ($1, 'Not yours') RETURNING id`, [other])).rows[0].id;
  await q(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1,$2,'client_owner',$3),($1,$4,'client_member',$5)`,
    [org, `owner${n}@fish.ng`, await hashPassword('owner-password-1'), `member${n}@fish.ng`, await hashPassword('member-password-1')]);
  server = createServer(app.handler());
  server.keepAliveTimeout = 120_000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function login(email: string, password: string) {
  const res = await fetch(`${base}/console/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
const client = (cookie: string) => async (method: string, path: string, json?: unknown) => {
  const res = await fetch(base + '/console/api' + path, { method, headers: { Cookie: cookie, 'X-Titan-Console': '1', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
};

test('client console: owners run their own organisation, members watch, nothing leaks across organisations', { skip }, async () => {
  const kitovuAdmin = (await q(`SELECT email FROM users WHERE role = 'admin' LIMIT 1`)).rows[0];
  if (kitovuAdmin) assert.equal((await login(kitovuAdmin.email, 'admin-password-1')).status, 401, 'admin accounts cannot sign in to the console');
  const owner = client((await login(`owner${n}@fish.ng`, 'owner-password-1')).cookie);
  const me = (await owner('GET', '/me')).json;
  assert.equal(me.orgId, org);
  assert.equal(me.role, 'client_owner');

  const site = (await owner('POST', '/sites', { name: 'Tank farm', kind: 'aquaponics' })).json.site;
  assert.equal((await owner('POST', `/sites/${site.id}/zones`, { code: 't1' })).status, 201);
  assert.equal((await owner('POST', '/devices', { id: 'WG-000999', siteId: site.id })).status, 400, 'must use own prefix');
  const devId = `${PREFIX}-000001`;
  const reg = await owner('POST', '/devices', { id: devId, siteId: site.id, typeId: 'titan-controller-v1' });
  assert.equal(reg.status, 201);
  assert.ok(reg.json.provisioningCode);
  assert.equal((await owner('POST', '/devices', { id: `${PREFIX}-000002`, siteId: otherSite })).status, 404, "cannot register on someone else's site");
  const detail = (await owner('GET', `/devices/${devId}`)).json;
  assert.ok(detail.commands.available.find((c: any) => c.name === 'relay.set'));
  assert.equal((await owner('POST', `/devices/${devId}/command`, { cmd: 'relay.set', args: { channel: 'aerator', on: true } })).status, 200);
  assert.equal((await owner('POST', `/devices/${devId}/command`, { cmd: 'reboot' })).status, 403, 'reboot is Kitovu ops only');
  assert.equal((await owner('GET', `/sites/${otherSite}`)).status, 404);

  const key = await owner('POST', '/keys', { name: 'Farm app', scopes: ['read:readings', 'control:devices'] });
  assert.match(key.json.key, /^tk_live_/);
  assert.equal((await owner('POST', '/keys', { name: 'x', scopes: ['admin:everything'] })).status, 400);
  assert.equal((await owner('POST', '/webhooks', { url: 'https://farm.example/hook', events: ['alert.*'] })).status, 201);
  assert.equal((await owner('POST', '/rules', { metric: 'water.do', op: 'lt', threshold: 4, severity: 'critical', siteId: site.id })).status, 201);
  assert.equal((await owner('POST', '/contacts', { channel: 'sms', address: '2348012345678', minSeverity: 'critical' })).status, 201);

  assert.equal((await owner('POST', '/grants', { granteeOrgId: '00000000-0000-0000-0000-000000000000' })).status, 400);
  const g = await owner('POST', '/grants', { granteeOrgId: other, siteIds: [site.id], metrics: ['water.do'] });
  assert.equal(g.status, 201);
  assert.equal(g.json.granteeName, `Lender ${n}`);
  assert.equal((await owner('GET', '/grants')).json.given.length, 1);

  const alertId = (await q(`INSERT INTO alerts (org_id, site_id, code, severity, title) VALUES ($1,$2,'threshold','critical','Low oxygen') RETURNING id`, [org, site.id])).rows[0].id;
  const foreignAlert = (await q(`INSERT INTO alerts (org_id, site_id, code, severity, title) VALUES ($1,$2,'threshold','critical','Not yours') RETURNING id`, [other, otherSite])).rows[0].id;
  const member = client((await login(`member${n}@fish.ng`, 'member-password-1')).cookie);
  assert.equal((await member('GET', '/overview')).json.counts.open_alerts, 1);
  assert.equal((await member('POST', `/alerts/${alertId}/ack`)).status, 200, 'members can acknowledge');
  assert.equal((await member('POST', `/alerts/${foreignAlert}/ack`)).status, 409, "but not other organisations' alerts");
  assert.equal((await member('POST', '/sites', { name: 'x' })).status, 403, 'members cannot change setup');
  assert.equal((await member('POST', '/keys', { name: 'x' })).status, 403);

  const team = await owner('POST', '/team', { email: `ops${n}@fish.ng`, role: 'client_member' });
  assert.ok(team.json.temporaryPassword);
  assert.equal((await owner('GET', '/team')).json.users.length, 3);
  assert.equal((await owner('GET', '/billing')).status, 200);
  assert.equal((await owner('POST', `/invoices/00000000-0000-0000-0000-000000000000/pay`)).status, 503);
  assert.equal((await owner('GET', '/carbon')).status, 200);
});

// Kitovu support sessions and LoRa gateway relaying, on a real Postgres (through psql). Skipped unless TITAN_TEST_PSQL is set.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { hashPassword } from '../src/admin/auth.js';
import { registerAdmin } from '../src/admin/routes.js';
import { registerConsole } from '../src/console/routes.js';
import { parseBody } from '../src/core/envelope.js';
import { sha256Hex } from '../src/core/crypto.js';
import { createApp } from '../src/http/app.js';
import { DeviceService } from '../src/ingest/devices.js';
import { IngestPipeline } from '../src/ingest/pipeline.js';
import { Dispatcher } from '../src/notify/dispatcher.js';
import { PostgresStore } from '../src/store/postgres.js';
import { deviceKeys } from './helpers.js';
import { PsqlPool } from './psql-pool.js';

test('compact readings and short metric codes (Protocol v1.1)', () => {
  const body = { v: 1, dev: 'CK-000001', seq: 5, ts: 1763022600, up: 1, buf: false, r: [['st', 182.5, 's1'], ['bs', 88, 'bat'], { m: 'at', v: 31, ch: 'amb' }] };
  const parsed = parseBody(Buffer.from(JSON.stringify(body)), 'telemetry', 'CK-000001');
  assert.deepEqual(parsed.r, [
    { m: 'stove.temperature', v: 182.5, ch: 's1' }, { m: 'power.battery_soc', v: 88, ch: 'bat' }, { m: 'air.temperature', v: 31, ch: 'amb' },
  ]);
});

const args = process.env.TITAN_TEST_PSQL?.split(' ').filter(Boolean);
const skip = !args;
const pool = skip ? null : new PsqlPool(args!);
const q = (t: string, v: unknown[] = []) => pool!.query(t, v);
const n = Date.now() % 1_000_000;
const pad = (x: number) => String(x).padStart(6, '0');
const GW = `GW-${pad(n)}`, NODE = `CK-${pad(n)}`, STRANGER = `CK-${pad(n + 1)}`;
let server: Server, base = '', org = '', adminEmail = '';
const nodeKeys = deviceKeys();
const H = { 'X-Titan-Internal': 's', 'Content-Type': 'application/json' };

before(async () => {
  if (skip) return;
  const store = new PostgresStore(pool as any);
  const email = { async send() { return true; } };
  const devices = new DeviceService(store, { async publish() {} });
  const app = createApp({ store, pipeline: new IngestPipeline(store, new Dispatcher(store, email, { async send() { return true; } }, 'x')), devices, email, billing: null, internalSecret: 's', publicUrl: 'x', demoInbox: 'x', mqtt: { host: 'm', port: 1 } });
  registerAdmin(app, { pool: pool!, devices, secureCookies: false });
  registerConsole(app, { pool: pool!, store, devices, billing: null, publicUrl: 'x', secureCookies: false });
  org = (await q(`INSERT INTO organisations (name) VALUES ($1) RETURNING id`, [`Stoves ${n}`])).rows[0].id;
  const site = (await q(`INSERT INTO sites (org_id, name) VALUES ($1, 'Village') RETURNING id`, [org])).rows[0].id;
  await q(`INSERT INTO devices (id, org_id, site_id, type_id, token_hash) VALUES ($1,$2,$3,'titan-lora-gateway-v1',$4)`, [GW, org, site, sha256Hex('gw-token')]);
  await q(`INSERT INTO devices (id, org_id, site_id, type_id) VALUES ($1,$2,$3,'titan-cookstove-v1'),($4,$2,$3,'titan-cookstove-v1')`, [NODE, org, site, STRANGER]);
  await q(`INSERT INTO device_keys (device_id, key_id, alg, public_key) VALUES ($1,'k1','ed25519',$2)`, [NODE, nodeKeys.publicKey]);
  const kit = (await q(`SELECT id FROM organisations WHERE kind = 'kitovu' LIMIT 1`)).rows[0].id;
  adminEmail = `support${n}@kitovu.com.ng`;
  await q(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1,$2,'ops',$3)`, [kit, adminEmail, await hashPassword('support-password-1')]);
  server = createServer(app.handler());
  server.keepAliveTimeout = 120_000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

const post = async (path: string, body: unknown, headers: Record<string, string> = H) => {
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
};

test('LoRa gateway relays signed node messages only for its own nodes', { skip }, async () => {
  const acl = async (topic: string, action = 'publish') => (await post('/internal/emqx/acl', { username: GW, topic, action })).json.result;
  assert.equal(await acl(`titan/v1/${NODE}/up/telemetry`), 'deny', 'not assigned yet');
  await q(`UPDATE devices SET gateway_id = $1 WHERE id = $2`, [GW, NODE]);
  assert.equal(await acl(`titan/v1/${NODE}/up/telemetry`), 'allow');
  assert.equal(await acl(`titan/v1/${NODE}/down/#`, 'subscribe'), 'allow');
  assert.equal(await acl(`titan/v1/${NODE}/up/lwt`), 'deny', "a gateway can't declare a node offline");
  assert.equal(await acl(`titan/v1/${STRANGER}/up/telemetry`), 'deny');

  const env = nodeKeys.envelope({ v: 1, dev: NODE, seq: 1, ts: Math.floor(Date.now() / 1000), up: 1, buf: false, r: [['st', 140, 's1']] });
  const ok = await post('/internal/emqx/message', { topic: `titan/v1/${NODE}/up/telemetry`, payload: env, username: GW });
  assert.equal(ok.json.status, 'accepted');
  const stored = (await q(`SELECT metric, value FROM readings WHERE device_id = $1`, [NODE])).rows[0];
  assert.equal(stored.metric, 'stove.temperature');
  assert.equal((await post('/internal/emqx/message', { topic: `titan/v1/${STRANGER}/up/telemetry`, payload: env, username: GW })).status, 400);
  // a gateway that alters the payload is caught by the node's signature
  const e = JSON.parse(nodeKeys.envelope({ v: 1, dev: NODE, seq: 2, ts: Math.floor(Date.now() / 1000), up: 1, buf: false, r: [['st', 140, 's1']] }));
  e.p = Buffer.from(Buffer.from(e.p, 'base64url').toString().replace('140', '999')).toString('base64url');
  const forged = await post('/internal/emqx/message', { topic: `titan/v1/${NODE}/up/telemetry`, payload: JSON.stringify(e), username: GW });
  assert.equal(forged.json.code, 'bad_signature');
});

test('Kitovu support can open a client console with a reason; the client sees it in their log', { skip }, async () => {
  const login = await post('/admin/api/login', { email: adminEmail, password: 'support-password-1' }, { 'Content-Type': 'application/json' });
  const adminHeaders = { Cookie: login.cookie, 'X-Titan-Admin': '1', 'Content-Type': 'application/json' };
  assert.equal((await post(`/admin/api/orgs/${org}/support-session`, {}, adminHeaders)).status, 400, 'reason required');
  const s = await post(`/admin/api/orgs/${org}/support-session`, { reason: 'Customer asked us to assign nodes' }, adminHeaders);
  assert.equal(s.status, 200);
  assert.match(s.cookie, /^titan_console=/);
  const consoleHeaders = { Cookie: s.cookie, 'X-Titan-Console': '1', 'Content-Type': 'application/json' };
  const me = await (await fetch(`${base}/console/api/me`, { headers: consoleHeaders })).json();
  assert.equal(me.orgId, org);
  assert.equal(me.role, 'client_owner');
  assert.equal(me.support.email, adminEmail);
  const gw = await post(`/console/api/devices/${STRANGER}/gateway`, { gatewayId: GW }, consoleHeaders);
  assert.equal(gw.status, 200, 'support can act as the owner');
  assert.equal((await post('/console/api/password', { current: 'x', next: 'yyyyyyyyyyyy' }, consoleHeaders)).status, 403);
  const log = await (await fetch(`${base}/console/api/support-log`, { headers: consoleHeaders })).json();
  assert.ok(log.entries.find((e: any) => e.action === 'support.session_started'));
  assert.ok(log.entries.find((e: any) => e.action === 'device.gateway_set'), 'actions during support are attributed to support');
});

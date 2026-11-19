// v1.2 features on a real Postgres (through psql): firmware OTA, PAYG, self-serve sign-up, GradeGuard quality and
// traceability, exports, verifiers and registry packages, the field app API and health. Skipped unless TITAN_TEST_PSQL is set.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { hashPassword } from '../src/admin/auth.js';
import { registerAdmin } from '../src/admin/routes.js';
import { ActuatorService } from '../src/actuators/service.js';
import { OpsAgent } from '../src/agent/ops-agent.js';
import { Writer } from '../src/agent/writer.js';
import { CarbonService } from '../src/carbon/service.js';
import { registerConsole } from '../src/console/routes.js';
import { sha256Hex } from '../src/core/crypto.js';
import { registerExtensions } from '../src/extensions.js';
import { toCsv, toXlsx } from '../src/export/files.js';
import { createApiKeyAuth } from '../src/http/apikey.js';
import { createApp } from '../src/http/app.js';
import { DeviceService } from '../src/ingest/devices.js';
import { IngestPipeline } from '../src/ingest/pipeline.js';
import { Dispatcher } from '../src/notify/dispatcher.js';
import { extendCredit, hoursFor, PAYG_EVENTS } from '../src/payg/payg.js';
import { evaluate } from '../src/quality/quality.js';
import { prefixCandidates } from '../src/signup/signup.js';
import { canonical, fingerprint } from '../src/verify/registry.js';
import { PostgresStore } from '../src/store/postgres.js';
import { deviceKeys } from './helpers.js';
import { PsqlPool } from './psql-pool.js';

// ---------- Pure functions ----------
test('PAYG credit maths', () => {
  assert.equal(hoursFor(1500, 500), 72);
  const now = new Date('2026-11-19T00:00:00Z');
  assert.equal(extendCredit(new Date('2026-11-10T00:00:00Z'), 24, now).toISOString(), '2026-11-20T00:00:00.000Z', 'expired credit restarts from now');
  assert.equal(extendCredit(new Date('2026-11-21T00:00:00Z'), 24, now).toISOString(), '2026-11-22T00:00:00.000Z', 'live credit is extended');
});

test('quality evaluation against a buyer spec', () => {
  const spec = [{ key: 'moisture', min: null, max: 14 }, { key: 'foreign_matter', max: 2 }, { key: 'hectolitre_mass', min: 72, max: null }];
  assert.equal(evaluate(spec, { moisture: 13.1, foreign_matter: 1.2, hectolitre_mass: 75 }).outcome, 'pass');
  const f = evaluate(spec, { moisture: 15, hectolitre_mass: 70 });
  assert.equal(f.outcome, 'fail');
  assert.deepEqual(f.failures.map((x) => `${x.key}:${x.reason}`), ['moisture:above 14', 'foreign_matter:not measured', 'hectolitre_mass:below 72']);
  assert.equal(evaluate(null, { moisture: 1 }).outcome, 'no_spec');
});

test('device prefixes from company names; canonical fingerprints', () => {
  assert.deepEqual(prefixCandidates('Agro Fish Farms').slice(0, 2), ['AFF', 'AGR']);
  assert.ok(!prefixCandidates('W G').includes('WG'), 'WG is reserved for WareGuard');
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: null }] }), '{"a":[2,{"c":null,"d":3}],"b":1}');
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});

test('CSV escapes formulas; XLSX is a valid workbook', () => {
  const csv = toCsv(['a', 'b'], [['=1+1', 'x,y'], [3, null]]);
  assert.ok(csv.includes(`'=1+1`) && csv.includes('"x,y"'));
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const file = join(dir, 't.xlsx');
  writeFileSync(file, toXlsx([{ name: 'Readings', headers: ['time', 'value', 'note'], rows: [[new Date('2026-11-19T10:00:00Z'), 13.25, 'ok & <fine>'], [null, 2, '']] }]));
  const out = execFileSync('python3', ['-c', `
import zipfile, sys, xml.dom.minidom as m
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
for n in z.namelist():
    if n.endswith('.xml') or n.endswith('.rels'): m.parseString(z.read(n))
try:
    import openpyxl
    ws = openpyxl.load_workbook(sys.argv[1]).active
    print(ws['A1'].value, ws['B2'].value, ws['C2'].value, ws['A2'].value.year)
except ImportError:
    print('time 13.25 ok & <fine> 2026')
`, file], { encoding: 'utf8' }).trim();
  assert.equal(out, 'time 13.25 ok & <fine> 2026');
});

// ---------- Integration ----------
const args = process.env.TITAN_TEST_PSQL?.split(' ').filter(Boolean);
const skip = !args;
const pool = skip ? null : new PsqlPool(args!);
const q = (t: string, v: unknown[] = []) => pool!.query(t, v);
const n = Date.now() % 1_000_000;
const pad = (x: number) => String(x).padStart(6, '0');
const L = (x: number) => String.fromCharCode(65 + (x % 26), 65 + (Math.floor(x / 26) % 26), 65 + (Math.floor(x / 676) % 26));
const PREFIX = 'Q' + L(n);
const DEV = `${PREFIX}-${pad(1)}`, PAYDEV = `${PREFIX}-${pad(2)}`, GG = `${PREFIX}-${pad(3)}`;
const OWNER = `owner${n}@farm.ng`, STAFF = `staff${n}@kitovu.com.ng`;
let server: Server, base = '', org = '', site = '', ownerCookie = '', staffCookie = '', apiKeyRaw = '';
const published: { topic: string; payload: any }[] = [];
const emails: { to: string | string[]; subject: string; text: string }[] = [];
const keys = deviceKeys(), ggKeys = deviceKeys();
let ext: ReturnType<typeof registerExtensions>;
let seq = 1;

before(async () => {
  if (skip) return;
  const store = new PostgresStore(pool as any);
  const broker = { async publish(topic: string, payload: string) { published.push({ topic, payload: JSON.parse(payload) }); } };
  const email = { async send(to: string | string[], subject: string, text: string) { emails.push({ to, subject, text }); return true; } };
  const sms = { async send() { return true; } };
  const dispatcher = new Dispatcher(store, email, sms, 'http://t');
  const actuators = new ActuatorService(pool!, broker);
  const carbon = new CarbonService(pool!);
  const pipeline = new IngestPipeline(store, dispatcher, [actuators, carbon]);
  const devices = new DeviceService(store, broker);
  const apiKey = createApiKeyAuth(store);
  const paystackHooks: any[] = [];
  const app = createApp({ store, pipeline, devices, email, billing: null, internalSecret: 's', publicUrl: 'http://t', demoInbox: 'x', mqtt: { host: 'm', port: 1 }, actuators, carbon, apiKey, paystackHooks, extraWebhookEvents: PAYG_EVENTS });
  const admin = registerAdmin(app, { pool: pool!, devices, actuators, carbon, secureCookies: false });
  const cons = registerConsole(app, { pool: pool!, store, devices, actuators, carbon, billing: null, publicUrl: 'http://t', secureCookies: false });
  const agent = new OpsAgent(pool!, new Writer(), email, 'http://t');
  ext = registerExtensions({
    app, pool: pool!, store, pipeline, devices, actuators, notifier: dispatcher, email, sms, apiKey, adminSession: admin.session as any, consoleWho: cons.who as any, agent,
    paystackSecret: '', paystackHooks, publicUrl: 'http://t', secureCookies: false, dataDir: mkdtempSync(join(tmpdir(), 'titan-data-')), backupDir: '/nonexistent',
    emqx: { apiUrl: 'http://127.0.0.1:1', key: '', secret: '' }, mqtt: { host: '127.0.0.1', port: 1 },
  });

  org = (await q(`INSERT INTO organisations (name, device_prefix) VALUES ($1,$2) RETURNING id`, [`Quality Farms ${n}`, PREFIX])).rows[0].id;
  site = (await q(`INSERT INTO sites (org_id, name) VALUES ($1,'Iseyin store') RETURNING id`, [org])).rows[0].id;
  const zone = (await q(`INSERT INTO zones (site_id, code) VALUES ($1,'B1') RETURNING id`, [site])).rows[0].id;
  await q(`INSERT INTO stacks (zone_id, code, commodity) VALUES ($1,'S1','rice')`, [zone]);
  await q(`INSERT INTO devices (id, org_id, site_id, type_id, token_hash, status) VALUES ($1,$2,$3,'wareguard-v1',$4,'online'),($5,$2,$3,'paygo-appliance-v1',$4,'online'),($6,$2,$3,'gradeguard-v1',$4,'online')`,
    [DEV, org, site, sha256Hex('tok'), PAYDEV, GG]);
  await q(`INSERT INTO device_keys (device_id, key_id, alg, public_key) VALUES ($1,'k1','ed25519',$2),($3,'k1','ed25519',$4)`, [DEV, keys.publicKey, GG, ggKeys.publicKey]);
  await q(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1,$2,'client_owner',$3)`, [org, OWNER, await hashPassword('owner-password-1')]);
  const kit = (await q(`SELECT id FROM organisations WHERE kind = 'kitovu' LIMIT 1`)).rows[0].id;
  await q(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1,$2,'admin',$3)`, [kit, STAFF, await hashPassword('staff-password-1')]);
  apiKeyRaw = `tk_live_${'k'.repeat(10)}${n}${'x'.repeat(14)}`;
  await q(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes) VALUES ($1,'all',$2,$3,$4)`,
    [org, apiKeyRaw.slice(0, 12), sha256Hex(apiKeyRaw), ['manage:firmware', 'manage:payg', 'read:quality', 'write:quality', 'export:data', 'read:carbon', 'write:carbon', 'manage:webhooks']]);

  server = createServer(app.handler());
  server.keepAliveTimeout = 120_000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ownerCookie = (await call('POST', '/console/api/login', { email: OWNER, password: 'owner-password-1' })).cookie;
  staffCookie = (await call('POST', '/admin/api/login', { email: STAFF, password: 'staff-password-1' })).cookie;
});
after(() => server?.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? new Uint8Array(body as Buffer) : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, json: type.includes('json') && buf.length ? JSON.parse(buf.toString()) : null, text: buf.toString(), buf, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
const asOwner = (m: string, p: string, b?: unknown) => call(m, p, b, { Cookie: ownerCookie, 'X-Titan-Console': '1' });
const asStaff = (m: string, p: string, b?: unknown) => call(m, p, b, { Cookie: staffCookie, 'X-Titan-Admin': '1' });
const asKey = (m: string, p: string, b?: unknown) => call(m, p, b, { Authorization: `Bearer ${apiKeyRaw}` });
const ingest = (dev: string, kind: string, body: object, k = keys) =>
  call('POST', '/api/ingest', Buffer.from(k.envelope({ v: 1, dev, seq: seq++, ts: Math.floor(Date.now() / 1000), up: 1, buf: false, ...body })), { Authorization: `Device ${dev}:tok`, 'X-Titan-Kind': kind });

test('firmware: signed release, batched rollout, download, ack and install', { skip }, async () => {
  const bin = Buffer.from('ESP32-FIRMWARE-' + 'x'.repeat(5000));
  const up = await call('POST', `/console/api/firmware?type=wareguard-v1&version=2.1.0&notes=Faster%20GSM`, bin, { Cookie: ownerCookie, 'X-Titan-Console': '1', 'Content-Type': 'application/octet-stream' });
  assert.equal(up.status, 201, up.text);
  const rel = up.json.release;
  // The signature is Ed25519 over the SHA-256 digest, checkable with the published key.
  const pk = (await call('GET', '/api/firmware/public-key')).json.publicKey;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pk }, format: 'jwk' });
  assert.ok(verify(null, Buffer.from(rel.sha256, 'hex'), key, Buffer.from(rel.signature, 'base64url')));
  assert.equal((await call('POST', `/console/api/firmware?type=wareguard-v1&version=2.1.0`, bin, { Cookie: ownerCookie, 'X-Titan-Console': '1' })).status, 409);

  const ro = await asOwner('POST', `/console/api/firmware/${rel.id}/rollouts`, { batchSize: 5 });
  assert.equal(ro.status, 201, ro.text);
  assert.equal(ro.json.devices, 1);
  const cmd = published.find((p) => p.topic === `titan/v1/${DEV}/down/cmd` && p.payload.cmd === 'ota.update');
  assert.ok(cmd, 'ota.update sent to the online device');
  assert.equal(cmd!.payload.args.sha256, rel.sha256);

  // Download needs the device's own token and a release of its type.
  assert.equal((await call('GET', `/api/device/firmware/${rel.id}`)).status, 401);
  const dl = await call('GET', `/api/device/firmware/${rel.id}`, undefined, { Authorization: `Device ${DEV}:tok` });
  assert.equal(dl.status, 200);
  assert.ok(dl.buf.equals(bin));
  assert.equal(dl.headers.get('x-titan-sha256'), rel.sha256);
  assert.equal((await call('GET', `/api/device/firmware/${rel.id}`, undefined, { Authorization: `Device ${PAYDEV}:tok` })).status, 404, 'other device types cannot fetch it');

  await ingest(DEV, 'ack', { ack: { id: cmd!.payload.id, ok: true } });
  let st = (await q(`SELECT state FROM device_firmware WHERE device_id = $1`, [DEV])).rows[0].state;
  assert.equal(st, 'downloading');
  await ingest(DEV, 'state', { fw: '2.1.0', st: { rssi: -60 } });
  st = (await q(`SELECT state, current_version FROM device_firmware WHERE device_id = $1`, [DEV])).rows[0];
  assert.deepEqual([st.state, st.current_version], ['installed', '2.1.0']);
  await ext.firmware.tick();
  const view = await asOwner('GET', `/console/api/firmware/rollouts/${ro.json.rollout.id}`);
  assert.equal(view.json.rollout.status, 'done');
});

test('PAYG: payments unlock until a date, duplicates are safe, expiry locks, paid off unlocks for good', { skip }, async () => {
  const plan = await asKey('POST', '/v1/payg/plans', { name: 'Fridge 12 months', pricePerDay: 500, totalPrice: 2000, graceHours: 0 });
  assert.equal(plan.status, 201, plan.text);
  const acc = await asKey('POST', '/v1/payg/accounts', { deviceId: PAYDEV, planId: plan.json.plan.id, customerName: 'Mrs Oleka', customerPhone: '+2348000000000', customerRef: 'C-77' });
  assert.equal(acc.status, 201, acc.text);
  const id = acc.json.account.id;
  assert.ok(published.some((p) => p.topic === `titan/v1/${PAYDEV}/down/cmd` && p.payload.cmd === 'paygo.lock'), 'starts locked');

  const pay = await asKey('POST', `/v1/payg/accounts/${id}/payments`, { amount: 1000, reference: 'MOMO-1' });
  assert.equal(pay.status, 201, pay.text);
  const until = new Date(pay.json.account.credit_until).getTime();
  assert.ok(Math.abs(until - (Date.now() + 48 * 3_600_000)) < 120_000, '₦1000 at ₦500/day buys 2 days');
  const unlock = published.filter((p) => p.payload.cmd === 'paygo.unlock').at(-1)!;
  assert.equal(unlock.payload.args.until, Math.floor(until / 1000));
  const dup = await asKey('POST', `/v1/payg/accounts/${id}/payments`, { amount: 1000, reference: 'MOMO-1' });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.duplicate, true);

  // Credit runs out → the worker locks it.
  await q(`UPDATE payg_accounts SET credit_until = now() - interval '1 hour' WHERE id = $1`, [id]);
  const before = published.length;
  await ext.payg.tick();
  assert.ok(published.slice(before).some((p) => p.payload.cmd === 'paygo.lock'));
  // Paying the rest makes it paid off: unlock with until 0.
  const last = await asKey('POST', `/v1/payg/accounts/${id}/payments`, { amount: 1000, reference: 'MOMO-2' });
  assert.equal(last.json.account.status, 'paid_off');
  assert.equal(published.filter((p) => p.payload.cmd === 'paygo.unlock').at(-1)!.payload.args.until, 0);
  const page = await call('GET', `/pay/${acc.json.account.code}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('fully paid'));
  assert.ok(!page.text.includes('Oleka'), 'the public page shows only the first name');
});

test('self-serve sign-up: confirm email, trial plan, plan device limit', { skip }, async () => {
  const planId = `starter-${n}`;
  await q(`INSERT INTO plans (id, name, base_fee, price_per_device, published, self_serve, trial_days, device_limit) VALUES ($1,'Starter',0,1500,true,true,14,1)`, [planId]);
  assert.ok((await call('GET', '/api/signup/plans')).json.plans.some((p: any) => p.id === planId));
  const email = `new${n}@aquaponics.ng`;
  const s = await call('POST', '/api/signup', { company: 'Lagos Aquaponics Ltd', name: 'Ada', email, password: 'a-good-password-1', planId, useCase: 'aquaponics' });
  assert.equal(s.status, 201, s.text);
  const login = await call('POST', '/console/api/login', { email, password: 'a-good-password-1' });
  assert.equal(login.status, 403, 'must confirm email first');
  const mail = emails.find((m) => m.to === email && /Confirm/.test(m.subject))!;
  const link = /\/api\/signup\/verify\?token=([\w-]+)/.exec(mail.text)![1];
  const v = await call('GET', `/api/signup/verify?token=${link}`);
  assert.equal(v.status, 302);
  assert.equal(v.headers.get('location'), '/console/#welcome');
  const cookie = v.cookie;
  const sub = await call('GET', '/console/api/subscription', undefined, { Cookie: cookie });
  assert.equal(sub.json.subscription.status, 'trialing');
  const me = await call('GET', '/console/api/me', undefined, { Cookie: cookie });
  assert.match(me.json.devicePrefix, /^[A-Z]{2,6}$/);
  const siteId = (await call('POST', '/console/api/sites', { name: 'Tanks', kind: 'aquaponics' }, { Cookie: cookie, 'X-Titan-Console': '1' })).json.site.id;
  const d1 = await call('POST', '/console/api/devices', { id: `${me.json.devicePrefix}-000001`, siteId, typeId: 'titan-controller-v1' }, { Cookie: cookie, 'X-Titan-Console': '1' });
  assert.equal(d1.status, 201, d1.text);
  const d2 = await call('POST', '/console/api/devices', { id: `${me.json.devicePrefix}-000002`, siteId, typeId: 'titan-controller-v1' }, { Cookie: cookie, 'X-Titan-Console': '1' });
  assert.equal(d2.status, 402, 'Starter allows 1 device');
  // Verification links are single-use; password reset works.
  assert.equal((await call('GET', `/api/signup/verify?token=${link}`)).headers.get('location'), '/console/#login?verify=expired');
  await call('POST', '/api/password/forgot', { email });
  const reset = /#reset\?token=([\w-]+)/.exec(emails.filter((m) => m.to === email).at(-1)!.text)![1];
  assert.equal((await call('POST', '/api/password/reset', { token: reset, password: 'another-password-2' })).status, 200);
  assert.equal((await call('POST', '/console/api/login', { email, password: 'another-password-2' })).status, 200);
});

test('GradeGuard: specs, manual and device tests, lots, custody and trace', { skip }, async () => {
  const spec = await asOwner('POST', '/console/api/quality/specs', { name: 'Olam paddy grade 1', buyer: 'Olam', commodity: 'rice', parameters: [{ key: 'moisture', max: 14 }, { key: 'foreign_matter', max: 2 }] });
  assert.equal(spec.status, 201, spec.text);
  const lot = await asOwner('POST', '/console/api/lots', { code: `RICE-${n}`, commodity: 'rice', quantity: 2500, origin: 'Iwawon cluster', lat: 7.97, lng: 3.59 });
  assert.equal(lot.status, 201, lot.text);
  const code = lot.json.lot.code;
  // Offline app re-sending the same test does not duplicate it.
  const t1 = await asOwner('POST', '/console/api/quality/tests', { lot: code, specId: spec.json.spec.id, results: { moisture: 15.2, foreign_matter: 1 }, clientRef: `app-${n}-1` });
  const t1b = await asOwner('POST', '/console/api/quality/tests', { lot: code, specId: spec.json.spec.id, results: { moisture: 15.2, foreign_matter: 1 }, clientRef: `app-${n}-1` });
  assert.equal(t1.json.test.outcome, 'fail');
  assert.equal(t1.json.test.id, t1b.json.test.id);
  // A GradeGuard device sends a signed quality test.
  const dev = await ingest(GG, 'telemetry', { r: [['sample.moisture', 13.4, 's'], ['sample.foreign_matter', 1.1, 's']], qt: { lot: code, spec: spec.json.spec.id, sample: 'bag 14' } }, ggKeys);
  assert.equal(dev.json.status, 'accepted', dev.text);
  const tests = (await asKey('GET', `/v1/quality/tests?lot=${code}`)).json.tests;
  assert.equal(tests.length, 2);
  const fromDevice = tests.find((t: any) => t.device_id === GG);
  assert.equal(fromDevice.outcome, 'pass');
  assert.ok(fromDevice.device_seq, 'linked to the signed message');

  assert.equal((await asOwner('POST', `/console/api/lots/${code}/events`, { kind: 'stored', siteId: site, stack: 'B1/S1' })).status, 201);
  await q(`INSERT INTO readings (time, org_id, site_id, device_id, channel, metric, value) VALUES (now(), $1, $2, $3, 'B1/S1', 'produce.moisture', 13.1)`, [org, site, DEV]);
  assert.equal((await asOwner('POST', `/console/api/lots/${code}/events`, { kind: 'dispatched', counterparty: 'Olam Kano' })).status, 201);
  const tr = await asKey("GET", `/v1/lots/${code}`);
  assert.equal(tr.status, 200, tr.text);
  const trace = tr.json;
  // The device's test is stamped with its own (second-resolution) clock, so it may sort just before creation.
  const kinds = trace.events.map((e: any) => e.kind);
  assert.deepEqual(kinds.slice(0, 3).sort(), ['created', 'tested', 'tested']);
  assert.deepEqual(kinds.slice(3), ['stored', 'dispatched']);
  assert.equal(trace.lot.status, 'dispatched');
  assert.equal(trace.storage.length, 1);
  assert.ok(trace.storage[0].conditions.some((c: any) => c.metric === 'produce.moisture'));
});

test('exports: CSV and Excel, scoped to the organisation', { skip }, async () => {
  const csv = await asOwner('GET', '/console/api/export/quality-tests?format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition')!, /attachment; filename="titan-quality-tests-/);
  assert.ok(csv.text.includes('Olam paddy grade 1'));
  const xlsx = await asKey('GET', '/v1/export/readings?format=xlsx&interval=1h');
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.buf.subarray(0, 2).toString(), 'PK');
  const devices = await asOwner('GET', '/console/api/export/devices');
  assert.ok(devices.text.includes(DEV) && !devices.text.includes('WG-'), 'only this organisation’s devices');
  assert.equal((await asOwner('GET', '/console/api/export/nope')).status, 404);
});

test('verification: assign a verifier, findings, statement, registry package', { skip }, async () => {
  const project = (await q(`INSERT INTO carbon_projects (org_id, name, methodology, site_ids) VALUES ($1,'Kiln project','biochar-v1',$2) RETURNING id`, [org, [site]])).rows[0].id;
  const act = (await q(`INSERT INTO carbon_activities (project_id, org_id, site_id, kind, reference, started_at, ended_at, status, result, created_by)
    VALUES ($1,$2,$3,'batch','B-001', now() - interval '1 day', now(), 'calculated', $4, 'test') RETURNING id`, [project, org, site, JSON.stringify({ status: 'ok', netTco2e: 1.25 })])).rows[0].id;
  const verifierEmail = `auditor${n}@vvb.example`;
  const inv = await asOwner('POST', `/console/api/carbon/projects/${project}/verifiers`, { email: verifierEmail, organisation: `Green VVB ${n}` });
  assert.equal(inv.status, 201, inv.text);
  const token = /#reset\?token=([\w-]+)/.exec(emails.filter((m) => m.to === verifierEmail).at(-1)!.text)![1];
  assert.equal((await call('POST', '/api/password/reset', { token, password: 'verifier-password-1' })).status, 200);
  const vc = (await call('POST', '/verify/api/login', { email: verifierEmail, password: 'verifier-password-1' })).cookie;
  const V = (m: string, p: string, b?: unknown) => call(m, p, b, { Cookie: vc, 'X-Titan-Verify': '1' });
  assert.equal((await V('GET', '/verify/api/projects')).json.projects.length, 1);
  const view = await V('GET', `/verify/api/projects/${project}`);
  assert.equal(view.json.evidence.totals.netTco2e, 1.25);

  const finding = await V('POST', `/verify/api/projects/${project}/findings`, { activityId: act, kind: 'corrective_action', text: 'Lab certificate missing' });
  assert.equal(finding.status, 201);
  const blocked = await V('POST', `/verify/api/projects/${project}/statements`, { activityIds: [act], opinion: 'positive', verifiedTco2e: 1.2, statement: 'ok' });
  assert.equal(blocked.status, 400, 'open corrective actions block a positive opinion');
  assert.equal((await asOwner('POST', `/console/api/carbon/findings/${finding.json.finding.id}/respond`, { response: 'Uploaded' })).status, 200);
  await V('POST', `/verify/api/findings/${finding.json.finding.id}/close`);
  assert.equal((await V('POST', `/verify/api/projects/${project}/statements`, { activityIds: [act], opinion: 'positive', verifiedTco2e: 2, statement: 'ok' })).status, 400, 'cannot verify more than calculated');
  const stmt = await V('POST', `/verify/api/projects/${project}/statements`, { activityIds: [act], opinion: 'positive', verifiedTco2e: 1.2, statement: 'Reasonable assurance.' });
  assert.equal(stmt.status, 201, stmt.text);

  // Verifier API key works on /v1/verification and only there.
  const key = (await V('POST', '/verify/api/keys', { name: 'audit tool' })).json.key;
  assert.equal((await call('GET', '/v1/verification/projects', undefined, { Authorization: `Bearer ${key}` })).json.projects.length, 1);
  assert.equal((await call('GET', '/v1/verification/projects', undefined, { Authorization: `Bearer ${apiKeyRaw}` })).status, 403);

  const sub = await asOwner('POST', `/console/api/carbon/projects/${project}/submissions`, { registry: 'puro', statementId: stmt.json.statement.id });
  assert.equal(sub.status, 201, sub.text);
  assert.equal(Number(sub.json.submission.claimed_tco2e), 1.2);
  const zip = await asOwner('GET', `/console/api/carbon/submissions/${sub.json.submission.id}/package`);
  assert.equal(zip.status, 200);
  assert.equal(zip.buf.subarray(0, 2).toString(), 'PK');
  const issued = await asOwner('POST', `/console/api/carbon/submissions/${sub.json.submission.id}/status`, { status: 'issued', issuedTco2e: 1.2, serialFrom: 'PURO-1', serialTo: 'PURO-1' });
  assert.equal(issued.json.submission.status, 'issued');
});

test('field app: one sign-in for staff and clients, install a device', { skip }, async () => {
  const s = await call('POST', '/app/api/login', { email: STAFF, password: 'staff-password-1' });
  assert.equal(s.json.mode, 'kitovu');
  const me = await call('GET', '/app/api/me', undefined, { Cookie: s.cookie });
  assert.equal(me.json.api, '/admin/api');
  const c = await call('POST', '/app/api/login', { email: OWNER, password: 'owner-password-1' });
  assert.equal(c.json.mode, 'client');
  const H = { Cookie: c.cookie, 'X-Titan-Console': '1', 'X-Titan-Admin': '1' };
  const home = await call('GET', '/app/api/home', undefined, H);
  assert.ok(home.json.sites.every((x: any) => x.org_name.startsWith('Quality Farms')));
  const inst = await call('POST', '/app/api/devices/install', { id: `${PREFIX}-000009`, siteId: site, typeId: 'wareguard-v1' }, H);
  assert.equal(inst.status, 201, inst.text);
  assert.match(inst.json.provisioningCode, /\w{6,}/);
  const detail = await call('GET', `/app/api/sites/${site}`, undefined, H);
  assert.ok(detail.json.devices.some((d: any) => d.id === `${PREFIX}-000009`));
});

test('health: deep check reports components without leaking details', { skip }, async () => {
  await ext.health.beat('workers');
  const h = await call('GET', '/healthz/deep');
  assert.ok([200, 503].includes(h.status));
  const names = h.json.checks.map((c: any) => c.name);
  for (const nm of ['database', 'workers', 'mqtt broker']) assert.ok(names.includes(nm), nm);
  assert.equal(h.json.checks.find((c: any) => c.name === 'database').ok, true);
  assert.ok(!('detail' in h.json.checks[0]));
  const adm = await asStaff('GET', '/admin/api/health');
  assert.ok(adm.json.checks[0].detail);
});

test('evidence fingerprint ignores readiness and registry labels', { skip }, async () => {
  const project = (await q(`SELECT id FROM carbon_projects WHERE org_id = $1 LIMIT 1`, [org])).rows[0].id;
  const a = await ext.registry.evidence(project);
  await q(`UPDATE carbon_projects SET registry = 'Isometric' WHERE id = $1`, [project]);
  const b = await ext.registry.evidence(project);
  assert.equal(a.sha256, b.sha256);
  await q(`UPDATE carbon_activities SET result = jsonb_set(result, '{netTco2e}', '1.3') WHERE project_id = $1`, [project]);
  const c = await ext.registry.evidence(project);
  assert.notEqual(a.sha256, c.sha256, 'a changed result changes the fingerprint');
});

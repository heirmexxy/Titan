// Runs the Postgres store's SQL against a real database. Skipped unless TITAN_TEST_PSQL is set,
// e.g. TITAN_TEST_PSQL="-h /tmp -p 5544 -U titan titan_test" (database must have the migrations applied).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresStore } from '../src/store/postgres.js';
import { PsqlPool } from './psql-pool.js';

const args = process.env.TITAN_TEST_PSQL?.split(' ').filter(Boolean);

test('postgres store SQL runs against a real database', { skip: !args }, async () => {
  const pool = new PsqlPool(args!);
  const store = new PostgresStore(pool as any);
  const q = (t: string, v: unknown[] = []) => pool.query(t, v);

  const org = (await q(`INSERT INTO organisations (name, kind) VALUES ('Test Org', 'client') RETURNING id`)).rows[0].id;
  const lender = (await q(`INSERT INTO organisations (name, kind) VALUES ('Lender', 'consumer') RETURNING id`)).rows[0].id;
  const site = (await q(`INSERT INTO sites (org_id, name) VALUES ($1, 'WH') RETURNING id`, [org])).rows[0].id;
  const zone = (await q(`INSERT INTO zones (site_id, code) VALUES ($1, 'z1') RETURNING id`, [site])).rows[0].id;
  await q(`INSERT INTO stacks (zone_id, code, commodity) VALUES ($1, 'stack-a', 'maize')`, [zone]);
  const dev = `WG-${Date.now() % 1_000_000}`;
  await q(`INSERT INTO devices (id, org_id, site_id, type_id) VALUES ($1,$2,$3,'wareguard-v1')`, [dev, org, site]);

  const d = await store.getDevice(dev);
  assert.equal(d?.id, dev);
  await store.setProvisionCode(dev, 'h', new Date(Date.now() + 1000));
  await store.addDeviceKey(dev, { keyId: 'k1', alg: 'ed25519', publicKey: 'x'.repeat(43) });
  assert.equal(await store.countDeviceKeys(dev), 1);
  assert.equal((await store.getDeviceKey(dev, 'k1'))?.alg, 'ed25519');
  await store.completeProvisioning(dev, 'tokenhash');
  assert.ok((await store.getMetrics()).has('air.temperature'));
  assert.equal((await store.getZoneCrops(site)).get('z1')?.[0].crop.crop, 'maize');

  const now = new Date();
  assert.equal(await store.markDeviceSeen(dev, now, 5, { net: 'wifi' }), 'came_online');
  assert.equal(await store.markDeviceSeen(dev, now, 6), 'already_online');
  assert.equal((await store.listStaleDevices(new Date(now.getTime() + 3600_000))).length >= 1, true);
  await store.saveConfig(dev, 1, { interval: { heartbeat_s: 60 } }, null);
  await store.ackConfig(dev, 1, now);

  assert.equal(await store.insertMessage({ deviceId: dev, seq: 6, kind: 'telemetry', keyId: 'k1', payloadB64: 'p', sigB64: 's', receivedAt: now }), true);
  assert.equal(await store.insertMessage({ deviceId: dev, seq: 6, kind: 'telemetry', keyId: 'k1', payloadB64: 'p', sigB64: 's', receivedAt: now }), false);
  assert.equal((await store.getMessage(dev, 6))?.payloadB64, 'p');
  await store.insertReadings([
    { time: now, orgId: org, siteId: site, deviceId: dev, channel: 'z1/dht22', metric: 'air.temperature', value: 28.5, quality: 'ok', flags: 0, seq: 6, cal: null },
    { time: new Date(now.getTime() - 60_000), orgId: org, siteId: site, deviceId: dev, channel: 'z1/dht22', metric: 'air.temperature', value: 27.5, quality: 'ok', flags: 1, seq: 5, cal: null },
  ]);
  await store.insertEvent({ time: now, orgId: org, siteId: site, deviceId: dev, code: 'boot', severity: 'info', channel: null, message: null, seq: 6 });
  const raw = await store.queryReadings({ siteIds: [site], metrics: ['air.temperature'], from: new Date(now.getTime() - 3600_000), to: new Date(now.getTime() + 1000), interval: 'raw', limit: 10 });
  assert.equal(raw.length, 2);
  const agg = await store.queryReadings({ siteIds: [site], from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 1000), interval: '1d', limit: 10 });
  assert.ok(agg.length >= 1);
  assert.equal((await store.latestReadings([site], ['air.temperature']))[0].value, 28.5);

  const rule = (await q(`INSERT INTO alert_rules (org_id, metric, op, threshold) VALUES ($1, 'air.temperature', 'gt', 35) RETURNING id`, [org])).rows[0].id;
  assert.equal((await store.listRulesFor(org)).length, 1);
  await store.setRuleState(rule, dev, 'z1/dht22', { breachSince: now, alertId: null });
  assert.ok((await store.getRuleState(rule, dev, 'z1/dht22')).breachSince);
  const alert = await store.openAlert({ orgId: org, siteId: site, deviceId: dev, channel: null, ruleId: null, code: 'device_offline', severity: 'warning', title: 'offline', value: null, openedAt: now });
  assert.equal((await store.findOpenAlert(org, dev, 'device_offline', null))?.id, alert.id);
  assert.equal((await store.listAlerts([site], 'open', 10)).length, 1);
  assert.equal((await store.resolveAlert(alert.id, now))?.status, 'resolved');
  assert.equal(await store.markDeviceOffline(dev), true);
  await q(`INSERT INTO notification_contacts (org_id, channel, address) VALUES ($1, 'email', 'a@b.c')`, [org]);
  assert.equal((await store.listContacts(org)).length, 1);

  const keyId = await store.createApiKey(org, 'k', 'tk_live_x', `hash-${dev}`, ['read:readings']);
  assert.equal((await store.getApiKeyByHash(`hash-${dev}`))?.id, keyId);
  await store.touchApiKey(keyId);
  const grant = await store.createGrant({ ownerOrgId: org, granteeOrgId: lender, siteIds: [site], metrics: ['air.temperature'], validFrom: null, validTo: null, live: true });
  assert.equal((await store.listActiveGrantsFor(lender)).length, 1);
  assert.equal((await store.listActiveGrantsFrom(org)).length, 1);
  assert.equal(await store.revokeGrant(grant.id, org), true);
  assert.equal((await store.getSites([site])).length, 1);
  assert.equal((await store.listSitesForOrg(org)).length, 1);
  assert.equal((await store.listDevices([site])).length, 1);

  const wh = await store.createWebhook(org, 'https://x.test', ['alert.*'], 'sec');
  assert.equal((await store.listWebhooks([org], 'alert.opened')).length, 1);
  assert.equal((await store.listOrgWebhooks(org)).length, 1);
  await store.enqueueDelivery(wh.id, 'alert.opened', { a: 1 });
  const due = await store.dueDeliveries(new Date(Date.now() + 1000), 10);
  assert.equal(due[0].webhook.url, 'https://x.test');
  await store.recordDelivery(due[0].id, false, 500, new Date(Date.now() + 60_000));
  assert.equal(await store.deleteWebhook(wh.id, org), true);

  const day = now.toISOString().slice(0, 10);
  await store.addUsage(org, day, { messages: 1, readings: 2 });
  await store.addUsage(org, day, { apiCalls: 3 });
  await store.markActiveDevice(org, day, dev);
  await store.markActiveDevice(org, day, dev);
  assert.equal((await q(`SELECT messages, api_calls FROM usage_daily WHERE org_id = $1`, [org])).rows[0].api_calls, '3');
  assert.deepEqual(await store.listPublishedPlans(), []);
  await store.saveDemoRequest({ name: 'Ada', email: 'a@b.c' });
  await store.audit('system', org, 'test', null, { ok: true });
});

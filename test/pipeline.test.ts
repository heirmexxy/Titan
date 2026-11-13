import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IngestPipeline } from '../src/ingest/pipeline.js';
import { FLAG_BUFFERED, FLAG_TIME_ESTIMATED } from '../src/store/types.js';
import { body, deviceKeys, ORG, RecordingNotifier, seededStore, SITE } from './helpers.js';

function setup() {
  const { store, device } = seededStore();
  const keys = deviceKeys();
  store.keys.set(`${device.id}/k1`, { keyId: 'k1', alg: 'ed25519', publicKey: keys.publicKey });
  const notifier = new RecordingNotifier();
  return { store, device, keys, notifier, pipeline: new IngestPipeline(store, notifier) };
}

const telemetry = (over: Record<string, unknown> = {}) => body({
  r: [
    { m: 'air.temperature', v: 25, ch: 'z1/dht22' },
    { m: 'air.humidity', v: 70, ch: 'z1/dht22' },
    { m: 'produce.moisture_raw', v: 2310, ch: 'z1/stack-a/mst1' },
    { m: 'produce.moisture', v: 12.8, ch: 'z1/stack-a/mst1', cal: 'maize-cap-v2' },
  ],
  ...over,
});

test('accepts signed telemetry, stores readings and derived metrics, meters usage', async () => {
  const { store, pipeline, keys, notifier } = setup();
  const res = await pipeline.handle('WG-000123', 'telemetry', keys.envelope(telemetry()));
  assert.equal(res.status, 'accepted');
  const metrics = store.readings.map((r) => r.metric).sort();
  assert.deepEqual(metrics, ['air.dew_point', 'air.humidity', 'air.temperature', 'produce.emc', 'produce.moisture', 'produce.moisture_raw']);
  const emc = store.readings.find((r) => r.metric === 'produce.emc')!;
  assert.equal(emc.channel, 'z1/stack-a');
  assert.ok(emc.value > 13.5 && emc.value < 15, `maize EMC at 25°C/70% should be ~14.2, got ${emc.value}`);
  const dp = store.readings.find((r) => r.metric === 'air.dew_point')!;
  assert.ok(Math.abs(dp.value - 19.1) < 0.3, `dew point ~19.1, got ${dp.value}`);
  assert.equal(store.devices.get('WG-000123')!.status, 'online');
  assert.equal([...store.usage.values()][0].messages, 1);
  assert.equal(notifier.of('reading.created').length, 1);
  assert.equal(notifier.of('device.online').length, 1);
});

test('drops duplicates by device + seq', async () => {
  const { pipeline, keys } = setup();
  const env = keys.envelope(telemetry());
  assert.equal((await pipeline.handle('WG-000123', 'telemetry', env)).status, 'accepted');
  assert.equal((await pipeline.handle('WG-000123', 'telemetry', env)).status, 'duplicate');
});

test('rejects a tampered payload and opens a tamper alert once', async () => {
  const { store, pipeline, keys, notifier } = setup();
  const env = JSON.parse(keys.envelope(telemetry()));
  const forged = Buffer.from(Buffer.from(env.p, 'base64url').toString().replace('"v":25', '"v":15')).toString('base64url');
  const r1 = await pipeline.handle('WG-000123', 'telemetry', JSON.stringify({ ...env, p: forged }));
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.status === 'rejected' && r1.code, 'bad_signature');
  await pipeline.handle('WG-000123', 'telemetry', JSON.stringify({ ...env, p: forged }));
  assert.equal(store.alerts.filter((a) => a.code === 'tamper').length, 1);
  assert.equal(store.readings.length, 0);
  assert.equal(notifier.of('alert.opened').length, 1);
});

test('rejects messages signed for another device', async () => {
  const { pipeline, keys } = setup();
  const res = await pipeline.handle('WG-000123', 'telemetry', keys.envelope(telemetry({ dev: 'WG-999999' })));
  assert.equal(res.status === 'rejected' && res.code, 'device_mismatch');
});

test('flags out-of-range values and unknown metrics', async () => {
  const { store, pipeline, keys } = setup();
  const res = await pipeline.handle('WG-000123', 'telemetry', keys.envelope(body({
    r: [{ m: 'air.humidity', v: 140, ch: 'z1/dht22' }, { m: 'made.up', v: 1, ch: 'z1/x' }, { m: 'air.dew_point', v: 3, ch: 'z1/x' }],
  })));
  assert.equal(res.status, 'accepted');
  assert.deepEqual(res.status === 'accepted' && res.rejected, ['made.up', 'air.dew_point']);
  assert.equal(store.readings[0].quality, 'rejected');
});

test('buffered and unsynced-clock readings are labelled', async () => {
  const { store, pipeline, keys } = setup();
  const received = new Date('2026-11-13T10:00:00Z');
  await pipeline.handle('WG-000123', 'telemetry', keys.envelope(body({ ts: 0, up: 10_000, upn: 70_000, buf: true, r: [{ m: 'air.temperature', v: 30, ch: 'z1/dht22' }] })), received);
  const r = store.readings[0];
  assert.ok(r.flags & FLAG_BUFFERED);
  assert.ok(r.flags & FLAG_TIME_ESTIMATED);
  assert.equal(r.time.toISOString(), '2026-11-13T09:59:00.000Z');
});

test('threshold rule respects duration and hysteresis; buffered data does not page', async () => {
  const { store, pipeline, keys, notifier } = setup();
  store.rules.push({ id: 'r1', orgId: ORG, siteId: SITE, deviceId: null, channel: null, metric: 'air.temperature', op: 'gt', threshold: 35, durationS: 60, hysteresis: 2, severity: 'critical', name: null });
  const t0 = Math.floor(Date.parse('2026-11-13T10:00:00Z') / 1000);
  const send = (v: number, ts: number, buf = false) =>
    pipeline.handle('WG-000123', 'telemetry', keys.envelope(body({ ts, buf, r: [{ m: 'air.temperature', v, ch: 'z1/dht22' }] })));

  await send(40, t0 - 600, true); // buffered breach: stored, no alert
  assert.equal(store.alerts.length, 0);
  await send(36, t0);
  assert.equal(store.alerts.length, 0, 'not yet lasted 60 s');
  await send(37, t0 + 61);
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].severity, 'critical');
  await send(34, t0 + 120); // inside hysteresis band (33..35): stays open
  assert.equal(store.alerts[0].status, 'open');
  await send(32.5, t0 + 180);
  assert.equal(store.alerts[0].status, 'resolved');
  assert.equal(notifier.of('alert.resolved').length, 1);
});

test('intruder event opens an alert; config ack is recorded', async () => {
  const { store, pipeline, keys } = setup();
  store.devices.get('WG-000123')!.configVersion = 3;
  await pipeline.handle('WG-000123', 'event', keys.envelope(body({
    ev: { code: 'intruder_detected', ch: 'z1/pir1', sev: 'critical', msg: 'Motion detected' }, r: [{ m: 'security.motion', v: 1, ch: 'z1/pir1' }],
  })));
  assert.equal(store.alerts[0].code, 'intruder_detected');
  assert.equal(store.events[0].code, 'intruder_detected');
  await pipeline.handle('WG-000123', 'ack', keys.envelope(body({ ack: { cfg: 3, ok: true } })));
  assert.equal(store.devices.get('WG-000123')!.configAckedVersion, 3);
});

test('offline then online opens and resolves a device_offline alert', async () => {
  const { store, pipeline, keys } = setup();
  await pipeline.handle('WG-000123', 'telemetry', keys.envelope(telemetry()));
  await pipeline.deviceOffline('WG-000123');
  await pipeline.deviceOffline('WG-000123');
  assert.equal(store.alerts.filter((a) => a.code === 'device_offline').length, 1);
  await pipeline.handle('WG-000123', 'state', keys.envelope(body({ st: { net: 'wifi', rssi: -60 } })));
  assert.equal(store.alerts.find((a) => a.code === 'device_offline')!.status, 'resolved');
});

test('unknown device is rejected', async () => {
  const { pipeline, keys } = setup();
  const res = await pipeline.handle('WG-404404', 'telemetry', keys.envelope(telemetry({ dev: 'WG-404404' })));
  assert.equal(res.status === 'rejected' && res.code, 'unknown_device');
});

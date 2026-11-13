import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPolicy, CommandError, findCommand, validateArgs } from '../src/actuators/catalogue.js';
import { calculateBiochar, calculateCookstove, detectSessions, heldTemperature, permanenceFactor } from '../src/carbon/methodologies.js';

const t0 = Date.parse('2026-11-13T08:00:00Z');
const series = (vals: number[], stepMin = 1) => vals.map((v, i) => ({ time: new Date(t0 + i * stepMin * 60_000), value: v }));

test('held temperature needs the temperature sustained, not a spike', () => {
  const spike = series([300, 350, 800, 400, 420, 430, 440, 450, 455, 460, 470, 480, 490, 500]);
  assert.equal(heldTemperature(spike, 10), 400); // the 800 °C spike lasts one minute
  assert.equal(heldTemperature(series([300, 320]), 10), null, 'too short');
  const later = (pts: { time: Date; value: number }[]) => pts.map((p) => ({ ...p, time: new Date(p.time.getTime() + 60 * 60_000) }));
  assert.equal(heldTemperature([...series(Array(6).fill(650)), ...later(series(Array(6).fill(650)))], 10), null, 'a data gap breaks the run');
  assert.equal(heldTemperature([...series([650, 650, 650]), ...later(series(Array(12).fill(650)))], 10), 650);
});

test('permanence factor bands', () => {
  assert.equal(permanenceFactor(650), 0.89);
  assert.equal(permanenceFactor(500), 0.8);
  assert.equal(permanenceFactor(400), 0.65);
  assert.equal(permanenceFactor(300), null);
});

test('biochar: complete batch', () => {
  const r = calculateBiochar({ biocharMassKg: 1000, moisturePct: 5, organicCarbonPct: 80, hCorg: 0.3, heldTempC: 620 }, { emissionsTco2ePerT: 0.2, bufferPct: 10 });
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.dryBiocharT, 0.95);
  assert.equal(r.carbonT, 0.76);
  assert.equal(r.grossTco2e, 2.4801); // 0.76 × 0.89 × 44/12
  assert.equal(r.emissionsTco2e, 0.19);
  assert.equal(r.netTco2e, Math.round((2.4801 - 0.19) * 0.9 * 1e4) / 1e4);
});

test('biochar: missing lab results and ineligible batches', () => {
  const missing = calculateBiochar({ biocharMassKg: 500, moisturePct: null, organicCarbonPct: null, hCorg: null, heldTempC: 600 });
  assert.equal(missing.status, 'incomplete');
  assert.deepEqual(missing.missing, ['biochar moisture', 'lab organic carbon', 'lab H/Corg']);
  assert.equal(calculateBiochar({ biocharMassKg: 500, moisturePct: 5, organicCarbonPct: 70, hCorg: 0.8, heldTempC: 600 }).status, 'ineligible');
  assert.equal(calculateBiochar({ biocharMassKg: 500, moisturePct: 5, organicCarbonPct: 70, hCorg: 0.3, heldTempC: 320 }).status, 'ineligible');
});

test('cookstove sessions from stove temperature', () => {
  // warm-up, 30 min cooking, cool-down, short flare (ignored), then a gap that ends a session
  const vals = [25, 30, ...Array(30).fill(120), 40, 30, 70, 70, 30, 25];
  const s = detectSessions(series(vals));
  assert.equal(s.length, 1);
  assert.equal(s[0].minutes, 30);
});

test('cookstove reductions need all parameters', () => {
  const sessions = { 'CK-000001': [{ start: new Date(t0), end: new Date(t0 + 3600_000), minutes: 60 }], 'CK-000002': [] };
  const inc = calculateCookstove(sessions, { baselineFuelKgPerHour: 1.5 });
  assert.equal(inc.status, 'incomplete');
  const ok = calculateCookstove(sessions, { baselineFuelKgPerHour: 1.5, fuelSavingFraction: 0.5, fNRB: 0.8, efTco2PerTFuel: 1.75 });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.activeDevices, 1);
  assert.equal(ok.cookingHours, 1);
  assert.equal(ok.netTco2e, Math.round(0.00075 * 0.8 * 1.75 * 1e4) / 1e4);
});

test('command catalogue: policy and argument checks', () => {
  const type = [{ name: 'relay.set', label: 'Switch', args: { channel: { type: 'string' as const }, on: { type: 'boolean' as const } }, allow: ['admin', 'api', 'automation'] as const }];
  const spec = findCommand(type as any, 'relay.set')!;
  assert.deepEqual(validateArgs(spec, { channel: 'fan1', on: 'true' }), { channel: 'fan1', on: true });
  assert.throws(() => validateArgs(spec, { channel: 'fan1' }), CommandError);
  assert.throws(() => validateArgs(spec, { channel: 'fan1', on: true, extra: 1 }), CommandError);
  assert.throws(() => checkPolicy(spec, 'ops'), CommandError);
  checkPolicy(findCommand([], 'send_state')!, 'automation');
  assert.throws(() => checkPolicy(findCommand([], 'reboot')!, 'api'), CommandError);
  assert.equal(findCommand([], 'self_destruct'), null);
});

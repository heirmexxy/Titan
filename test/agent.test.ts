import assert from 'node:assert/strict';
import { test } from 'node:test';
import { biocharReadiness, correlate, countSpikes, findDrift, isStuck, readinessStatus, seqResets, type DeviceInfo, type OpenAlert } from '../src/agent/analysis.js';
import { OpsAgent, renderReportHtml } from '../src/agent/ops-agent.js';
import { Writer } from '../src/agent/writer.js';
import { PsqlPool } from './psql-pool.js';

const t0 = Date.parse('2026-11-13T10:00:00Z');
const at = (min: number) => new Date(t0 + min * 60_000);
const alert = (id: string, device: string, min: number, extra: Partial<OpenAlert> = {}): OpenAlert =>
  ({ id, orgId: 'o', siteId: 's1', siteName: 'Iseyin', deviceId: device, code: 'device_offline', severity: 'warning', openedAt: at(min), ...extra });
const dev = (id: string, gw: string | null = null, type = 'wareguard-v1'): [string, DeviceInfo] => [id, { id, siteId: 's1', gatewayId: gw, typeId: type, status: 'offline' }];

test('incidents: power outage, connectivity, gateway and site-wide condition', () => {
  const devices = new Map([dev('WG-1'), dev('WG-2'), dev('WG-3'), dev('GW-1', null, 'titan-lora-gateway-v1'), dev('CK-1', 'GW-1'), dev('CK-2', 'GW-1')]);
  const power = correlate([alert('a', 'WG-1', 0), alert('b', 'WG-2', 4), alert('c', 'WG-3', 9)], devices, [{ siteId: 's1', deviceId: 'WG-1', code: 'power_lost', time: at(-1) }]);
  assert.equal(power.length, 1);
  assert.equal(power[0].cause, 'power_outage');
  assert.equal(power[0].title, 'Power is out at Iseyin');
  assert.deepEqual(power[0].alertIds, ['a', 'b', 'c']);

  const net = correlate([alert('a', 'WG-1', 0), alert('b', 'WG-2', 5)], devices, []);
  assert.equal(net[0].cause, 'site_connectivity');
  const apart = correlate([alert('a', 'WG-1', 0), alert('b', 'WG-2', 60)], devices, []);
  assert.equal(apart.length, 0, 'an hour apart: separate problems');

  const gw = correlate([alert('g', 'GW-1', 0), alert('x', 'CK-1', 1), alert('y', 'CK-2', 2), alert('z', 'WG-1', 40)], devices, []);
  assert.equal(gw.length, 1);
  assert.equal(gw[0].cause, 'gateway_down');
  assert.deepEqual(gw[0].alertIds.sort(), ['g', 'x', 'y']);

  const cond = correlate([
    alert('h1', 'WG-1', 0, { code: 'threshold', metric: 'air.humidity', severity: 'critical' }),
    alert('h2', 'WG-2', 3, { code: 'threshold', metric: 'air.humidity' }),
    alert('t1', 'WG-3', 3, { code: 'threshold', metric: 'air.temperature' }),
  ], devices, []);
  assert.equal(cond.length, 1);
  assert.equal(cond[0].cause, 'site_condition');
  assert.equal(cond[0].severity, 'critical');
});

const series = (vals: number[], stepMin = 5) => vals.map((v, i) => ({ time: at(i * stepMin), value: v }));
test('sensor health: stuck, spikes, drift, sequence resets', () => {
  assert.equal(isStuck(series(Array(30).fill(27.3)), 'air.temperature').stuck, true);
  assert.equal(isStuck(series(Array.from({ length: 30 }, (_, i) => 27 + (i % 3) * 0.2)), 'air.temperature').stuck, false);
  assert.equal(isStuck(series(Array(5).fill(27.3)), 'air.temperature').stuck, false, 'too few samples');
  assert.equal(countSpikes(series([27, 27.2, 45, 27.1, 27, 44, 27, 27.3]), 'air.temperature'), 4);
  const drift = findDrift('air.temperature', { a: 28, b: 28.2, c: 27.9, d: 28.1 }, { a: 30, b: 30.1, c: 29.8, d: 33.4 });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].channel, 'd');
  assert.deepEqual(findDrift('air.temperature', { a: 28, b: 28.2 }, { a: 30, b: 34 }), [], 'needs 3+ peers');
  assert.equal(seqResets([10, 11, 12, 13, 1, 2, 3]), 0, 'small dips (out-of-order buffered sends) are fine');
  assert.equal(seqResets([5000, 5001, 5002, 1, 2]), 1);
});

test('carbon readiness checklist', () => {
  const base = { status: 'calculated', result: { status: 'ok' }, params: { emissionsTco2ePerT: 0.2, bufferPct: 10 }, signedDevice: true,
    kiln: { readings: 90, minutes: 89, gaps: 0, estimatedTime: 0, buffered: 0 },
    measurements: ['lab.organic_carbon_pct', 'lab.h_corg', 'biochar.moisture_pct'].map((kind) => ({ kind, documentSha256: 'a'.repeat(64), supersedesId: null })) };
  assert.equal(readinessStatus(biocharReadiness(base)), 'ready');
  assert.equal(readinessStatus(biocharReadiness({ ...base, kiln: { ...base.kiln, gaps: 2 } })), 'needs_attention');
  const noCert = { ...base, measurements: base.measurements.map((m) => ({ ...m, documentSha256: null })) };
  assert.equal(readinessStatus(biocharReadiness(noCert)), 'blocked');
});

test('writer falls back to plain templates without an API key', async () => {
  const w = new Writer('', 'x');
  const d = await w.incidentMessage({ title: 'Power is out at Iseyin', summary: 'Three devices went offline.', cause: 'power_outage', siteName: 'Iseyin', openedAt: at(0), devices: ['WG-1'], status: 'open' }, 'Agro Ltd');
  assert.equal(d.writtenBy, 'template');
  assert.match(d.body, /^Hello Agro Ltd team,/);
  assert.match(d.body, /generator/);
  const html = renderReportHtml({ narrative: 'All good <script>', data: { org: { name: 'A&B' }, periodLabel: 'November 2026', totals: { sites: 1, devices: 2, readings: 10, alerts: 0 }, sites: [], incidents: [], carbon: { calculated: 0 } } });
  assert.ok(html.includes('A&amp;B') && html.includes('&lt;script&gt;'), 'report HTML is escaped');
});

// ---------- End to end on Postgres ----------
const args = process.env.TITAN_TEST_PSQL?.split(' ').filter(Boolean);
test('ops agent end to end: incidents, sensor health, reports, drafts, readiness', { skip: !args }, async () => {
  const pool = new PsqlPool(args!);
  const q = (t: string, v: unknown[] = []) => pool.query(t, v);
  const sent: { to: string[]; subject: string }[] = [];
  const email = { async send(to: string | string[], subject: string) { sent.push({ to: ([] as string[]).concat(to), subject }); return true; } };
  const agent = new OpsAgent(pool, new Writer('', 'x'), email, 'https://titan.test');
  const n = Date.now() % 1_000_000;
  const org = (await q(`INSERT INTO organisations (name, billing_email) VALUES ($1, 'ops@agro.test') RETURNING id`, [`Agro ${n}`])).rows[0].id;
  const site = (await q(`INSERT INTO sites (org_id, name) VALUES ($1, 'Oyo store') RETURNING id`, [org])).rows[0].id;
  const ids = [1, 2, 3, 4].map((i) => `AG-${String(n * 10 + i).padStart(7, '0')}`);
  for (const id of ids) await q(`INSERT INTO devices (id, org_id, site_id, type_id, status) VALUES ($1,$2,$3,'wareguard-v1','offline')`, [id, org, site]);
  const kit = (await q(`SELECT id FROM organisations WHERE kind = 'kitovu' LIMIT 1`)).rows[0].id;
  await q(`INSERT INTO notification_contacts (org_id, channel, address) VALUES ($1, 'email', 'ops@kitovu.com.ng') ON CONFLICT DO NOTHING`, [kit]);

  // three devices drop together after a power-loss event
  await q(`INSERT INTO events (time, org_id, site_id, device_id, code, severity) VALUES (now() - interval '9 minutes', $1, $2, $3, 'power_lost', 'warning')`, [org, site, ids[0]]);
  for (const [i, id] of ids.slice(0, 3).entries()) {
    await q(`INSERT INTO alerts (org_id, site_id, device_id, code, severity, title, opened_at) VALUES ($1,$2,$3,'device_offline','warning','offline', now() - make_interval(mins => $4))`, [org, site, id, 8 - i * 2]);
  }
  const r1 = await agent.runIncidents();
  assert.ok(r1.opened >= 1);
  const inc = (await agent.listIncidents('open', org))[0];
  assert.equal(inc.cause, 'power_outage');
  assert.equal(inc.alert_ids.length, 3);
  assert.ok(sent.find((m) => m.subject.includes('Power is out at Oyo store')), 'Kitovu ops told once');
  const before = sent.length;
  await agent.runIncidents();
  assert.equal(sent.length, before, 'not told twice');

  const draft = await agent.draftIncidentMessage(inc.id);
  assert.equal(draft.written_by, 'template');
  const out = await agent.sendMessage(draft.id, {}, '00000000-0000-0000-0000-000000000000');
  assert.deepEqual(out.to, ['ops@agro.test'], 'falls back to the billing email');
  await assert.rejects(agent.sendMessage(draft.id, {}, '00000000-0000-0000-0000-000000000000'), /already sent/);

  await q(`UPDATE alerts SET status = 'resolved' WHERE org_id = $1`, [org]);
  assert.ok((await agent.runIncidents()).resolved >= 1);

  // sensor health: a stuck humidity sensor and a counter reset
  const vals = Array.from({ length: 30 }, (_, i) => `(now() - make_interval(mins => ${i * 20}), '${org}', '${site}', '${ids[3]}', 'z1/dht22', 'air.humidity', 61.0)`);
  await q(`INSERT INTO readings (time, org_id, site_id, device_id, channel, metric, value) VALUES ${vals.join(',')}`);
  for (const [i, s] of [9000, 9001, 9002, 3, 4].entries()) {
    await q(`INSERT INTO messages (device_id, seq, kind, key_id, payload_b64, sig_b64, received_at) VALUES ($1,$2,'telemetry','k1','p','s', now() - make_interval(mins => $3))`, [ids[3], s, 50 - i]);
  }
  await agent.runSensorHealth();
  const findings = await agent.listFindings('open', org);
  assert.ok(findings.find((f: any) => f.kind === 'stuck' && f.device_id === ids[3]));
  assert.ok(findings.find((f: any) => f.kind === 'seq_reset' && f.device_id === ids[3]));
  await agent.dismissFinding(findings[0].id);
  await agent.runSensorHealth();
  assert.equal((await agent.listFindings('open', org)).filter((f: any) => f.key === findings[0].key).length, 0, 'dismissed findings stay dismissed');

  // monthly report
  const period = new Date().toISOString().slice(0, 7);
  const rep = await agent.buildReport(org, period);
  assert.equal(rep.data.sites[0].name, 'Oyo store');
  assert.ok(rep.data.sites[0].metrics.find((m: any) => m.metric === 'air.humidity'));
  assert.match(rep.narrative, /monitored 1 site/);
  const sentRep = await agent.sendReport(rep.id, ['boss@agro.test'], 'user:test');
  assert.deepEqual(sentRep.to, ['boss@agro.test']);

  // carbon readiness: a batch with no lab results is blocked
  const proj = (await q(`INSERT INTO carbon_projects (org_id, name, methodology, site_ids) VALUES ($1,'p','biochar-v1',ARRAY[$2]::uuid[]) RETURNING id`, [org, site])).rows[0].id;
  const act = (await q(`INSERT INTO carbon_activities (project_id, org_id, kind, started_at, ended_at, status, created_by) VALUES ($1,$2,'batch',now()-interval '2 hours',now()-interval '1 hour','closed','t') RETURNING id`, [proj, org])).rows[0].id;
  const ready = await agent.carbonReadiness(act);
  assert.equal(ready.status, 'blocked');
  assert.ok(ready.items.find((i) => i.label === 'Continuous kiln temperature record' && !i.ok));
  const pack = await agent.verifierPack(proj);
  assert.equal(pack.activities.length, 1);
  assert.equal(pack.totals.ready, 0);
});

/**
 * Kitovu's operations agent. Runs in the background and on demand:
 * - groups open alerts into incidents with a probable cause, and tells Kitovu ops
 * - checks sensor health (stuck, spiking, drifting, signs of tampering)
 * - drafts customer messages and monthly site reports (sent only after a person approves)
 * - checks carbon batches for what a verifier will need
 */
import { biocharReadiness, correlate, countSpikes, findDrift, HEALTH_LIMITS, isStuck, readinessStatus, seqResets, type DeviceInfo, type OpenAlert, type ReadinessItem } from './analysis.js';
import type { Writer } from './writer.js';
import type { EmailSender } from '../notify/providers.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

const n = (x: unknown) => Number(x);

export class OpsAgent {
  constructor(private pool: Pool, private writer: Writer, private email: EmailSender, private publicUrl: string) {}
  private q(t: string, v: unknown[] = []) { return this.pool.query(t, v); }

  // ---------- Incidents ----------
  async runIncidents(now = new Date()): Promise<{ opened: number; updated: number; resolved: number }> {
    const alerts: OpenAlert[] = (await this.q(
      `SELECT a.id, a.org_id, a.site_id, s.name AS site_name, a.device_id, a.code, a.severity, r.metric, a.opened_at
       FROM alerts a LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN alert_rules r ON r.id = a.rule_id
       WHERE a.status <> 'resolved'`)).rows.map((r) => ({
      id: r.id, orgId: r.org_id, siteId: r.site_id, siteName: r.site_name, deviceId: r.device_id, code: r.code, severity: r.severity, metric: r.metric, openedAt: new Date(r.opened_at),
    }));
    const devices = new Map<string, DeviceInfo>();
    for (const d of (await this.q(`SELECT id, site_id, gateway_id, type_id, status FROM devices`)).rows) {
      devices.set(d.id, { id: d.id, siteId: d.site_id, gatewayId: d.gateway_id, typeId: d.type_id, status: d.status });
    }
    const events = (await this.q(`SELECT site_id, device_id, code, time FROM events WHERE code = 'power_lost' AND time > $1::timestamptz - interval '1 day'`, [now]))
      .rows.map((e) => ({ siteId: e.site_id, deviceId: e.device_id, code: e.code, time: new Date(e.time) }));

    let opened = 0, updated = 0;
    for (const inc of correlate(alerts, devices, events)) {
      const existing = (await this.q(`SELECT id, alert_ids FROM incidents WHERE key = $1 AND status = 'open'`, [inc.key])).rows[0];
      if (existing) {
        const ids = [...new Set([...(existing.alert_ids ?? []), ...inc.alertIds])];
        await this.q(`UPDATE incidents SET alert_ids = $2, device_ids = $3, title = $4, summary = $5, severity = $6, updated_at = now() WHERE id = $1`,
          [existing.id, ids, inc.deviceIds, inc.title, inc.summary, inc.severity]);
        updated++;
      } else {
        await this.q(
          `INSERT INTO incidents (key, org_id, site_id, cause, title, summary, alert_ids, device_ids, severity, opened_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [inc.key, inc.orgId, inc.siteId, inc.cause, inc.title, inc.summary, inc.alertIds, inc.deviceIds, inc.severity, inc.openedAt]);
        opened++;
      }
    }
    const resolved = await this.q(
      `UPDATE incidents i SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE i.status = 'open' AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.id = ANY(i.alert_ids) AND a.status <> 'resolved')`);
    await this.notifyOps();
    return { opened, updated, resolved: resolved.rowCount ?? 0 };
  }

  /** Emails Kitovu's own alert contacts about new incidents, once each. */
  private async notifyOps() {
    const fresh = (await this.q(
      `SELECT i.*, o.name AS org_name, s.name AS site_name FROM incidents i JOIN organisations o ON o.id = i.org_id LEFT JOIN sites s ON s.id = i.site_id
       WHERE i.status = 'open' AND i.notified_at IS NULL`)).rows;
    if (!fresh.length) return;
    const to = (await this.q(
      `SELECT c.address FROM notification_contacts c JOIN organisations o ON o.id = c.org_id WHERE o.kind = 'kitovu' AND c.channel = 'email'`)).rows.map((r) => r.address);
    for (const i of fresh) {
      if (to.length) {
        await this.email.send(to, `[Titan incident] ${i.org_name}: ${i.title}`,
          `${i.title}\n\n${i.summary}\n\nAlerts grouped: ${i.alert_ids.length}. Devices: ${(i.device_ids ?? []).join(', ')}.\n${this.publicUrl}/admin/#agent`);
      }
      await this.q(`UPDATE incidents SET notified_at = now() WHERE id = $1`, [i.id]);
    }
  }

  async listIncidents(status: 'open' | 'resolved' | null, orgId?: string) {
    return (await this.q(
      `SELECT i.*, o.name AS org_name, s.name AS site_name FROM incidents i JOIN organisations o ON o.id = i.org_id LEFT JOIN sites s ON s.id = i.site_id
       WHERE ($1::text IS NULL OR i.status = $1) AND ($2::uuid IS NULL OR i.org_id = $2) ORDER BY i.opened_at DESC LIMIT 200`, [status, orgId ?? null])).rows;
  }

  // ---------- Sensor health ----------
  async runSensorHealth(now = new Date()): Promise<{ open: number }> {
    const found: { key: string; orgId: string; siteId: string | null; deviceId: string; channel: string | null; metric: string | null; kind: string; severity: string; title: string; detail: unknown }[] = [];
    const metrics = Object.keys(HEALTH_LIMITS);

    // Stuck and spiking sensors: last 24 h per device/channel/metric
    const series = (await this.q(
      `SELECT r.org_id, r.site_id, r.device_id, r.channel, r.metric, array_agg(r.value ORDER BY r.time) AS vals, array_agg(extract(epoch FROM r.time) ORDER BY r.time) AS ts
       FROM readings r WHERE r.time > $1::timestamptz - interval '24 hours' AND r.metric = ANY($2::text[]) AND (r.flags & 4) = 0 AND r.quality <> 'rejected'
       GROUP BY 1,2,3,4,5`, [now, metrics])).rows;
    for (const s of series) {
      const vals: number[] = (s.vals as any[]).map(n), ts: number[] = (s.ts as any[]).map(n);
      const samples = vals.map((v, i) => ({ time: new Date(ts[i] * 1000), value: v }));
      const stuck = isStuck(samples, s.metric);
      if (stuck.stuck) found.push({ key: `stuck:${s.device_id}:${s.channel}:${s.metric}`, orgId: s.org_id, siteId: s.site_id, deviceId: s.device_id, channel: s.channel, metric: s.metric,
        kind: 'stuck', severity: 'warning', title: `${s.metric} on ${s.device_id} (${s.channel}) has not changed in 24 hours`,
        detail: { value: stuck.value, samples: samples.length, hint: 'Usually a disconnected, frozen or covered sensor. For stove nodes, the stove may simply be unused.' } });
      const spikes = countSpikes(samples, s.metric);
      if (spikes >= 3) found.push({ key: `spikes:${s.device_id}:${s.channel}:${s.metric}`, orgId: s.org_id, siteId: s.site_id, deviceId: s.device_id, channel: s.channel, metric: s.metric,
        kind: 'spikes', severity: 'warning', title: `${s.metric} on ${s.device_id} (${s.channel}) jumped implausibly ${spikes} times today`,
        detail: { spikes, limit: HEALTH_LIMITS[s.metric].jump, hint: 'Loose wiring, a failing sensor or electrical interference.' } });
    }

    // Drift against peers: daily means this week vs last week, per site and metric
    const weekly = (await this.q(
      `SELECT r.org_id, r.site_id, r.device_id, r.channel, r.metric,
         avg(r.value) FILTER (WHERE r.time > $1::timestamptz - interval '7 days') AS this_week,
         avg(r.value) FILTER (WHERE r.time <= $1::timestamptz - interval '7 days') AS last_week
       FROM readings r WHERE r.time > $1::timestamptz - interval '14 days' AND r.metric = ANY($2::text[]) AND (r.flags & 4) = 0 AND r.quality = 'ok' AND r.site_id IS NOT NULL
       GROUP BY 1,2,3,4,5`, [now, metrics])).rows;
    const bySiteMetric = new Map<string, any[]>();
    for (const w of weekly) {
      if (w.this_week === null || w.last_week === null) continue;
      const k = `${w.site_id}|${w.metric}`;
      bySiteMetric.set(k, [...(bySiteMetric.get(k) ?? []), w]);
    }
    for (const [k, rows] of bySiteMetric) {
      const metric = k.split('|')[1];
      const key = (r: any) => `${r.device_id}|${r.channel}`;
      const drift = findDrift(metric, Object.fromEntries(rows.map((r) => [key(r), n(r.last_week)])), Object.fromEntries(rows.map((r) => [key(r), n(r.this_week)])));
      for (const d of drift) {
        const r = rows.find((x) => key(x) === d.channel)!;
        found.push({ key: `drift:${r.device_id}:${r.channel}:${metric}`, orgId: r.org_id, siteId: r.site_id, deviceId: r.device_id, channel: r.channel, metric,
          kind: 'drift', severity: 'warning', title: `${metric} on ${r.device_id} (${r.channel}) is drifting away from nearby sensors`,
          detail: { offsetLastWeek: d.before, offsetThisWeek: d.after, shift: d.shift, limit: HEALTH_LIMITS[metric].drift, hint: 'Recalibrate or replace the sensor; check it isn\'t moved next to a heat or water source.' } });
      }
    }

    // Integrity signals over 7 days: rejected signatures, tamper switch, sequence resets, unset clocks
    const tamper = (await this.q(
      `SELECT a.org_id, a.site_id, a.device_id, count(*)::int AS n FROM alerts a WHERE a.code = 'tamper' AND a.opened_at > $1::timestamptz - interval '7 days' GROUP BY 1,2,3`, [now])).rows;
    for (const t of tamper) found.push({ key: `tamper:${t.device_id}::`, orgId: t.org_id, siteId: t.site_id, deviceId: t.device_id, channel: null, metric: null,
      kind: 'tamper', severity: 'critical', title: `${t.device_id} sent messages that failed signature checks`, detail: { alerts: n(t.n), hint: 'Someone may be sending data as this device, or its key changed without provisioning. Inspect the device.' } });
    const lid = (await this.q(
      `SELECT DISTINCT r.org_id, r.site_id, r.device_id FROM readings r WHERE r.metric = 'security.tamper' AND r.value = 1 AND r.time > $1::timestamptz - interval '7 days'`, [now])).rows;
    for (const t of lid) found.push({ key: `enclosure:${t.device_id}::`, orgId: t.org_id, siteId: t.site_id, deviceId: t.device_id, channel: null, metric: 'security.tamper',
      kind: 'tamper', severity: 'critical', title: `${t.device_id}'s enclosure was opened`, detail: { hint: 'Confirm this was a planned visit.' } });
    const seqs = (await this.q(
      `SELECT m.device_id, d.org_id, d.site_id, array_agg(m.seq ORDER BY m.received_at, m.seq) AS seqs FROM messages m JOIN devices d ON d.id = m.device_id
       WHERE m.received_at > $1::timestamptz - interval '7 days' GROUP BY 1,2,3`, [now])).rows;
    for (const s of seqs) {
      const resets = seqResets((s.seqs as any[]).map(n));
      if (resets) found.push({ key: `seq_reset:${s.device_id}::`, orgId: s.org_id, siteId: s.site_id, deviceId: s.device_id, channel: null, metric: null,
        kind: 'seq_reset', severity: 'warning', title: `${s.device_id}'s message counter went backwards ${resets} time(s)`, detail: { resets, hint: 'A firmware reflash, a reset that lost its saved state, or a second device using the same identity.' } });
    }
    const clocks = (await this.q(
      `SELECT r.org_id, r.site_id, r.device_id, count(*) FILTER (WHERE (r.flags & 2) <> 0)::int AS est, count(*)::int AS total
       FROM readings r WHERE r.time > $1::timestamptz - interval '24 hours' AND (r.flags & 4) = 0 GROUP BY 1,2,3`, [now])).rows;
    for (const c of clocks) if (n(c.total) >= 20 && n(c.est) / n(c.total) > 0.2) found.push({ key: `clock:${c.device_id}::`, orgId: c.org_id, siteId: c.site_id, deviceId: c.device_id, channel: null, metric: null,
      kind: 'clock', severity: 'info', title: `${c.device_id} often reports without a set clock`, detail: { estimated: n(c.est), total: n(c.total), hint: 'Fit or replace the RTC battery, or check NTP access.' } });

    // Upsert what we found; clear open findings that no longer apply (dismissed ones stay dismissed)
    const seen: string[] = [];
    for (const f of found) {
      seen.push(f.key);
      const dismissed = (await this.q(`SELECT 1 FROM sensor_findings WHERE key = $1 AND status = 'dismissed' AND last_seen > $2::timestamptz - interval '7 days'`, [f.key, now])).rows.length;
      if (dismissed) continue;
      const u = await this.q(`UPDATE sensor_findings SET last_seen = $2, detail = $3, title = $4, severity = $5 WHERE key = $1 AND status = 'open'`,
        [f.key, now, JSON.stringify(f.detail), f.title, f.severity]);
      if (!u.rowCount) await this.q(
        `INSERT INTO sensor_findings (key, org_id, site_id, device_id, channel, metric, kind, severity, title, detail, first_seen, last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [f.key, f.orgId, f.siteId, f.deviceId, f.channel, f.metric, f.kind, f.severity, f.title, JSON.stringify(f.detail), now]);
    }
    await this.q(`UPDATE sensor_findings SET status = 'cleared' WHERE status = 'open' AND NOT (key = ANY($1::text[]))`, [seen]);
    const open = (await this.q(`SELECT count(*)::int AS n FROM sensor_findings WHERE status = 'open'`)).rows[0];
    return { open: n(open.n) };
  }

  async listFindings(status = 'open', orgId?: string) {
    return (await this.q(
      `SELECT f.*, o.name AS org_name, s.name AS site_name FROM sensor_findings f JOIN organisations o ON o.id = f.org_id LEFT JOIN sites s ON s.id = f.site_id
       WHERE f.status = $1 AND ($2::uuid IS NULL OR f.org_id = $2)
       ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, f.last_seen DESC LIMIT 300`, [status, orgId ?? null])).rows;
  }

  async dismissFinding(id: string) {
    await this.q(`UPDATE sensor_findings SET status = 'dismissed' WHERE id = $1`, [id]);
  }

  // ---------- Customer messages ----------
  async draftIncidentMessage(incidentId: string) {
    const i = (await this.q(
      `SELECT i.*, o.name AS org_name, s.name AS site_name FROM incidents i JOIN organisations o ON o.id = i.org_id LEFT JOIN sites s ON s.id = i.site_id WHERE i.id = $1`, [incidentId])).rows[0];
    if (!i) throw new Error('Incident not found');
    const d = await this.writer.incidentMessage({ title: i.title, summary: i.summary, cause: i.cause, siteName: i.site_name, openedAt: new Date(i.opened_at), devices: i.device_ids ?? [], status: i.status }, i.org_name);
    return (await this.q(`INSERT INTO drafted_messages (org_id, incident_id, subject, body, written_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [i.org_id, i.id, d.subject, d.body, d.writtenBy])).rows[0];
  }

  /** Default recipients: the organisation's email alert contacts, else its billing email. */
  async recipientsFor(orgId: string): Promise<string[]> {
    const c = (await this.q(`SELECT DISTINCT address FROM notification_contacts WHERE org_id = $1 AND channel = 'email'`, [orgId])).rows.map((r) => r.address);
    if (c.length) return c;
    const o = (await this.q(`SELECT billing_email FROM organisations WHERE id = $1`, [orgId])).rows[0];
    return o?.billing_email ? [o.billing_email] : [];
  }

  async sendMessage(draftId: string, edit: { subject?: string; body?: string; to?: string[] }, by: string) {
    const m = (await this.q(`SELECT * FROM drafted_messages WHERE id = $1 AND status = 'draft'`, [draftId])).rows[0];
    if (!m) throw new Error('Draft not found or already sent');
    const to = edit.to?.length ? edit.to : await this.recipientsFor(m.org_id);
    if (!to.length) throw new Error('No recipients. Add an email alert contact for this organisation first.');
    const subject = edit.subject ?? m.subject, body = edit.body ?? m.body;
    const ok = await this.email.send(to, subject, body, undefined, 'titan@kitovu.com.ng');
    if (!ok) throw new Error('Email was not sent (check the Resend API key)');
    await this.q(`UPDATE drafted_messages SET subject = $2, body = $3, status = 'sent', sent_to = $4, sent_by = $5, sent_at = now() WHERE id = $1`, [draftId, subject, body, to, by]);
    return { to };
  }

  // ---------- Monthly reports ----------
  async buildReport(orgId: string, period: string) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('period must be YYYY-MM');
    const start = `${period}-01`;
    const org = (await this.q(`SELECT id, name FROM organisations WHERE id = $1`, [orgId])).rows[0];
    if (!org) throw new Error('Organisation not found');
    const sites = (await this.q(
      `SELECT s.id, s.name, s.kind, count(d.id)::int AS devices FROM sites s LEFT JOIN devices d ON d.site_id = s.id AND d.status <> 'disabled'
       WHERE s.org_id = $1 GROUP BY s.id ORDER BY s.name`, [orgId])).rows;
    const outSites = [];
    let totalReadings = 0, totalDevices = 0;
    for (const s of sites) {
      // Reporting rate: hours with at least one reading, over the hours each device existed this month.
      const up = (await this.q(
        `SELECT d.id, coalesce(r.hrs, 0) AS hrs, coalesce(r.readings, 0) AS readings,
           greatest(1, extract(epoch FROM (least($2::date + interval '1 month', now()) - greatest($2::date, d.created_at))) / 3600) AS window_h
         FROM devices d LEFT JOIN (
           SELECT device_id, count(DISTINCT date_trunc('hour', time))::int AS hrs, count(*)::int AS readings FROM readings
           WHERE site_id = $1 AND time >= $2::date AND time < $2::date + interval '1 month' GROUP BY 1) r ON r.device_id = d.id
         WHERE d.site_id = $1 AND d.status <> 'disabled' AND d.created_at < $2::date + interval '1 month'`, [s.id, start])).rows;
      const readings = up.reduce((a, r) => a + n(r.readings), 0);
      const windowH = up.reduce((a, r) => a + n(r.window_h), 0);
      const uptimePct = up.length ? Math.round(Math.min(1, up.reduce((a, r) => a + n(r.hrs), 0) / windowH) * 1000) / 10 : 0;
      const metrics = (await this.q(
        `SELECT metric, min(value) AS min, max(value) AS max, avg(value) AS avg, count(*)::int AS n FROM readings
         WHERE site_id = $1 AND time >= $2::date AND time < $2::date + interval '1 month' AND quality = 'ok' AND (flags & 4) = 0
         GROUP BY 1 ORDER BY 1`, [s.id, start])).rows.map((m) => ({ metric: m.metric, min: round(n(m.min)), max: round(n(m.max)), avg: round(n(m.avg)), readings: n(m.n) }));
      const alerts = (await this.q(
        `SELECT code, severity, count(*)::int AS n FROM alerts WHERE site_id = $1 AND opened_at >= $2::date AND opened_at < $2::date + interval '1 month' GROUP BY 1,2`, [s.id, start])).rows;
      totalReadings += readings;
      totalDevices += n(s.devices);
      outSites.push({ id: s.id, name: s.name, kind: s.kind, devices: n(s.devices), readings, uptimePct, metrics, alerts: alerts.map((a) => ({ code: a.code, severity: a.severity, count: n(a.n) })) });
    }
    const incidents = (await this.q(
      `SELECT title, cause, status, opened_at, resolved_at FROM incidents WHERE org_id = $1 AND opened_at >= $2::date AND opened_at < $2::date + interval '1 month' ORDER BY opened_at`, [orgId, start])).rows;
    const carbon = (await this.q(
      `SELECT count(*) FILTER (WHERE a.status = 'calculated' AND a.result->>'status' = 'ok')::int AS calculated,
         coalesce(sum((a.result->>'netTco2e')::double precision) FILTER (WHERE a.status = 'calculated' AND a.result->>'status' = 'ok'), 0) AS net
       FROM carbon_activities a JOIN carbon_projects p ON p.id = a.project_id WHERE p.org_id = $1 AND a.started_at >= $2::date AND a.started_at < $2::date + interval '1 month'`, [orgId, start])).rows[0];
    const alertTotals = outSites.flatMap((s) => s.alerts);
    const data = {
      org: { id: org.id, name: org.name }, period, periodLabel: new Date(`${start}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      totals: { sites: outSites.length, devices: totalDevices, readings: totalReadings, alerts: alertTotals.reduce((a, x) => a + x.count, 0), critical: alertTotals.filter((x) => x.severity === 'critical').reduce((a, x) => a + x.count, 0) },
      sites: outSites,
      incidents: incidents.map((i) => ({ title: i.title, cause: i.cause, status: i.status, openedAt: i.opened_at, resolvedAt: i.resolved_at })),
      carbon: { calculated: n(carbon.calculated), netTco2e: round(n(carbon.net)) },
      generatedAt: new Date().toISOString(),
    };
    const narrative = await this.writer.reportNarrative(data);
    return (await this.q(
      `INSERT INTO reports (org_id, period, data, narrative) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, period) DO UPDATE SET data = EXCLUDED.data, narrative = EXCLUDED.narrative, created_at = now()
       WHERE reports.status = 'draft' RETURNING *`, [orgId, period, JSON.stringify({ ...data, narrativeBy: narrative.writtenBy }), narrative.text])).rows[0]
      ?? (await this.q(`SELECT * FROM reports WHERE org_id = $1 AND period = $2`, [orgId, period])).rows[0];
  }

  async sendReport(reportId: string, to: string[] | undefined, by: string) {
    const r = (await this.q(`SELECT r.*, o.name AS org_name FROM reports r JOIN organisations o ON o.id = r.org_id WHERE r.id = $1`, [reportId])).rows[0];
    if (!r) throw new Error('Report not found');
    const recipients = to?.length ? to : await this.recipientsFor(r.org_id);
    if (!recipients.length) throw new Error('No recipients. Add an email alert contact for this organisation first.');
    const html = renderReportHtml(r);
    const ok = await this.email.send(recipients, `Your Titan report for ${r.data.periodLabel}`, `${r.narrative}\n\nView the full report in your Titan console: ${this.publicUrl}/console/#reports`, html, 'titan@kitovu.com.ng');
    if (!ok) throw new Error('Email was not sent (check the Resend API key)');
    await this.q(`UPDATE reports SET status = 'sent', sent_at = now(), sent_to = $2 WHERE id = $1`, [reportId, recipients]);
    await this.q(`INSERT INTO audit_log (actor, org_id, action, target) VALUES ($1,$2,'report.sent',$3)`, [by, r.org_id, reportId]);
    return { to: recipients };
  }

  // ---------- Carbon readiness ----------
  async carbonReadiness(activityId: string): Promise<{ status: string; items: ReadinessItem[] }> {
    const a = (await this.q(`SELECT a.*, p.methodology, p.params, p.site_ids FROM carbon_activities a JOIN carbon_projects p ON p.id = a.project_id WHERE a.id = $1`, [activityId])).rows[0];
    if (!a) throw new Error('Activity not found');
    const measurements = (await this.q(`SELECT kind, document_sha256, supersedes_id FROM carbon_measurements WHERE activity_id = $1`, [activityId])).rows
      .map((m) => ({ kind: m.kind, documentSha256: m.document_sha256, supersedesId: m.supersedes_id }));
    const from = a.started_at, to = a.ended_at ?? new Date();
    const siteIds = a.site_id ? [a.site_id] : a.site_ids ?? [];
    if (a.methodology === 'biochar-v1') {
      const k = (await this.q(
        `SELECT time, flags FROM readings WHERE site_id = ANY($1::uuid[]) AND ($2::text IS NULL OR device_id = $2) AND metric = 'kiln.temperature' AND time >= $3 AND time <= $4 ORDER BY time`,
        [siteIds, a.device_id, from, to])).rows;
      let gaps = 0;
      for (let i = 1; i < k.length; i++) if (new Date(k[i].time).getTime() - new Date(k[i - 1].time).getTime() > 5 * 60_000) gaps++;
      const minutes = k.length ? Math.round((new Date(k.at(-1).time).getTime() - new Date(k[0].time).getTime()) / 60_000) : 0;
      const items = biocharReadiness({
        status: a.status, result: a.result, measurements, params: a.params ?? {},
        kiln: { readings: k.length, minutes, gaps, estimatedTime: k.filter((r) => n(r.flags) & 2).length, buffered: k.filter((r) => n(r.flags) & 1).length },
        signedDevice: !k.some((r) => n(r.flags) & 8),
      });
      return { status: readinessStatus(items), items };
    }
    const p = a.params ?? {};
    const items: ReadinessItem[] = [
      { ok: a.status !== 'open', level: 'blocker', label: 'Period is closed' },
      { ok: a.result?.status === 'ok', level: 'blocker', label: 'Calculation complete', detail: a.result?.missing?.length ? `Missing: ${a.result.missing.join(', ')}` : undefined },
      ...(['baselineFuelKgPerHour', 'fuelSavingFraction', 'fNRB', 'efTco2PerTFuel'] as const).map((key) => ({ ok: typeof p[key] === 'number', level: 'blocker' as const, label: `Parameter ${key} set from the methodology` })),
      { ok: (a.result?.activeDevices ?? 0) > 0, level: 'warning', label: 'Stoves in use during the period', detail: a.result ? `${a.result.activeDevices ?? 0} of ${a.result.devices ?? 0} stoves recorded cooking.` : undefined },
    ];
    return { status: readinessStatus(items), items };
  }

  /** Everything a verifier needs for a project, in one document. */
  async verifierPack(projectId: string) {
    const p = (await this.q(`SELECT p.*, o.name AS org_name FROM carbon_projects p JOIN organisations o ON o.id = p.org_id WHERE p.id = $1`, [projectId])).rows[0];
    if (!p) throw new Error('Project not found');
    const acts = (await this.q(`SELECT * FROM carbon_activities WHERE project_id = $1 AND status <> 'rejected' ORDER BY started_at`, [projectId])).rows;
    const out = [];
    for (const a of acts) {
      const measurements = (await this.q(`SELECT kind, value, unit, document_ref, document_sha256, supersedes_id, entered_by, created_at FROM carbon_measurements WHERE activity_id = $1 ORDER BY created_at`, [a.id])).rows;
      out.push({ id: a.id, reference: a.reference, device: a.device_id, startedAt: a.started_at, endedAt: a.ended_at, status: a.status, result: a.result, measurements, readiness: await this.carbonReadiness(a.id) });
    }
    return {
      project: { id: p.id, name: p.name, owner: p.org_name, methodology: p.methodology, registry: p.registry, params: p.params, sites: p.site_ids },
      generatedAt: new Date().toISOString(),
      totals: { activities: out.length, ready: out.filter((x) => x.readiness.status === 'ready').length, netTco2e: round(out.reduce((s, x) => s + (x.result?.status === 'ok' ? n(x.result.netTco2e) : 0), 0)) },
      activities: out,
      howToVerify: 'Each result lists its inputs. Device readings carry message sequence ranges; fetch any message with GET /v1/readings/proof?device=&seq= and check its Ed25519 signature. Lab results carry the SHA-256 of their certificate files.',
    };
  }
}

const round = (x: number) => Math.round(x * 100) / 100;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Self-contained HTML monthly report: works as an email body, a page to print, or a PDF. */
export function renderReportHtml(r: { data: any; narrative: string | null }): string {
  const d = r.data;
  const site = (s: any) => `
    <h2 style="font-size:18px;margin:28px 0 6px">${esc(s.name)} <span style="font-weight:400;color:#6B778F;font-size:14px">${esc(s.kind)} · ${s.devices} device${s.devices === 1 ? '' : 's'} · reporting ${s.uptimePct}% of the time</span></h2>
    ${s.metrics.length ? `<table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="color:#6B778F;text-align:left"><th style="padding:6px 8px 6px 0">Reading</th><th style="text-align:right;padding:6px 8px">Min</th><th style="text-align:right;padding:6px 8px">Average</th><th style="text-align:right;padding:6px 0 6px 8px">Max</th></tr>
      ${s.metrics.map((m: any) => `<tr style="border-top:1px solid #E4EAE7"><td style="padding:6px 8px 6px 0">${esc(m.metric)}</td><td style="text-align:right;padding:6px 8px">${m.min}</td><td style="text-align:right;padding:6px 8px">${m.avg}</td><td style="text-align:right;padding:6px 0 6px 8px">${m.max}</td></tr>`).join('')}</table>` : '<p style="color:#6B778F">No readings this month.</p>'}
    <p style="font-size:14px;color:#4A5875">${s.alerts.length ? 'Alerts: ' + s.alerts.map((a: any) => `${a.count} ${esc(a.code.replace(/_/g, ' '))}${a.severity === 'critical' ? ' (critical)' : ''}`).join(', ') : 'No alerts.'}</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Titan report: ${esc(d.org.name)}, ${esc(d.periodLabel)}</title></head>
<body style="margin:0;background:#EEF2F0;font-family:Inter,Arial,sans-serif;color:#14213D">
<div style="max-width:720px;margin:0 auto;background:#fff;padding:32px 36px">
  <p style="margin:0;color:#6B778F;font-size:14px">Titan by Kitovu · Monthly report</p>
  <h1 style="font-size:28px;margin:6px 0 4px">${esc(d.org.name)}</h1>
  <p style="margin:0 0 20px;color:#4A5875">${esc(d.periodLabel)}</p>
  <p style="font-size:16px;line-height:1.6">${esc(r.narrative ?? '')}</p>
  <table style="width:100%;margin:18px 0;border-collapse:collapse;text-align:center"><tr>
    <td style="padding:12px;border:1px solid #D5DEDA"><div style="font-size:24px;font-weight:700">${d.totals.sites}</div><div style="font-size:13px;color:#6B778F">sites</div></td>
    <td style="padding:12px;border:1px solid #D5DEDA"><div style="font-size:24px;font-weight:700">${d.totals.devices}</div><div style="font-size:13px;color:#6B778F">devices</div></td>
    <td style="padding:12px;border:1px solid #D5DEDA"><div style="font-size:24px;font-weight:700">${d.totals.readings.toLocaleString()}</div><div style="font-size:13px;color:#6B778F">readings</div></td>
    <td style="padding:12px;border:1px solid #D5DEDA"><div style="font-size:24px;font-weight:700">${d.totals.alerts}</div><div style="font-size:13px;color:#6B778F">alerts</div></td>
  </tr></table>
  ${d.sites.map(site).join('')}
  ${d.incidents.length ? `<h2 style="font-size:18px;margin:28px 0 6px">Incidents</h2><ul style="font-size:14px;padding-left:18px">${d.incidents.map((i: any) => `<li>${esc(i.title)} (${esc(i.status)})</li>`).join('')}</ul>` : ''}
  ${d.carbon.calculated ? `<h2 style="font-size:18px;margin:28px 0 6px">Carbon</h2><p style="font-size:14px">${d.carbon.netTco2e} tCO₂e net from ${d.carbon.calculated} calculated batch${d.carbon.calculated === 1 ? '' : 'es'} or periods.</p>` : ''}
  <p style="font-size:12px;color:#6B778F;margin-top:32px">Every reading in this report was signed by the device that took it. Questions: titan@kitovu.com.ng</p>
</div></body></html>`;
}

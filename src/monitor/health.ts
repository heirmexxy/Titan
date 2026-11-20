/**
 * Health checks for Titan itself. /healthz/deep is what the on-server watchdog and any outside uptime
 * monitor poll; it answers 503 when something needs attention. The admin "System health" page shows the details.
 */
import { readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { connect } from 'node:tls';
import type { Router } from '../http/router.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export interface Check { name: string; ok: boolean; level: 'critical' | 'warning'; detail: string }

export interface HealthDeps {
  pool: Pool;
  emqx: { apiUrl: string; key: string; secret: string };
  mqttHost: string;
  mqttPort: number;
  publicHost: string;
  backupDir: string;
  dataDir: string;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** Days until a TLS certificate expires, or null if the host can't be reached. */
export function certDaysLeft(host: string, port: number, servername = host): Promise<number | null> {
  return withTimeout(new Promise<number | null>((resolve) => {
    const s = connect({ host, port, servername, rejectUnauthorized: false, timeout: 4000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c?.valid_to ? Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86_400_000) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  }), 5000, null);
}

export class Health {
  private certCache: { at: number; checks: Check[] } | null = null;
  constructor(readonly d: HealthDeps) {}

  async beat(name: string, detail?: unknown) {
    await this.d.pool.query(`INSERT INTO system_heartbeats (name, beat_at, detail) VALUES ($1, now(), $2) ON CONFLICT (name) DO UPDATE SET beat_at = now(), detail = $2`,
      [name, detail === undefined ? null : JSON.stringify(detail)]);
  }

  async run(): Promise<{ ok: boolean; checks: Check[]; at: string }> {
    const checks: Check[] = [];
    const add = (name: string, ok: boolean, level: Check['level'], detail: string) => checks.push({ name, ok, level, detail });

    // Database
    const t0 = Date.now();
    let dbOk = false;
    try { await withTimeout(this.d.pool.query('SELECT 1'), 3000, null).then((r) => { dbOk = !!r; }); } catch { dbOk = false; }
    add('database', dbOk, 'critical', dbOk ? `answered in ${Date.now() - t0} ms` : 'not answering');

    if (dbOk) {
      // Background workers
      const hb = (await this.d.pool.query(`SELECT name, extract(epoch FROM now() - beat_at)::int AS age FROM system_heartbeats`)).rows;
      const w = hb.find((x) => x.name === 'workers');
      add('workers', !!w && w.age < 180, 'critical', w ? `last heartbeat ${w.age}s ago` : 'no heartbeat yet');
      // Webhook backlog
      const backlog = (await this.d.pool.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at < now() - interval '10 minutes'`)).rows[0].n;
      add('webhook queue', backlog < 500, 'warning', `${backlog} deliveries overdue by 10+ minutes`);
      // Device traffic: if devices exist but nothing arrived for 30 minutes, ingestion is probably broken.
      const traffic = (await this.d.pool.query(`SELECT (SELECT count(*) FROM devices WHERE status = 'online')::int AS online,
        (SELECT extract(epoch FROM now() - max(last_seen_at))::int FROM devices) AS since`)).rows[0];
      add('device traffic', traffic.since === null || traffic.since < 1800, 'warning', traffic.since === null ? 'no devices yet' : `last message ${traffic.since}s ago; ${traffic.online} online`);
    }

    // EMQX
    let emqxOk = false, emqxDetail = 'not configured';
    if (this.d.emqx.key) {
      try {
        const res = await withTimeout(fetch(`${this.d.emqx.apiUrl}/stats?aggregate=true`, { headers: { Authorization: 'Basic ' + Buffer.from(`${this.d.emqx.key}:${this.d.emqx.secret}`).toString('base64') } }), 4000, null);
        if (res && res.ok) {
          const s: any = await res.json();
          const st = Array.isArray(s) ? s[0] : s;
          emqxOk = true; emqxDetail = `${st?.['connections.count'] ?? st?.['live_connections.count'] ?? '?'} device connections`;
        } else emqxDetail = res ? `API answered ${res.status}` : 'API not answering';
      } catch (e) { emqxDetail = `API error: ${String((e as Error).message ?? e).slice(0, 80)}`; }
    }
    add('mqtt broker', emqxOk, 'critical', emqxDetail);

    // Disk
    try {
      const fs = statfsSync(this.d.dataDir);
      const freePct = Math.round((fs.bavail / fs.blocks) * 100);
      add('disk space', freePct >= 10, freePct < 5 ? 'critical' : 'warning', `${freePct}% free (${Math.round((fs.bavail * fs.bsize) / 1e9)} GB)`);
    } catch { /* not supported */ }

    // Backups
    try {
      const files = readdirSync(this.d.backupDir).filter((f) => f.endsWith('.dump')).map((f) => statSync(`${this.d.backupDir}/${f}`).mtimeMs);
      const newest = files.length ? Math.max(...files) : 0;
      const hours = newest ? Math.round((Date.now() - newest) / 3_600_000) : null;
      add('backups', hours !== null && hours <= 30, 'warning', hours === null ? 'no backups found' : `newest is ${hours}h old`);
    } catch { add('backups', false, 'warning', `cannot read ${this.d.backupDir}`); }
    // Off-site copy (written by deploy/backup.sh once offsite-setup.sh has run).
    try {
      const st = readFileSync(`${this.d.backupDir}/offsite-status`, 'utf8').trim();
      const [state, at, host] = st.split(' ');
      const hours = Math.round((Date.now() - new Date(at).getTime()) / 3_600_000);
      add('off-site backup', state === 'ok' && hours <= 30, 'warning', `${state === 'ok' ? 'copied' : 'copy failed'} to ${host ?? '?'} ${hours}h ago`);
    } catch { add('off-site backup', false, 'warning', 'not set up (run deploy/offsite-setup.sh)'); }

    // Certificates (checked at most hourly)
    if (!this.certCache || Date.now() - this.certCache.at > 3_600_000) {
      const web = await certDaysLeft(this.d.publicHost, 443);
      const mqtt = await certDaysLeft(this.d.mqttHost, this.d.mqttPort);
      const c = (name: string, days: number | null): Check => ({ name, ok: days !== null && days >= 14, level: days !== null && days < 5 ? 'critical' : 'warning', detail: days === null ? 'could not connect' : `expires in ${days} days` });
      this.certCache = { at: Date.now(), checks: [c('web certificate', web), c('mqtt certificate', mqtt)] };
    }
    checks.push(...this.certCache.checks);

    return { ok: checks.every((c) => c.ok || c.level === 'warning'), checks, at: new Date().toISOString() };
  }
}

export function registerHealth(r: Router, health: Health, adminSession: (req: any) => Promise<unknown>) {
  // Public: status and check names only (no internal details).
  r.get('/healthz/deep', async () => {
    const h = await health.run();
    return { status: h.ok ? 200 : 503, body: { ok: h.ok, at: h.at, checks: h.checks.map((c) => ({ name: c.name, ok: c.ok, level: c.level })) }, headers: { 'Cache-Control': 'no-store' } };
  });
  r.get('/admin/api/health', async (req) => {
    await adminSession(req);
    const h = await health.run();
    const beats = (await health.d.pool.query(`SELECT name, beat_at, detail FROM system_heartbeats ORDER BY name`)).rows;
    return { body: { ...h, heartbeats: beats } };
  });
}

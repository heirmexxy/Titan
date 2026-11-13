import type { Billing } from '../billing/billing.js';
import type { IngestPipeline } from '../ingest/pipeline.js';
import type { Dispatcher } from '../notify/dispatcher.js';
import type { Store } from '../store/types.js';

/** Background loops: offline detection, webhook delivery, monthly invoices. Returns a stop function. */
interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

/** Deletes readings and raw messages older than each organisation's retention period. */
export async function applyRetention(pool: Pool): Promise<number> {
  let deleted = 0;
  for (const o of (await pool.query(`SELECT id, retention_days FROM organisations`)).rows) {
    const r = await pool.query(`DELETE FROM readings WHERE org_id = $1 AND time < now() - make_interval(days => $2)`, [o.id, Number(o.retention_days)]);
    deleted += r.rowCount ?? 0;
    await pool.query(
      `DELETE FROM messages m USING devices d WHERE d.id = m.device_id AND d.org_id = $1 AND m.received_at < now() - make_interval(days => $2)`,
      [o.id, Number(o.retention_days)]);
  }
  return deleted;
}

export function startWorkers(o: { store: Store; pipeline: IngestPipeline; dispatcher: Dispatcher; billing: Billing | null; sweepSeconds: number; pool?: Pool }) {
  const log = (msg: string, err: unknown) => console.error(JSON.stringify({ level: 'error', msg, err: String(err) }));
  let busy = { sweep: false, hooks: false };

  const sweep = setInterval(async () => {
    if (busy.sweep) return;
    busy.sweep = true;
    try {
      for (const d of await o.store.listStaleDevices(new Date())) await o.pipeline.deviceOffline(d.id);
    } catch (e) { log('offline sweep failed', e); } finally { busy.sweep = false; }
  }, o.sweepSeconds * 1000);

  const hooks = setInterval(async () => {
    if (busy.hooks) return;
    busy.hooks = true;
    try { while ((await o.dispatcher.deliverDue()) === 50); } catch (e) { log('webhook delivery failed', e); } finally { busy.hooks = false; }
  }, 5_000);

  // On the 1st of each month (checked hourly), invoice the previous month. Idempotent.
  const invoices = setInterval(async () => {
    if (!o.billing) return;
    const now = new Date();
    if (now.getUTCDate() !== 1) return;
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    try { await o.billing.generateInvoices(prev.toISOString().slice(0, 7)); } catch (e) { log('invoice generation failed', e); }
  }, 3_600_000);

  // Retention: once a day (checked hourly, runs in the 02:00 UTC hour).
  const retention = setInterval(async () => {
    if (!o.pool || new Date().getUTCHours() !== 2) return;
    try { await applyRetention(o.pool); } catch (e) { log('retention failed', e); }
  }, 3_600_000);

  return () => { clearInterval(sweep); clearInterval(hooks); clearInterval(invoices); clearInterval(retention); };
}

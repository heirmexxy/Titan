/**
 * Pay-as-you-go: customer payments buy time on an appliance (a fridge, a solar kit, a cookstove).
 *
 * Every payment extends `credit_until` by amount ÷ price per day. Titan then unlocks the appliance with that
 * date (`paygo.unlock {until}`) so the device can lock itself on time even when it is offline, and locks it from the
 * server once credit and grace run out. Lease-to-own plans unlock for good (`until: 0`) once paid in full.
 * Payments arrive from the client's own collection system through the API, or through Paystack on Titan's pay page.
 */
import { randomBytes } from 'node:crypto';
import type { ActuatorService } from '../actuators/service.js';
import type { Notifier } from '../ingest/pipeline.js';
import type { SmsSender } from '../notify/providers.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export class PaygError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const paygCode = () => Array.from(randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

/** Hours of credit a payment buys. Pure. */
export function hoursFor(amount: number, pricePerDay: number): number {
  return Math.round((amount / pricePerDay) * 24 * 100) / 100;
}

/** New credit date: time is added from now, or from the current credit date if it is still in the future. Pure. */
export function extendCredit(current: Date, hours: number, now = new Date()): Date {
  const base = current > now ? current : now;
  return new Date(base.getTime() + hours * 3_600_000);
}

export const PAYG_EVENTS = ['payg.payment', 'payg.locked', 'payg.unlocked', 'payg.paid_off', 'payg.*'];

export class PaygService {
  constructor(readonly pool: Pool, private actuators: ActuatorService | null, private notifier: Notifier | null, private sms: SmsSender | null) {}

  private q(t: string, v: unknown[] = []) { return this.pool.query(t, v); }

  async createPlan(o: { orgId: string; name: string; currency?: string; pricePerDay: number; deposit?: number; totalPrice?: number | null; graceHours?: number; minPayment?: number }) {
    if (!(o.pricePerDay > 0)) throw new PaygError(400, 'invalid_price', 'Price per day must be more than 0');
    return (await this.q(
      `INSERT INTO payg_plans (org_id, name, currency, price_per_day, deposit, total_price, grace_hours, min_payment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [o.orgId, o.name, (o.currency ?? 'NGN').toUpperCase().slice(0, 3), o.pricePerDay, o.deposit ?? 0, o.totalPrice ?? null, o.graceHours ?? 0, o.minPayment ?? 0])).rows[0];
  }

  async listPlans(orgId: string | null) {
    return (await this.q(`SELECT p.*, o.name AS org_name FROM payg_plans p JOIN organisations o ON o.id = p.org_id WHERE $1::uuid IS NULL OR p.org_id = $1 ORDER BY p.created_at DESC`, [orgId])).rows;
  }

  /** Puts a device on a plan. The appliance starts locked until the first payment (or the deposit) arrives. */
  async createAccount(o: { orgId: string; deviceId: string; planId: string; customerName: string; customerPhone?: string | null; customerEmail?: string | null; customerRef?: string | null }) {
    const dev = (await this.q(`SELECT id, org_id, type_id FROM devices WHERE id = $1`, [o.deviceId])).rows[0];
    if (!dev || dev.org_id !== o.orgId) throw new PaygError(404, 'device_not_found', `No device ${o.deviceId} in your organisation`);
    if (dev.type_id !== 'paygo-appliance-v1') throw new PaygError(400, 'not_payg_device', `${o.deviceId} is not a PAYG appliance`);
    const plan = (await this.q(`SELECT * FROM payg_plans WHERE id = $1 AND org_id = $2`, [o.planId, o.orgId])).rows[0];
    if (!plan) throw new PaygError(404, 'plan_not_found', 'Plan not found');
    const existing = (await this.q(`SELECT id FROM payg_accounts WHERE device_id = $1`, [o.deviceId])).rows[0];
    if (existing) throw new PaygError(409, 'account_exists', `${o.deviceId} already has a PAYG account`);
    let account;
    for (let i = 0; i < 5 && !account; i++) {
      try {
        account = (await this.q(
          `INSERT INTO payg_accounts (org_id, device_id, plan_id, code, customer_name, customer_phone, customer_email, customer_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [o.orgId, o.deviceId, o.planId, paygCode(), o.customerName, o.customerPhone ?? null, o.customerEmail ?? null, o.customerRef ?? null])).rows[0];
      } catch (e) { if (!/code/.test(String(e))) throw e; }
    }
    await this.setLock(account, 'locked', 'new account');
    return account;
  }

  async getAccount(id: string, orgId: string | null) {
    const a = (await this.q(
      `SELECT a.*, p.name AS plan_name, p.currency, p.price_per_day, p.total_price, p.grace_hours, p.min_payment, p.deposit, d.status AS device_status, d.last_seen_at
       FROM payg_accounts a JOIN payg_plans p ON p.id = a.plan_id JOIN devices d ON d.id = a.device_id
       WHERE (a.id::text = $1 OR a.code = upper($1)) AND ($2::uuid IS NULL OR a.org_id = $2)`, [id, orgId])).rows[0];
    if (!a) throw new PaygError(404, 'not_found', 'PAYG account not found');
    return a;
  }

  async listAccounts(orgId: string | null, filter: { status?: string | null; due?: boolean } = {}) {
    return (await this.q(
      `SELECT a.*, p.name AS plan_name, p.currency, p.price_per_day, p.total_price, o.name AS org_name
       FROM payg_accounts a JOIN payg_plans p ON p.id = a.plan_id JOIN organisations o ON o.id = a.org_id
       WHERE ($1::uuid IS NULL OR a.org_id = $1) AND ($2::text IS NULL OR a.status = $2) AND (NOT $3 OR a.credit_until < now())
       ORDER BY a.credit_until ASC LIMIT 1000`, [orgId, filter.status ?? null, !!filter.due])).rows;
  }

  async payments(accountId: string) {
    return (await this.q(`SELECT * FROM payg_payments WHERE account_id = $1 ORDER BY received_at DESC LIMIT 200`, [accountId])).rows;
  }

  /**
   * Records a payment once per (organisation, reference) and unlocks the appliance until the new credit date.
   * Returns { duplicate: true } when the reference was already recorded, so collection systems can retry safely.
   */
  async recordPayment(o: { accountId: string; orgId: string | null; amount: number; reference: string; source: 'api' | 'paystack' | 'manual'; by: string; currency?: string }) {
    const acc = await this.getAccount(o.accountId, o.orgId);
    if (!(o.amount > 0)) throw new PaygError(400, 'invalid_amount', 'Amount must be more than 0');
    if (o.currency && o.currency.toUpperCase() !== acc.currency) throw new PaygError(400, 'wrong_currency', `This account is billed in ${acc.currency}`);
    if (acc.status === 'cancelled') throw new PaygError(400, 'account_cancelled', 'This account is cancelled');
    const dup = (await this.q(`SELECT * FROM payg_payments WHERE org_id = $1 AND reference = $2`, [acc.org_id, o.reference])).rows[0];
    if (dup) return { duplicate: true, payment: dup, account: acc };
    if (Number(acc.min_payment) > 0 && o.amount < Number(acc.min_payment)) throw new PaygError(400, 'below_minimum', `The minimum payment is ${acc.min_payment} ${acc.currency}`);

    const hours = hoursFor(o.amount, Number(acc.price_per_day));
    const creditUntil = extendCredit(new Date(acc.credit_until), hours);
    const totalPaid = Math.round((Number(acc.total_paid) + o.amount) * 100) / 100;
    const paidOff = acc.total_price !== null && totalPaid >= Number(acc.total_price);
    const payment = (await this.q(
      `INSERT INTO payg_payments (account_id, org_id, amount, currency, source, reference, hours_added, credit_until, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (org_id, reference) DO NOTHING RETURNING *`,
      [acc.id, acc.org_id, o.amount, acc.currency, o.source, o.reference, hours, creditUntil, o.by])).rows[0];
    if (!payment) return { duplicate: true, payment: null, account: acc };
    const updated = (await this.q(
      `UPDATE payg_accounts SET credit_until = $2, total_paid = $3, status = CASE WHEN $4 THEN 'paid_off' WHEN status = 'suspended' THEN 'active' ELSE status END, reminded_at = null
       WHERE id = $1 RETURNING *`, [acc.id, creditUntil, totalPaid, paidOff])).rows[0];
    await this.emit('payg.payment', updated, { amount: o.amount, currency: acc.currency, reference: o.reference, creditUntil: creditUntil.toISOString(), totalPaid });
    if (paidOff && acc.status !== 'paid_off') await this.emit('payg.paid_off', updated, { totalPaid });
    await this.setLock(updated, 'unlocked', paidOff ? 'paid off' : 'payment');
    return { duplicate: false, payment, account: updated };
  }

  async setStatus(id: string, orgId: string | null, status: 'active' | 'suspended' | 'cancelled') {
    const acc = await this.getAccount(id, orgId);
    const updated = (await this.q(`UPDATE payg_accounts SET status = $2 WHERE id = $1 RETURNING *`, [acc.id, status])).rows[0];
    if (status !== 'active') await this.setLock(updated, 'locked', status);
    else if (new Date(updated.credit_until) > new Date()) await this.setLock(updated, 'unlocked', 'reactivated');
    return updated;
  }

  /** Sends the lock or unlock command. Unlock carries the credit date (0 = unlocked for good). */
  private async setLock(acc: any, want: 'locked' | 'unlocked', why: string) {
    if (!this.actuators) return;
    const paidOff = acc.status === 'paid_off';
    try {
      if (want === 'unlocked') {
        await this.actuators.send(acc.device_id, 'paygo.unlock', { until: paidOff ? 0 : Math.floor(new Date(acc.credit_until).getTime() / 1000) }, { source: 'system', actor: `payg:${acc.id}` });
      } else {
        await this.actuators.send(acc.device_id, 'paygo.lock', {}, { source: 'system', actor: `payg:${acc.id}` });
      }
      await this.q(`UPDATE payg_accounts SET lock_state = $2, lock_sent_at = now() WHERE id = $1`, [acc.id, want]);
      await this.emit(want === 'locked' ? 'payg.locked' : 'payg.unlocked', acc, { reason: why });
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'payg command failed', account: acc.id, err: String((e as Error).message ?? e) }));
    }
  }

  private async emit(event: string, acc: any, extra: Record<string, unknown>) {
    if (!this.notifier) return;
    const site = (await this.q(`SELECT site_id FROM devices WHERE id = $1`, [acc.device_id])).rows[0];
    await this.notifier.emit(event, { orgId: acc.org_id, siteId: site?.site_id ?? null }, {
      accountId: acc.id, code: acc.code, deviceId: acc.device_id, customerRef: acc.customer_ref, status: acc.status, creditUntil: new Date(acc.credit_until).toISOString(), ...extra,
    });
  }

  /** Worker (every minute): locks appliances whose credit and grace have run out; reminds customers a day ahead. */
  async tick(now = new Date()) {
    const expired = (await this.q(
      `SELECT a.* FROM payg_accounts a JOIN payg_plans p ON p.id = a.plan_id
       WHERE a.status = 'active' AND a.credit_until + make_interval(hours => p.grace_hours) < $1
         AND (a.lock_state <> 'locked' OR a.lock_sent_at < $1::timestamptz - interval '6 hours')`, [now])).rows;
    for (const a of expired) await this.setLock(a, 'locked', 'credit ran out');

    if (!this.sms) return;
    const soon = (await this.q(
      `SELECT a.*, p.price_per_day, p.currency, o.name AS org_name FROM payg_accounts a JOIN payg_plans p ON p.id = a.plan_id JOIN organisations o ON o.id = a.org_id
       WHERE a.status = 'active' AND a.customer_phone IS NOT NULL AND a.reminded_at IS NULL
         AND a.credit_until BETWEEN $1 AND $1::timestamptz + interval '24 hours'`, [now])).rows;
    for (const a of soon) {
      const when = new Date(a.credit_until).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' });
      await this.sms.send(a.customer_phone, `${a.org_name}: your appliance credit ends ${when}. Pay with code ${a.code} to keep it running.`);
      await this.q(`UPDATE payg_accounts SET reminded_at = now() WHERE id = $1`, [a.id]);
    }
  }

  /** Readings report the real lock state (metric appliance.locked). */
  async onReadings(device: { id: string }, rows: { metric: string; value: number }[]) {
    const r = rows.filter((x) => x.metric === 'appliance.locked').at(-1);
    if (!r) return;
    await this.q(`UPDATE payg_accounts SET lock_state = $2 WHERE device_id = $1`, [device.id, r.value >= 0.5 ? 'locked' : 'unlocked']);
  }
}

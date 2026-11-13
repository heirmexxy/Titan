import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

export interface InvoiceLine {
  label: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

/** Pure invoice calculation from a plan and a month's usage. */
export function priceInvoice(
  plan: { name: string; baseFee: number; pricePerDevice: number; includedApiCalls: number; overagePer1kCalls: number },
  usage: { activeDevices: number; apiCalls: number },
): { lines: InvoiceLine[]; amount: number } {
  const lines: InvoiceLine[] = [];
  if (plan.baseFee > 0) lines.push({ label: `${plan.name} plan`, quantity: 1, unitPrice: plan.baseFee, amount: plan.baseFee });
  if (usage.activeDevices > 0 && plan.pricePerDevice > 0) {
    lines.push({ label: 'Active devices', quantity: usage.activeDevices, unitPrice: plan.pricePerDevice, amount: usage.activeDevices * plan.pricePerDevice });
  }
  const over = Math.max(0, usage.apiCalls - plan.includedApiCalls);
  if (over > 0 && plan.overagePer1kCalls > 0) {
    const k = Math.ceil(over / 1000);
    lines.push({ label: 'API calls over allowance (per 1,000)', quantity: k, unitPrice: plan.overagePer1kCalls, amount: k * plan.overagePer1kCalls });
  }
  const amount = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { lines, amount };
}

export class Billing {
  constructor(private pool: pg.Pool, private paystackSecret: string) {}

  /** Creates one invoice per subscribed organisation for a month, e.g. "2026-11". Idempotent. */
  async generateInvoices(period: string): Promise<number> {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('period must be YYYY-MM');
    const start = `${period}-01`;
    const subs = await this.pool.query(
      `SELECT s.org_id, p.* FROM subscriptions s JOIN plans p ON p.id = s.plan_id`);
    let created = 0;
    for (const s of subs.rows) {
      const u = await this.pool.query(
        `SELECT
           (SELECT count(DISTINCT device_id) FROM usage_devices_daily WHERE org_id = $1 AND day >= $2::date AND day < ($2::date + interval '1 month'))::int AS devices,
           (SELECT coalesce(sum(api_calls),0) FROM usage_daily WHERE org_id = $1 AND day >= $2::date AND day < ($2::date + interval '1 month'))::bigint AS api_calls`,
        [s.org_id, start]);
      const { lines, amount } = priceInvoice(
        { name: s.name, baseFee: Number(s.base_fee), pricePerDevice: Number(s.price_per_device), includedApiCalls: Number(s.included_api_calls), overagePer1kCalls: Number(s.overage_per_1k_calls) },
        { activeDevices: u.rows[0].devices, apiCalls: Number(u.rows[0].api_calls) },
      );
      const r = await this.pool.query(
        `INSERT INTO invoices (org_id, period, currency, lines, amount) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, period) DO NOTHING`,
        [s.org_id, period, s.currency, JSON.stringify(lines), amount]);
      created += r.rowCount ?? 0;
    }
    return created;
  }

  /** Starts a Paystack payment for an invoice and returns the checkout URL. */
  async startPayment(invoiceId: string, email: string, callbackUrl: string): Promise<string> {
    const inv = (await this.pool.query(`SELECT * FROM invoices WHERE id = $1 AND status = 'open'`, [invoiceId])).rows[0];
    if (!inv) throw new Error('Invoice not found or not open');
    const reference = `titan_${inv.id.replace(/-/g, '').slice(0, 20)}_${Date.now()}`;
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.paystackSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, amount: Math.round(Number(inv.amount) * 100), currency: inv.currency, reference, callback_url: callbackUrl,
        metadata: { app: 'titan', invoice_id: inv.id },
      }),
    });
    const json: any = await res.json();
    if (!res.ok || !json.status) throw new Error(`Paystack initialize failed: ${json.message ?? res.status}`);
    await this.pool.query(`UPDATE invoices SET paystack_reference = $2 WHERE id = $1`, [inv.id, reference]);
    return json.data.authorization_url as string;
  }

  /** Confirms a payment with Paystack's verify API and marks the invoice paid. Safe to call repeatedly. */
  async confirm(reference: string): Promise<boolean> {
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${this.paystackSecret}` },
    });
    const json: any = await res.json();
    if (!res.ok || json.data?.status !== 'success') return false;
    const r = await this.pool.query(
      `UPDATE invoices SET status = 'paid', paid_at = now()
       WHERE paystack_reference = $1 AND status = 'open' AND round(amount * 100) = $2 AND currency = $3`,
      [reference, json.data.amount, json.data.currency]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Paystack webhook signature: HMAC-SHA512 of the raw body with the secret key. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !this.paystackSecret) return false;
    const expected = createHmac('sha512', this.paystackSecret).update(rawBody).digest('hex');
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
}

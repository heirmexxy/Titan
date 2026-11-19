import type { Paystack } from '../billing/paystack.js';
import { mount, num, optStr, str, uuid, type ActorResolvers, type RouteDef } from '../http/actors.js';
import { HttpError, type Router } from '../http/router.js';
import { PaygError, type PaygService } from './payg.js';

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof PaygError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Kitovu staff must say which organisation a plan or account belongs to; everyone else uses their own. */
const orgFor = (a: { orgId: string | null }, body: any) => a.orgId ?? uuid(body?.orgId, 'orgId');

export function registerPayg(r: Router, payg: PaygService, auth: ActorResolvers, o: { paystack: Paystack | null; publicUrl: string; paystackHooks: ((ev: any) => Promise<void>)[] }) {
  const defs: RouteDef[] = [
    { method: 'GET', path: '/payg/plans', scope: 'manage:payg', handler: async (_q, a) => ({ body: { plans: await payg.listPlans(a.orgId) } }) },
    {
      method: 'POST', path: '/payg/plans', scope: 'manage:payg', privileged: true,
      handler: async (req, a) => {
        const b = req.body ?? {};
        const plan = await wrap(() => payg.createPlan({
          orgId: orgFor(a, b), name: str(b.name, 'name'), currency: optStr(b.currency, 3) ?? 'NGN',
          pricePerDay: num(b.pricePerDay, 'pricePerDay', { min: 0.01 })!, deposit: num(b.deposit, 'deposit', { min: 0, optional: true }) ?? 0,
          totalPrice: num(b.totalPrice, 'totalPrice', { min: 0.01, optional: true }), graceHours: num(b.graceHours, 'graceHours', { min: 0, max: 720, optional: true }) ?? 0,
          minPayment: num(b.minPayment, 'minPayment', { min: 0, optional: true }) ?? 0,
        }));
        return { status: 201, body: { plan } };
      },
    },
    {
      method: 'GET', path: '/payg/accounts', scope: 'manage:payg',
      handler: async (req, a) => ({ body: { accounts: await payg.listAccounts(a.orgId, { status: optStr(req.query.get('status'), 20), due: req.query.get('due') === '1' }) } }),
    },
    {
      method: 'POST', path: '/payg/accounts', scope: 'manage:payg', privileged: true,
      handler: async (req, a) => {
        const b = req.body ?? {};
        const account = await wrap(() => payg.createAccount({
          orgId: orgFor(a, b), deviceId: str(b.deviceId, 'deviceId', 64), planId: uuid(b.planId, 'planId'), customerName: str(b.customerName, 'customerName'),
          customerPhone: optStr(b.customerPhone, 32), customerEmail: optStr(b.customerEmail, 200), customerRef: optStr(b.customerRef, 100),
        }));
        return { status: 201, body: { account, payUrl: `${o.publicUrl}/pay/${account.code}` } };
      },
    },
    {
      method: 'GET', path: '/payg/accounts/:id', scope: 'manage:payg',
      handler: async (req, a) => {
        const account = await wrap(() => payg.getAccount(req.params.id, a.orgId));
        return { body: { account, payments: await payg.payments(account.id), payUrl: `${o.publicUrl}/pay/${account.code}` } };
      },
    },
    {
      // Collection systems post each payment once; re-posting the same reference is safe.
      method: 'POST', path: '/payg/accounts/:id/payments', scope: 'manage:payg',
      handler: async (req, a) => {
        const b = req.body ?? {};
        const out = await wrap(() => payg.recordPayment({
          accountId: req.params.id, orgId: a.orgId, amount: num(b.amount, 'amount', { min: 0.01 })!, reference: str(b.reference, 'reference', 100),
          currency: optStr(b.currency, 3) ?? undefined, source: a.kind === 'apikey' ? 'api' : 'manual', by: a.actor,
        }));
        return { status: out.duplicate ? 200 : 201, body: out };
      },
    },
    ...(['suspend', 'activate', 'cancel'] as const).map((act): RouteDef => ({
      method: 'POST', path: `/payg/accounts/:id/${act}`, scope: 'manage:payg', privileged: true,
      handler: async (req, a) => ({ body: { account: await wrap(() => payg.setStatus(req.params.id, a.orgId, act === 'suspend' ? 'suspended' : act === 'cancel' ? 'cancelled' : 'active')) } }),
    })),
  ];
  mount(r, defs, auth);

  // ---------- Public pay page ----------
  const page = (title: string, body: string) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><style>
body{margin:0;font-family:system-ui,sans-serif;background:#EEF2F0;color:#14213D}main{max-width:420px;margin:0 auto;padding:1.5rem 1rem}
.card{background:#fff;border:1px solid #D5DEDA;border-radius:12px;padding:1.25rem}h1{font-size:1.4rem;margin:.2rem 0 1rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem;margin:0 0 1rem}dt{color:#6B778F}dd{margin:0}
label{display:grid;gap:.3rem;margin:.75rem 0;font-size:.9rem;color:#4A5875}input{font:inherit;padding:.65rem;border:1px solid #D5DEDA;border-radius:8px}
button{font:inherit;font-weight:700;width:100%;padding:.8rem;border:0;border-radius:8px;background:#14213D;color:#fff;margin-top:.5rem}
.ok{background:#DDEFE5;color:#2F7D5B;padding:.7rem;border-radius:8px}.err{color:#C8462F}.muted{color:#6B778F;font-size:.85rem}</style></head>
<body><main>${body}</main></body></html>`;

  r.get('/pay/:code', async (req) => {
    const code = req.params.code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    let acc;
    try { acc = await payg.getAccount(code, null); } catch { return { status: 404, body: page('Not found', '<div class="card"><h1>Payment code not found</h1><p>Check the code on your appliance or receipt.</p></div>'), headers: { 'Content-Type': 'text/html; charset=utf-8' } }; }
    const org = (await payg.pool.query(`SELECT name FROM organisations WHERE id = $1`, [acc.org_id])).rows[0];
    const first = String(acc.customer_name).split(' ')[0];
    const until = new Date(acc.credit_until);
    const active = until > new Date();
    const paid = req.query.get('paid');
    const html = page(`Pay ${org.name}`, `<p class="muted">${esc(org.name)}</p><div class="card">
<h1>Top up appliance ${esc(acc.code)}</h1>
${paid === '1' ? '<p class="ok">Payment received. Your appliance will unlock within a minute when it is online.</p>' : paid === '0' ? '<p class="err">The payment was not completed.</p>' : ''}
<dl><dt>Customer</dt><dd>${esc(first)}</dd><dt>Plan</dt><dd>${esc(acc.plan_name)} · ${esc(acc.currency)} ${esc(Number(acc.price_per_day).toLocaleString())} per day</dd>
<dt>${active ? 'Paid until' : 'Credit ended'}</dt><dd>${esc(until.toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' }))}</dd></dl>
${acc.status === 'paid_off' ? '<p class="ok">This appliance is fully paid. Nothing more to pay.</p>' : o.paystack?.enabled ? `<form method="post" action="/api/pay/${esc(acc.code)}">
<label>Amount (${esc(acc.currency)})<input name="amount" type="number" inputmode="decimal" min="${esc(Math.max(Number(acc.min_payment), 1))}" step="any" required></label>
<label>Email for your receipt<input name="email" type="email" autocomplete="email" ${acc.customer_email ? `value="${esc(acc.customer_email)}"` : ''} required></label>
<button type="submit">Pay with card, transfer or USSD</button></form>` : '<p class="muted">Online payment is not available. Pay through your usual agent and quote the code above.</p>'}
</div><p class="muted">Payments are processed by Paystack. Powered by Titan.</p>`);
    return { body: html, headers: { 'Content-Type': 'text/html; charset=utf-8' } };
  });

  // Form post (urlencoded) or JSON → Paystack checkout.
  r.post('/api/pay/:code', async (req) => {
    if (!o.paystack?.enabled) throw new HttpError(503, 'payments_disabled', 'Online payment is not available');
    const form = req.body ?? Object.fromEntries(new URLSearchParams(req.rawBody.toString('utf8')));
    const acc = await wrap(() => payg.getAccount(req.params.code, null));
    if (acc.status !== 'active' && acc.status !== 'suspended') throw new HttpError(400, 'not_payable', 'This account cannot take payments');
    const amount = num(form.amount, 'amount', { min: Math.max(Number(acc.min_payment), 1), max: 10_000_000 })!;
    const email = str(form.email, 'email', 200);
    const org = (await payg.pool.query(`SELECT paystack_subaccount FROM organisations WHERE id = $1`, [acc.org_id])).rows[0];
    const reference = `payg_${acc.code}_${Date.now()}`;
    await payg.pool.query(`INSERT INTO payg_checkouts (reference, account_id, amount, currency) VALUES ($1,$2,$3,$4)`, [reference, acc.id, amount, acc.currency]);
    const url = await o.paystack.initialize({
      email, amount, currency: acc.currency, reference, callbackUrl: `${o.publicUrl}/api/pay/callback`,
      metadata: { app: 'titan', kind: 'payg', account_id: acc.id }, subaccount: org?.paystack_subaccount ?? null,
    });
    return req.body ? { body: { url } } : { status: 303, headers: { Location: url } };
  });

  const settle = async (reference: string): Promise<{ code: string; ok: boolean } | null> => {
    const co = (await payg.pool.query(`SELECT c.*, a.code FROM payg_checkouts c JOIN payg_accounts a ON a.id = c.account_id WHERE c.reference = $1`, [reference])).rows[0];
    if (!co) return null;
    if (co.status === 'paid') return { code: co.code, ok: true };
    const tx = await o.paystack!.verify(reference);
    if (!tx || tx.currency !== co.currency || Math.round(tx.amount * 100) !== Math.round(Number(co.amount) * 100)) return { code: co.code, ok: false };
    await payg.recordPayment({ accountId: co.account_id, orgId: null, amount: tx.amount, reference, source: 'paystack', by: 'paystack' });
    await payg.pool.query(`UPDATE payg_checkouts SET status = 'paid' WHERE reference = $1`, [reference]);
    return { code: co.code, ok: true };
  };

  r.get('/api/pay/callback', async (req) => {
    const ref = req.query.get('reference') ?? req.query.get('trxref') ?? '';
    const out = o.paystack?.enabled && ref ? await settle(ref).catch(() => null) : null;
    return { status: 302, headers: { Location: out ? `/pay/${out.code}?paid=${out.ok ? 1 : 0}` : '/' } };
  });

  o.paystackHooks.push(async (ev) => {
    if (ev.data?.metadata?.kind === 'payg' && o.paystack?.enabled) await settle(ev.data.reference);
  });
}

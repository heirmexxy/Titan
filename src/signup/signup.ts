/**
 * Self-serve accounts: sign-up with email confirmation, password reset, plan choice with a free trial,
 * a saved card (Paystack authorization) and automatic charging of monthly invoices.
 */
import { CONSOLE_COOKIE, hashPassword, SESSION_DAYS, sessionCookie } from '../admin/auth.js';
import type { Paystack } from '../billing/paystack.js';
import { randomToken, sha256Hex } from '../core/crypto.js';
import { optStr, str } from '../http/actors.js';
import { HttpError, type Req, type Res, type Router } from '../http/router.js';
import type { EmailSender } from '../notify/providers.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const VERIFY_HOURS = 48;
const RESET_HOURS = 2;
const CARD_CHECK_AMOUNT = 100; // ₦100, refunded straight away

/** Two to four capital letters from the company name, e.g. "Agro Fish Farms" → AFF. Pure. */
export function prefixCandidates(company: string): string[] {
  const words = company.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  const initials = words.map((w) => w[0]).join('');
  if (initials.length >= 2) out.add(initials.slice(0, 4));
  const letters = words.join('');
  if (letters.length >= 2) { out.add(letters.slice(0, 3)); out.add(letters.slice(0, 4)); out.add(letters.slice(0, 2)); }
  if (words[0] && words[0].length >= 2) out.add(words[0].slice(0, 4));
  return [...out].filter((p) => /^[A-Z]{2,6}$/.test(p) && p !== 'WG');
}

export interface SignupDeps {
  pool: Pool;
  email: EmailSender;
  paystack: Paystack | null;
  publicUrl: string;
  secureCookies: boolean;
  who: (req: Req, owner?: boolean) => Promise<{ orgId: string; email: string; userId: string }>;
  paystackHooks: ((ev: any) => Promise<void>)[];
}

export function registerSignup(r: Router, d: SignupDeps) {
  const q = (t: string, v: unknown[] = []) => d.pool.query(t, v);
  const hits = new Map<string, { n: number; reset: number }>();
  const limit = (key: string, max: number, windowMs: number) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return; }
    if (++h.n > max) throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait and try again.');
  };

  const issueToken = async (userId: string, purpose: 'verify_email' | 'reset_password', hours: number) => {
    const token = randomToken(32);
    await q(`INSERT INTO user_tokens (id, user_id, purpose, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4))`, [sha256Hex(token), userId, purpose, hours]);
    return token;
  };
  const useToken = async (token: string, purpose: string) => {
    const row = (await q(
      `UPDATE user_tokens SET used_at = now() WHERE id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256Hex(token), purpose])).rows[0];
    return row?.user_id as string | undefined;
  };
  const sendVerify = async (userId: string, email: string, name: string | null) => {
    const token = await issueToken(userId, 'verify_email', VERIFY_HOURS);
    const link = `${d.publicUrl}/api/signup/verify?token=${token}`;
    await d.email.send(email, 'Confirm your Titan account',
      `Hello${name ? ' ' + name : ''},\n\nConfirm your email to start using Titan:\n${link}\n\nThe link works for ${VERIFY_HOURS} hours. If you did not sign up, ignore this email.\n\nTitan by Kitovu`);
  };
  const newSession = async (userId: string, ip: string) => {
    const token = randomToken(32);
    await q(`INSERT INTO sessions (id, user_id, expires_at, ip) VALUES ($1,$2, now() + make_interval(days => $3), $4)`, [sha256Hex(token), userId, SESSION_DAYS, ip]);
    return sessionCookie(token, d.secureCookies, CONSOLE_COOKIE);
  };

  // ---------- Plans on offer ----------
  r.get('/api/signup/plans', async () => ({
    body: {
      plans: (await q(`SELECT id, name, currency, price_per_device, base_fee, included_api_calls, overage_per_1k_calls, features, trial_days, device_limit, description
                      FROM plans WHERE published AND self_serve ORDER BY sort, base_fee`)).rows,
    },
  }));

  // ---------- Sign up ----------
  r.post('/api/signup', async (req) => {
    limit(`signup:${req.ip}`, 5, 3_600_000);
    const b = req.body ?? {};
    if (b.website) return { status: 201, body: { ok: true } };   // honeypot: bots fill every field
    const company = str(b.company, 'company', 120);
    const name = str(b.name, 'name', 120);
    const email = str(b.email, 'email', 254).toLowerCase();
    if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address');
    const password = str(b.password, 'password', 500);
    if (password.length < 10) throw new HttpError(400, 'weak_password', 'Use at least 10 characters');
    const existing = (await q(`SELECT id, email_verified_at, name FROM users WHERE lower(email) = $1`, [email])).rows[0];
    if (existing) {
      // Do not reveal which emails have accounts; resend the link if it was never confirmed.
      if (!existing.email_verified_at) await sendVerify(existing.id, email, existing.name);
      return { status: 201, body: { ok: true, next: 'check_email' } };
    }
    const plan = b.planId ? (await q(`SELECT * FROM plans WHERE id = $1 AND published AND self_serve`, [b.planId])).rows[0] : null;
    if (b.planId && !plan) throw new HttpError(400, 'invalid_plan', 'That plan is not available');

    let prefix: string | null = null;
    for (const c of [...prefixCandidates(company), ...Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPRSTUVWXYZ'[Math.floor(Math.random() * 23)]).join(''))]) {
      if (!(await q(`SELECT 1 FROM organisations WHERE device_prefix = $1`, [c])).rows.length) { prefix = c; break; }
    }
    const org = (await q(
      `INSERT INTO organisations (name, kind, billing_email, device_prefix, phone, use_case, signup_source) VALUES ($1,'client',$2,$3,$4,$5,'self') RETURNING id`,
      [company, email, prefix, optStr(b.phone, 32), optStr(b.useCase, 60)])).rows[0];
    const user = (await q(
      `INSERT INTO users (org_id, email, name, role, password_hash, email_verified_at) VALUES ($1,$2,$3,'client_owner',$4,NULL) RETURNING id`,
      [org.id, email, name, await hashPassword(password)])).rows[0];
    if (plan) {
      await q(`INSERT INTO subscriptions (org_id, plan_id, status, trial_ends_at) VALUES ($1,$2,$3, CASE WHEN $4 > 0 THEN now() + make_interval(days => $4) END)`,
        [org.id, plan.id, Number(plan.trial_days) > 0 ? 'trialing' : 'active', Number(plan.trial_days)]);
    }
    await q(`INSERT INTO audit_log (actor, org_id, action, target, detail) VALUES ($1,$2,'org.signup',$2,$3)`, [`user:${user.id}`, org.id, JSON.stringify({ plan: plan?.id ?? null, ip: req.ip })]);
    await sendVerify(user.id, email, name);
    return { status: 201, body: { ok: true, next: 'check_email' } };
  });

  r.post('/api/signup/resend', async (req) => {
    limit(`resend:${req.ip}`, 5, 3_600_000);
    const email = str(req.body?.email, 'email', 254).toLowerCase();
    const u = (await q(`SELECT id, name FROM users WHERE lower(email) = $1 AND email_verified_at IS NULL`, [email])).rows[0];
    if (u) await sendVerify(u.id, email, u.name);
    return { body: { ok: true } };
  });

  // Link in the email: confirm, sign in, open the console.
  r.get('/api/signup/verify', async (req): Promise<Res> => {
    const userId = await useToken(String(req.query.get('token') ?? ''), 'verify_email');
    if (!userId) return { status: 302, headers: { Location: '/console/#login?verify=expired' } };
    await q(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [userId]);
    return { status: 302, headers: { Location: '/console/#welcome', 'Set-Cookie': await newSession(userId, req.ip) } };
  });

  // ---------- Password reset (every kind of user) ----------
  r.post('/api/password/forgot', async (req) => {
    limit(`forgot:${req.ip}`, 5, 3_600_000);
    const email = str(req.body?.email, 'email', 254).toLowerCase();
    const u = (await q(`SELECT id, name, role FROM users WHERE lower(email) = $1 AND disabled_at IS NULL`, [email])).rows[0];
    if (u) {
      const token = await issueToken(u.id, 'reset_password', RESET_HOURS);
      const page = ['admin', 'ops'].includes(u.role) ? '/admin/' : u.role === 'verifier' ? '/verify/' : '/console/';
      await d.email.send(email, 'Reset your Titan password',
        `Someone asked to reset the password for this Titan account.\n\nChoose a new password here:\n${d.publicUrl}${page}#reset?token=${token}\n\nThe link works for ${RESET_HOURS} hours. If it wasn't you, ignore this email.`);
    }
    return { body: { ok: true } };
  });
  r.post('/api/password/reset', async (req) => {
    limit(`reset:${req.ip}`, 10, 3_600_000);
    const password = str(req.body?.password, 'password', 500);
    if (password.length < 10) throw new HttpError(400, 'weak_password', 'Use at least 10 characters');
    const userId = await useToken(str(req.body?.token, 'token', 200), 'reset_password');
    if (!userId) throw new HttpError(400, 'invalid_token', 'This link has expired. Ask for a new one.');
    await q(`UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [userId, await hashPassword(password)]);
    await q(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    return { body: { ok: true } };
  });

  // ---------- Subscription and card (console) ----------
  r.get('/console/api/subscription', async (req) => {
    const w = await d.who(req);
    const sub = (await q(`SELECT s.*, p.name AS plan_name, p.currency, p.base_fee, p.price_per_device, p.device_limit, p.trial_days
                          FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.org_id = $1`, [w.orgId])).rows[0] ?? null;
    const card = (await q(`SELECT card_brand, last4, exp, email, created_at FROM payment_methods WHERE org_id = $1`, [w.orgId])).rows[0] ?? null;
    const plans = (await q(`SELECT id, name, currency, base_fee, price_per_device, device_limit, trial_days, description, features FROM plans WHERE published AND self_serve ORDER BY sort, base_fee`)).rows;
    const devices = (await q(`SELECT count(*)::int AS n FROM devices WHERE org_id = $1`, [w.orgId])).rows[0].n;
    return { body: { subscription: sub, card, plans, devices, cardPayments: !!d.paystack?.enabled } };
  });

  r.post('/console/api/subscription/plan', async (req) => {
    const w = await d.who(req, true);
    const plan = (await q(`SELECT * FROM plans WHERE id = $1 AND published AND self_serve`, [req.body?.planId])).rows[0];
    if (!plan) throw new HttpError(400, 'invalid_plan', 'That plan is not available');
    const devices = (await q(`SELECT count(*)::int AS n FROM devices WHERE org_id = $1`, [w.orgId])).rows[0].n;
    if (plan.device_limit != null && devices > Number(plan.device_limit)) throw new HttpError(400, 'too_many_devices', `You have ${devices} devices; this plan allows ${plan.device_limit}.`);
    const had = (await q(`SELECT 1 FROM subscriptions WHERE org_id = $1`, [w.orgId])).rows.length;
    if (had) await q(`UPDATE subscriptions SET plan_id = $2 WHERE org_id = $1`, [w.orgId, plan.id]);
    else await q(`INSERT INTO subscriptions (org_id, plan_id, status, trial_ends_at) VALUES ($1,$2,$3, CASE WHEN $4 > 0 THEN now() + make_interval(days => $4) END)`,
      [w.orgId, plan.id, Number(plan.trial_days) > 0 ? 'trialing' : 'active', Number(plan.trial_days)]);
    await q(`INSERT INTO audit_log (actor, org_id, action, target) VALUES ($1,$2,'subscription.plan',$3)`, [`user:${w.userId}`, w.orgId, plan.id]);
    return { body: { ok: true } };
  });

  // Saves a card: a ₦100 check through Paystack, refunded at once. Later invoices are charged to it automatically.
  r.post('/console/api/subscription/card', async (req) => {
    const w = await d.who(req, true);
    if (!d.paystack?.enabled) throw new HttpError(503, 'payments_unavailable', 'Card payments are not set up yet. Contact titan@kitovu.com.ng.');
    const reference = `card_${w.orgId.replace(/-/g, '').slice(0, 12)}_${Date.now()}`;
    const url = await d.paystack.initialize({
      email: w.email, amount: CARD_CHECK_AMOUNT, currency: 'NGN', reference, callbackUrl: `${d.publicUrl}/api/billing/card-callback`,
      metadata: { app: 'titan', kind: 'card', org_id: w.orgId }, channels: ['card'],
    });
    return { body: { url } };
  });

  const saveCard = async (reference: string): Promise<boolean> => {
    const tx = await d.paystack!.verify(reference);
    if (!tx || tx.metadata?.kind !== 'card' || !tx.authorization?.reusable) return false;
    await q(`INSERT INTO payment_methods (org_id, authorization_code, email, card_brand, last4, exp) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (org_id) DO UPDATE SET authorization_code = $2, email = $3, card_brand = $4, last4 = $5, exp = $6, created_at = now()`,
      [tx.metadata.org_id, tx.authorization.authorization_code, tx.customer?.email ?? '', tx.authorization.brand ?? null, tx.authorization.last4 ?? null,
        tx.authorization.exp_month ? `${tx.authorization.exp_month}/${String(tx.authorization.exp_year).slice(-2)}` : null]);
    await q(`UPDATE subscriptions SET status = 'active' WHERE org_id = $1 AND status = 'past_due'`, [tx.metadata.org_id]);
    d.paystack!.refund(reference).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'card check refund failed', reference, err: String(e) })));
    return true;
  };
  r.get('/api/billing/card-callback', async (req) => {
    const ref = req.query.get('reference') ?? req.query.get('trxref') ?? '';
    const ok = d.paystack?.enabled && ref ? await saveCard(ref).catch(() => false) : false;
    return { status: 302, headers: { Location: `/console/#billing?card=${ok ? 1 : 0}` } };
  });
  d.paystackHooks.push(async (ev) => { if (ev.data?.metadata?.kind === 'card' && d.paystack?.enabled) await saveCard(ev.data.reference); });
}

/** Worker: ends trials and charges open invoices to saved cards (up to 3 tries, a day apart). */
export async function runBillingCycle(pool: Pool, paystack: Paystack | null, email: EmailSender, publicUrl: string, now = new Date()) {
  const q = (t: string, v: unknown[] = []) => pool.query(t, v);
  const ended = (await q(
    `UPDATE subscriptions s SET status = CASE WHEN EXISTS (SELECT 1 FROM payment_methods pm WHERE pm.org_id = s.org_id) THEN 'active' ELSE 'past_due' END
     WHERE status = 'trialing' AND trial_ends_at < $1 RETURNING org_id, status`, [now])).rows;
  for (const s of ended.filter((x) => x.status === 'past_due')) {
    const o = (await q(`SELECT billing_email, name FROM organisations WHERE id = $1`, [s.org_id])).rows[0];
    if (o?.billing_email) await email.send(o.billing_email, 'Your Titan trial has ended',
      `Your Titan trial for ${o.name} has ended. Your devices keep reporting, but please add a card under Billing to keep your account in good standing:\n${publicUrl}/console/#billing`);
  }
  if (!paystack?.enabled) return { trialsEnded: ended.length, charged: 0 };
  let charged = 0;
  const due = (await q(
    `SELECT i.*, pm.authorization_code, pm.email FROM invoices i JOIN payment_methods pm ON pm.org_id = i.org_id
     WHERE i.status = 'open' AND i.amount > 0 AND i.charge_attempts < 3 AND (i.charge_attempts = 0 OR i.created_at < $1::timestamptz - make_interval(days => i.charge_attempts))`, [now])).rows;
  for (const inv of due) {
    const reference = `inv_${inv.id.replace(/-/g, '').slice(0, 16)}_${inv.charge_attempts + 1}`;
    try {
      const ok = await paystack.chargeAuthorization({ email: inv.email, authorizationCode: inv.authorization_code, amount: Number(inv.amount), currency: inv.currency, reference, metadata: { app: 'titan', invoice_id: inv.id } });
      if (ok) {
        await q(`UPDATE invoices SET status = 'paid', paid_at = now(), paystack_reference = $2, charge_attempts = charge_attempts + 1 WHERE id = $1`, [inv.id, reference]);
        charged++;
        continue;
      }
      throw new Error('charge declined');
    } catch (e) {
      const r = (await q(`UPDATE invoices SET charge_attempts = charge_attempts + 1, last_charge_error = $2 WHERE id = $1 RETURNING charge_attempts`, [inv.id, String((e as Error).message ?? e).slice(0, 200)])).rows[0];
      if (r.charge_attempts >= 3) await q(`UPDATE subscriptions SET status = 'past_due' WHERE org_id = $1`, [inv.org_id]);
    }
  }
  return { trialsEnded: ended.length, charged };
}


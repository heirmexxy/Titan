/** Minimal Paystack client (https://paystack.com/docs/api). Amounts are in the major unit (naira); Paystack wants kobo. */
export class Paystack {
  constructor(private secret: string, private base = 'https://api.paystack.co') {}

  get enabled() { return !!this.secret; }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.secret) throw new Error('Paystack is not configured (PAYSTACK_SECRET_KEY)');
    const res = await fetch(this.base + path, {
      method, headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.status === false) throw new Error(`Paystack ${path} failed: ${json.message ?? res.status}`);
    return json.data;
  }

  /** Starts a checkout; returns the page the payer is sent to. */
  async initialize(o: { email: string; amount: number; currency: string; reference: string; callbackUrl: string; metadata: Record<string, unknown>; subaccount?: string | null; channels?: string[] }) {
    const data = await this.call('POST', '/transaction/initialize', {
      email: o.email, amount: Math.round(o.amount * 100), currency: o.currency, reference: o.reference, callback_url: o.callbackUrl,
      metadata: o.metadata, ...(o.subaccount ? { subaccount: o.subaccount } : {}), ...(o.channels ? { channels: o.channels } : {}),
    });
    return data.authorization_url as string;
  }

  /** Confirms a transaction. Returns null unless it succeeded. */
  async verify(reference: string): Promise<{ amount: number; currency: string; metadata: any; authorization: any; customer: any } | null> {
    const data = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (data?.status !== 'success') return null;
    return { amount: Number(data.amount) / 100, currency: data.currency, metadata: data.metadata ?? {}, authorization: data.authorization ?? null, customer: data.customer ?? null };
  }

  /** Charges a saved card (recurring billing). */
  async chargeAuthorization(o: { email: string; authorizationCode: string; amount: number; currency: string; reference: string; metadata: Record<string, unknown> }) {
    const data = await this.call('POST', '/transaction/charge_authorization', {
      email: o.email, authorization_code: o.authorizationCode, amount: Math.round(o.amount * 100), currency: o.currency, reference: o.reference, metadata: o.metadata,
    });
    return data?.status === 'success';
  }

  async refund(reference: string) {
    await this.call('POST', '/refund', { transaction: reference });
  }
}

import { sha256Hex } from '../core/crypto.js';
import type { ApiKey, Store } from '../store/types.js';
import { HttpError, type Req } from './router.js';

const RATE_PER_MIN = 600;

export type ApiKeyAuth = (req: Req, scope?: string) => Promise<ApiKey>;

/** Bearer-key authentication shared by every /v1 module: checks the key, its scope and the rate limit, and meters usage. */
export function createApiKeyAuth(store: Store): ApiKeyAuth {
  const buckets = new Map<string, { n: number; reset: number }>();
  const rateLimit = (key: string) => {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + 60_000 }); return; }
    if (++b.n > RATE_PER_MIN) throw new HttpError(429, 'rate_limited', 'Too many requests; limit is 600 per minute per key');
  };
  return async (req, scope) => {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer (tk_(live|test)_[A-Za-z0-9_-]{20,})$/.exec(h);
    if (!m) throw new HttpError(401, 'unauthorized', 'Send Authorization: Bearer tk_live_…');
    const key = await store.getApiKeyByHash(sha256Hex(m[1]));
    if (!key || key.revokedAt) throw new HttpError(401, 'unauthorized', 'Invalid or revoked API key');
    if (scope && !key.scopes.includes(scope)) throw new HttpError(403, 'forbidden', `Key lacks scope ${scope}`);
    rateLimit(key.id);
    await store.touchApiKey(key.id);
    await store.addUsage(key.orgId, new Date().toISOString().slice(0, 10), { apiCalls: 1 });
    return key;
  };
}

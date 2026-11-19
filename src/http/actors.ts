/**
 * One handler, three doors. Feature modules (firmware, PAYG, quality, exports…) describe each route once and
 * mount it on the admin API (/admin/api, Kitovu staff, every organisation), the client console (/console/api,
 * one organisation) and the public API (/v1, one organisation, per-scope API keys).
 */
import { HttpError, type Req, type Res, type Router } from './router.js';

export interface Actor {
  /** null = Kitovu staff acting across every organisation. */
  orgId: string | null;
  /** Written to audit logs and created_by columns: user:<id> | apikey:<id> | support:<id>. */
  actor: string;
  kind: 'kitovu' | 'owner' | 'member' | 'apikey';
  email?: string;
}

export type Surface = 'admin' | 'console' | 'api';

export interface RouteDef {
  method: 'GET' | 'POST' | 'DELETE';
  /** Relative path, e.g. "/firmware/:id". */
  path: string;
  /** API key scope required on /v1. Routes without a scope are not mounted on /v1. */
  scope?: string;
  /** Console: only account owners. Admin: only admins (not ops). */
  privileged?: boolean;
  on?: Surface[];
  maxBody?: number;
  handler: (req: Req, a: Actor) => Promise<Res> | Res;
}

export interface ActorResolvers {
  admin?: (req: Req, privileged: boolean) => Promise<Actor>;
  console?: (req: Req, privileged: boolean) => Promise<Actor>;
  api?: (req: Req, scope: string) => Promise<Actor>;
}

const PREFIX: Record<Surface, string> = { admin: '/admin/api', console: '/console/api', api: '/v1' };

export function mount(r: Router, defs: RouteDef[], auth: ActorResolvers) {
  for (const def of defs) {
    for (const surface of def.on ?? (['admin', 'console', 'api'] as Surface[])) {
      if (surface === 'api' && !def.scope) continue;
      const resolve = auth[surface];
      if (!resolve) continue;
      const path = PREFIX[surface] + def.path;
      const handler = async (req: Req) => {
        const actor = surface === 'api' ? await (resolve as NonNullable<ActorResolvers['api']>)(req, def.scope!) : await (resolve as (r: Req, p: boolean) => Promise<Actor>)(req, !!def.privileged);
        return def.handler(req, actor);
      };
      r.on(def.method, path, handler, { maxBody: def.maxBody });
    }
  }
}

/** Throws 404 unless the actor may see rows of `orgId` (Kitovu staff see all). */
export function ownedBy(a: Actor, orgId: string | null | undefined) {
  if (a.orgId !== null && a.orgId !== orgId) throw new HttpError(404, 'not_found');
}

// Small validators shared by feature modules.
export const str = (v: unknown, name: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'invalid_request', `${name} is required`);
  return v.trim().slice(0, max);
};
export const optStr = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
export const num = (v: unknown, name: string, o: { min?: number; max?: number; optional?: boolean } = {}): number | null => {
  if (v === undefined || v === null || v === '') {
    if (o.optional) return null;
    throw new HttpError(400, 'invalid_request', `${name} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, 'invalid_request', `${name} must be a number`);
  if (o.min !== undefined && n < o.min) throw new HttpError(400, 'invalid_request', `${name} must be at least ${o.min}`);
  if (o.max !== undefined && n > o.max) throw new HttpError(400, 'invalid_request', `${name} must be at most ${o.max}`);
  return n;
};
export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
export const uuid = (v: unknown, name: string): string => {
  if (!isUuid(v)) throw new HttpError(400, 'invalid_request', `${name} must be an id`);
  return v;
};
export const date = (v: unknown, name: string, fallback?: Date): Date => {
  if (v === undefined || v === null || v === '') {
    if (fallback) return fallback;
    throw new HttpError(400, 'invalid_request', `${name} is required`);
  }
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid_date', `${name} is not a valid date`);
  return d;
};

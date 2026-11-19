import { date, mount, num, optStr, str, uuid, type Actor, type ActorResolvers, type RouteDef } from '../http/actors.js';
import { HttpError, type Router } from '../http/router.js';
import { QualityError, SAMPLE_PARAMS, type QualityService } from './quality.js';

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof QualityError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
};
const orgFor = (a: Actor, body: any) => a.orgId ?? uuid(body?.orgId, 'orgId');
const optNum = (v: unknown, name: string, min?: number, max?: number) => num(v, name, { optional: true, min, max });

export function registerQuality(r: Router, qs: QualityService, auth: ActorResolvers) {
  const defs: RouteDef[] = [
    { method: 'GET', path: '/quality/parameters', scope: 'read:quality', handler: () => ({ body: { parameters: SAMPLE_PARAMS } }) },
    {
      method: 'GET', path: '/quality/specs', scope: 'read:quality',
      handler: async (req, a) => ({ body: { specs: await qs.listSpecs(a.orgId, req.query.get('all') === '1') } }),
    },
    {
      method: 'POST', path: '/quality/specs', scope: 'write:quality', privileged: true,
      handler: async (req, a) => {
        const b = req.body ?? {};
        const spec = await wrap(() => qs.createSpec({ orgId: orgFor(a, b), name: str(b.name, 'name'), buyer: optStr(b.buyer), commodity: str(b.commodity, 'commodity', 60), parameters: b.parameters }));
        return { status: 201, body: { spec } };
      },
    },
    ...(['activate', 'deactivate'] as const).map((act): RouteDef => ({
      method: 'POST', path: `/quality/specs/:id/${act}`, scope: 'write:quality', privileged: true,
      handler: async (req, a) => { await wrap(() => qs.setSpecActive(uuid(req.params.id, 'id'), a.orgId, act === 'activate')); return { body: { ok: true } }; },
    })),
    {
      method: 'GET', path: '/quality/tests', scope: 'read:quality',
      handler: async (req, a) => {
        const lotCode = optStr(req.query.get('lot'), 40);
        const lot = lotCode ? await wrap(() => qs.findLot(lotCode, a.orgId)) : null;
        const tests = await qs.listTests(a.orgId, {
          lotId: lot?.id ?? null, siteId: optStr(req.query.get('site'), 36), outcome: optStr(req.query.get('outcome'), 10),
          from: req.query.get('from') ? date(req.query.get('from'), 'from') : null, to: req.query.get('to') ? date(req.query.get('to'), 'to') : null,
          limit: Number(req.query.get('limit') ?? 500) || 500,
        });
        return { body: { tests } };
      },
    },
    {
      method: 'POST', path: '/quality/tests', scope: 'write:quality',
      handler: async (req, a) => {
        const b = req.body ?? {};
        const test = await wrap(() => qs.recordTest({
          orgId: orgFor(a, b), lot: optStr(b.lot, 40), specId: optStr(b.specId, 36), siteId: optStr(b.siteId, 36), sampleRef: optStr(b.sampleRef, 60),
          commodity: optStr(b.commodity, 60), results: b.results, lat: optNum(b.lat, 'lat', -90, 90), lng: optNum(b.lng, 'lng', -180, 180),
          testedAt: b.testedAt ? date(b.testedAt, 'testedAt') : null, by: a.actor, clientRef: optStr(b.clientRef, 80),
        }));
        return { status: 201, body: { test } };
      },
    },
    {
      method: 'GET', path: '/lots', scope: 'read:quality',
      handler: async (req, a) => ({ body: { lots: await qs.listLots(a.orgId, { q: optStr(req.query.get('q'), 60), status: optStr(req.query.get('status'), 20), siteId: optStr(req.query.get('site'), 36) }) } }),
    },
    {
      method: 'POST', path: '/lots', scope: 'write:quality',
      handler: async (req, a) => {
        const b = req.body ?? {};
        const lot = await wrap(() => qs.createLot({
          orgId: orgFor(a, b), code: optStr(b.code, 40), commodity: str(b.commodity, 'commodity', 60), quantity: optNum(b.quantity, 'quantity', 0), unit: optStr(b.unit, 12),
          origin: optStr(b.origin), lat: optNum(b.lat, 'lat', -90, 90), lng: optNum(b.lng, 'lng', -180, 180), harvestedOn: optStr(b.harvestedOn, 10),
          siteId: optStr(b.siteId, 36), by: a.actor, clientRef: optStr(b.clientRef, 80),
        }));
        return { status: 201, body: { lot } };
      },
    },
    { method: 'GET', path: '/lots/:code', scope: 'read:quality', handler: async (req, a) => ({ body: await wrap(() => qs.trace(req.params.code, a.orgId)) }) },
    {
      method: 'POST', path: '/lots/:code/events', scope: 'write:quality',
      handler: async (req, a) => {
        const b = req.body ?? {};
        const event = await wrap(() => qs.addEvent({
          orgId: a.orgId, lot: req.params.code, kind: str(b.kind, 'kind', 20), siteId: optStr(b.siteId, 36), stack: optStr(b.stack, 80), counterparty: optStr(b.counterparty),
          quantity: optNum(b.quantity, 'quantity', 0), note: optStr(b.note, 1000), lat: optNum(b.lat, 'lat', -90, 90), lng: optNum(b.lng, 'lng', -180, 180),
          at: b.at ? date(b.at, 'at') : null, by: a.actor, clientRef: optStr(b.clientRef, 80),
          mergeFrom: Array.isArray(b.mergeFrom) ? b.mergeFrom.map(String).slice(0, 50) : typeof b.mergeFrom === 'string' ? b.mergeFrom.split(/[\s,]+/).filter(Boolean) : [],
        }));
        return { status: 201, body: { event } };
      },
    },
  ];
  mount(r, defs, auth);
}

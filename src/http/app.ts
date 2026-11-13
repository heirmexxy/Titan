import { clampQuery, resolveAccess, type SiteAccess } from '../core/access.js';
import { buildConditionReport } from '../core/conditions.js';
import { b64urlDecode, randomToken, safeEqual, sha256Hex, verifyEd25519, verifyHmacSha256 } from '../core/crypto.js';
import { MESSAGE_KINDS, parseUplinkTopic, type MessageKind } from '../core/envelope.js';
import type { Billing } from '../billing/billing.js';
import { CommandError } from '../actuators/catalogue.js';
import type { ActuatorService } from '../actuators/service.js';
import { CarbonError, type CarbonService } from '../carbon/service.js';
import type { DeviceService } from '../ingest/devices.js';
import type { IngestPipeline } from '../ingest/pipeline.js';
import type { EmailSender } from '../notify/providers.js';
import type { ApiKey, Device, Store } from '../store/types.js';
import { HttpError, Router, type Req } from './router.js';

export interface AppDeps {
  store: Store;
  pipeline: IngestPipeline;
  devices: DeviceService;
  email: EmailSender;
  billing: Billing | null;
  internalSecret: string;
  publicUrl: string;
  demoInbox: string;
  mqtt: { host: string; port: number };
  staticDir?: string;
  actuators?: ActuatorService;
  carbon?: CarbonService;
}

const INTERVALS = new Set(['raw', '1m', '1h', '1d']);
const RATE_PER_MIN = 600;

export function createApp(d: AppDeps): Router {
  const r = new Router(d.staticDir);
  const buckets = new Map<string, { n: number; reset: number }>();

  // ---------- helpers ----------
  const internal = (req: Req) => {
    const s = req.headers['x-titan-internal'];
    if (typeof s !== 'string' || !safeEqual(s, d.internalSecret)) throw new HttpError(401, 'unauthorized');
  };

  const rateLimit = (key: string) => {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + 60_000 }); return; }
    if (++b.n > RATE_PER_MIN) throw new HttpError(429, 'rate_limited', 'Too many requests; limit is 600 per minute per key');
  };

  const apiKey = async (req: Req, scope?: string): Promise<ApiKey> => {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer (tk_(live|test)_[A-Za-z0-9_-]{20,})$/.exec(h);
    if (!m) throw new HttpError(401, 'unauthorized', 'Send Authorization: Bearer tk_live_…');
    const key = await d.store.getApiKeyByHash(sha256Hex(m[1]));
    if (!key || key.revokedAt) throw new HttpError(401, 'unauthorized', 'Invalid or revoked API key');
    if (scope && !key.scopes.includes(scope)) throw new HttpError(403, 'forbidden', `Key lacks scope ${scope}`);
    rateLimit(key.id);
    await d.store.touchApiKey(key.id);
    await d.store.addUsage(key.orgId, new Date().toISOString().slice(0, 10), { apiCalls: 1 });
    return key;
  };

  const deviceAuth = async (req: Req): Promise<Device> => {
    const m = /^Device ([A-Za-z0-9_-]+):(.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !(await d.devices.authenticate(m[1], m[2], m[1]))) throw new HttpError(401, 'unauthorized');
    return (await d.store.getDevice(m[1]))!;
  };

  const parseDate = (v: string | null, fallback: Date) => {
    if (!v) return fallback;
    const t = new Date(v);
    if (Number.isNaN(t.getTime())) throw new HttpError(400, 'invalid_date', `Invalid date ${v}`);
    return t;
  };

  const siteAccess = (access: Map<string, SiteAccess>, siteId: string) => {
    const a = access.get(siteId);
    if (!a) throw new HttpError(404, 'site_not_found');
    return a;
  };

  // ---------- health ----------
  r.get('/healthz', () => ({ body: { ok: true, service: 'titan' } }));

  // ---------- EMQX hooks ----------
  r.post('/internal/emqx/auth', async (req) => {
    internal(req);
    const { username, password, clientid } = req.body ?? {};
    const ok = await d.devices.authenticate(String(username ?? ''), String(password ?? ''), String(clientid ?? ''));
    return { body: { result: ok ? 'allow' : 'deny', is_superuser: false } };
  });

  r.post('/internal/emqx/acl', async (req) => {
    internal(req);
    const { username, topic, action } = req.body ?? {};
    return { body: { result: d.devices.authorize(String(username ?? ''), String(topic ?? ''), String(action ?? '')) ? 'allow' : 'deny' } };
  });

  r.post('/internal/emqx/message', async (req) => {
    internal(req);
    const { topic, payload, username } = req.body ?? {};
    const t = parseUplinkTopic(String(topic ?? ''));
    if (!t || t.deviceId !== username) throw new HttpError(400, 'bad_topic');
    if (t.kind === 'lwt') {
      await d.pipeline.deviceOffline(t.deviceId);
      return { body: { ok: true } };
    }
    const result = await d.pipeline.handle(t.deviceId, t.kind, String(payload ?? ''));
    return { status: result.status === 'rejected' ? 422 : 200, body: result };
  });

  r.post('/internal/emqx/event', async (req) => {
    internal(req);
    const { event, username } = req.body ?? {};
    if (event === 'client.disconnected' && username) await d.pipeline.deviceOffline(String(username));
    return { body: { ok: true } };
  });

  // ---------- Device endpoints ----------
  r.post('/api/provision', async (req) => {
    const { deviceId, code, publicKey } = req.body ?? {};
    if (typeof deviceId !== 'string' || typeof code !== 'string' || typeof publicKey !== 'string') throw new HttpError(400, 'invalid_request');
    rateLimit(`provision:${req.ip}`);
    const out = await d.devices.provision(deviceId, code, publicKey);
    if ('error' in out) throw new HttpError(400, out.error);
    return { body: { ...out, mqtt: { host: d.mqtt.host, port: d.mqtt.port, username: deviceId, clientId: deviceId } } };
  });

  r.post('/api/ingest', async (req) => {
    const device = await deviceAuth(req);
    const kind = String(req.headers['x-titan-kind'] ?? 'telemetry') as MessageKind;
    if (!MESSAGE_KINDS.includes(kind)) throw new HttpError(400, 'bad_kind');
    const result = await d.pipeline.handle(device.id, kind, req.rawBody);
    return { status: result.status === 'rejected' ? 422 : 200, body: result };
  });

  r.get('/api/device/config', async (req) => {
    const device = await deviceAuth(req);
    return { body: { cfg: device.configVersion, acked: device.configAckedVersion, override: device.configOverride } };
  });

  // ---------- Public ----------
  r.get('/api/public/plans', async () => ({ body: { plans: await d.store.listPublishedPlans() } }));

  r.post('/api/public/demo', async (req) => {
    rateLimit(`demo:${req.ip}`);
    const b = req.body ?? {};
    const clean = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
    const name = clean(b.name, 120);
    const email = clean(b.email, 200);
    if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid_request', 'Name and a valid email are required');
    const rec = { name, email, company: clean(b.company, 200), phone: clean(b.phone, 40), useCase: clean(b.useCase, 80), message: clean(b.message, 2000) };
    await d.store.saveDemoRequest(rec);
    const text = Object.entries(rec).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
    await d.email.send(d.demoInbox, `Titan demo request — ${rec.company ?? rec.name}`, text, undefined, email);
    return { status: 201, body: { ok: true } };
  });

  r.post('/api/paystack/webhook', async (req) => {
    if (!d.billing) throw new HttpError(503, 'billing_disabled');
    if (!d.billing.verifyWebhook(req.rawBody, req.headers['x-paystack-signature'] as string | undefined)) throw new HttpError(401, 'bad_signature');
    const ev = req.body;
    if (ev?.event === 'charge.success' && ev.data?.metadata?.app === 'titan') await d.billing.confirm(ev.data.reference);
    return { body: { ok: true } };
  });

  r.get('/api/paystack/callback', async (req) => {
    const ref = req.query.get('reference') ?? req.query.get('trxref');
    const paid = d.billing && ref ? await d.billing.confirm(ref) : false;
    return { status: 302, headers: { Location: `/console/billing?paid=${paid ? 1 : 0}` } };
  });

  // ---------- API v1 ----------
  r.get('/v1/metrics', async (req) => {
    await apiKey(req);
    return { body: { metrics: [...(await d.store.getMetrics()).values()] } };
  });

  r.get('/v1/sites', async (req) => {
    const key = await apiKey(req);
    const access = await resolveAccess(d.store, key.orgId);
    const ref = req.query.get('ref');
    const sites = (await d.store.getSites([...access.keys()])).filter((s) => !ref || s.externalRef === ref);
    return { body: { sites: sites.map((s) => ({ ...s, access: describeAccess(access.get(s.id)!) })) } };
  });

  r.get('/v1/sites/:id', async (req) => {
    const key = await apiKey(req);
    const access = await resolveAccess(d.store, key.orgId);
    const a = siteAccess(access, req.params.id);
    const [site] = await d.store.getSites([req.params.id]);
    const devices = await d.store.listDevices([req.params.id]);
    return { body: { site: { ...site, access: describeAccess(a) }, devices: devices.map(publicDevice) } };
  });

  // Storage-condition summary for a site, zone or stack over a period, e.g. a warehouse receipt's storage period.
  r.get('/v1/sites/:id/conditions', async (req) => {
    const key = await apiKey(req, 'read:readings');
    const access = await resolveAccess(d.store, key.orgId);
    const siteId = req.params.id;
    const a = siteAccess(access, siteId);
    const to = parseDate(req.query.get('to'), new Date());
    const from = parseDate(req.query.get('from'), new Date(to.getTime() - 30 * 86_400_000));
    if (from >= to) throw new HttpError(400, 'invalid_range', 'from must be before to');
    if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new HttpError(400, 'range_too_large', 'Maximum range is 366 days');

    let zone: string | null = null;
    let stack: string | null = null;
    const lot = req.query.get('lot');
    const stackParam = req.query.get('stack') ?? req.query.get('zone');
    if (lot) {
      const found = await d.store.findStackByRef([siteId], lot);
      if (!found) throw new HttpError(404, 'lot_not_found', `No stack on this site has reference ${lot}`);
      ({ zone, stack } = found);
    } else if (stackParam) {
      const [z, st] = stackParam.split('/');
      zone = z || null;
      stack = st || null;
    }

    const c = clampQuery(a, from, to);
    const bucket = to.getTime() - from.getTime() > 92 * 86_400_000 ? '1d' : '1h';
    const rows = c
      ? ((await d.store.queryReadings({ siteIds: [siteId], metrics: c.metrics, from: c.from, to: c.to, interval: bucket, limit: 200_000 })) as any[])
      : [];
    const alerts = await d.store.listAlertsBetween(siteId, from, to);
    let crop = null;
    if (zone && stack) {
      const zc = (await d.store.getZoneCrops(siteId)).get(zone)?.find((x) => x.stack === stack);
      if (zc) crop = { crop: zc.crop.crop, safeMoisture: zc.crop.safeMoisture };
    }
    const [site] = await d.store.getSites([siteId]);
    return {
      body: {
        site: { id: site.id, name: site.name, externalRef: site.externalRef },
        ...buildConditionReport(rows, alerts, { from: c?.from ?? from, to: c?.to ?? to, bucket, zone, stack, crop }),
        access: describeAccess(a),
      },
    };
  });

  r.get('/v1/devices', async (req) => {
    const key = await apiKey(req);
    const access = await resolveAccess(d.store, key.orgId);
    const site = req.query.get('site');
    const ids = site ? [siteAccess(access, site) && site] : [...access.keys()];
    return { body: { devices: (await d.store.listDevices(ids)).map(publicDevice) } };
  });

  r.get('/v1/devices/:id', async (req) => {
    const key = await apiKey(req);
    const dev = await d.store.getDevice(req.params.id);
    const access = await resolveAccess(d.store, key.orgId);
    if (!dev || !dev.siteId || !access.has(dev.siteId)) throw new HttpError(404, 'device_not_found');
    return { body: { device: publicDevice(dev) } };
  });

  r.get('/v1/latest', async (req) => {
    const key = await apiKey(req, 'read:readings');
    const access = await resolveAccess(d.store, key.orgId);
    const site = req.query.get('site');
    const siteIds = site ? (siteAccess(access, site), [site]) : [...access.keys()];
    const now = new Date();
    const rows = (await d.store.latestReadings(siteIds)).filter((row) => {
      const a = access.get(row.siteId!)!;
      return (!a.metrics || a.metrics.has(row.metric)) && (!a.to || row.time <= a.to) && (!a.from || row.time >= a.from) && row.time <= now;
    });
    return { body: { readings: rows.map(publicReading) } };
  });

  r.get('/v1/readings', async (req) => {
    const key = await apiKey(req, 'read:readings');
    const access = await resolveAccess(d.store, key.orgId);
    const q = req.query;
    const interval = q.get('interval') ?? 'raw';
    if (!INTERVALS.has(interval)) throw new HttpError(400, 'invalid_interval', 'interval must be raw, 1m, 1h or 1d');
    const to = parseDate(q.get('to'), new Date());
    const from = parseDate(q.get('from'), new Date(to.getTime() - 24 * 3600_000));
    if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new HttpError(400, 'range_too_large', 'Maximum range is 366 days');
    const limit = Math.min(Number(q.get('limit') ?? 10_000) || 10_000, 50_000);
    const metrics = q.get('metric')?.split(',').filter(Boolean);
    let siteIds: string[];
    const site = q.get('site');
    const deviceId = q.get('device') ?? undefined;
    if (site) siteIds = [site];
    else if (deviceId) {
      const dev = await d.store.getDevice(deviceId);
      siteIds = dev?.siteId ? [dev.siteId] : [];
    } else siteIds = [...access.keys()];

    const out: unknown[] = [];
    for (const sid of siteIds) {
      const a = access.get(sid);
      if (!a) { if (site || deviceId) throw new HttpError(404, 'site_not_found'); continue; }
      const c = clampQuery(a, from, to, metrics);
      if (!c) continue;
      const rows = await d.store.queryReadings({
        siteIds: [sid], deviceId, metrics: c.metrics, channel: q.get('channel') ?? undefined, from: c.from, to: c.to,
        interval: interval as 'raw', limit: limit - out.length,
      });
      out.push(...rows.map((x) => ('quality' in x ? publicReading(x) : { ...x, time: x.time.toISOString() })));
      if (out.length >= limit) break;
    }
    return { body: { interval, from: from.toISOString(), to: to.toISOString(), count: out.length, readings: out } };
  });

  r.get('/v1/readings/proof', async (req) => {
    const key = await apiKey(req, 'read:readings');
    const deviceId = req.query.get('device') ?? '';
    const seq = Number(req.query.get('seq'));
    const dev = await d.store.getDevice(deviceId);
    const access = await resolveAccess(d.store, key.orgId);
    if (!dev?.siteId || !access.has(dev.siteId) || !Number.isInteger(seq)) throw new HttpError(404, 'not_found');
    if (!access.get(dev.siteId)!.owned && access.get(dev.siteId)!.metrics) throw new HttpError(403, 'forbidden', 'Proofs require full-metric access to the site');
    const msg = await d.store.getMessage(deviceId, seq);
    if (!msg) throw new HttpError(404, 'not_found');
    const k = await d.store.getDeviceKey(deviceId, msg.keyId);
    const body = b64urlDecode(msg.payloadB64);
    const sig = b64urlDecode(msg.sigB64);
    const valid = !!k && (k.alg === 'ed25519' ? verifyEd25519(k.publicKey, body, sig) : verifyHmacSha256(k.publicKey, body, sig));
    return {
      body: {
        deviceId, seq, kind: msg.kind, receivedAt: msg.receivedAt, keyId: msg.keyId, alg: k?.alg ?? null,
        publicKey: k?.alg === 'ed25519' ? k.publicKey : null,
        payload: msg.payloadB64, signature: msg.sigB64, body: JSON.parse(body.toString('utf8')), signatureValid: valid,
        howToVerify: 'Ed25519-verify base64url-decoded `payload` bytes with base64url-decoded `signature` and the raw 32-byte `publicKey`.',
      },
    };
  });

  r.get('/v1/alerts', async (req) => {
    const key = await apiKey(req, 'read:alerts');
    const access = await resolveAccess(d.store, key.orgId);
    const site = req.query.get('site');
    const siteIds = site ? (siteAccess(access, site), [site]) : [...access.keys()];
    const status = req.query.get('status');
    if (status && !['open', 'acknowledged', 'resolved'].includes(status)) throw new HttpError(400, 'invalid_status');
    const alerts = await d.store.listAlerts(siteIds, status, Math.min(Number(req.query.get('limit') ?? 200) || 200, 1000));
    return { body: { alerts } };
  });

  // Webhooks
  r.get('/v1/webhooks', async (req) => {
    const key = await apiKey(req, 'manage:webhooks');
    return { body: { webhooks: (await d.store.listOrgWebhooks(key.orgId)).map(({ secret: _s, ...w }) => w) } };
  });
  r.post('/v1/webhooks', async (req) => {
    const key = await apiKey(req, 'manage:webhooks');
    const { url, events } = req.body ?? {};
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new HttpError(400, 'invalid_url', 'Webhook URL must be https');
    const allowed = ['alert.opened', 'alert.resolved', 'alert.*', 'device.online', 'device.offline', 'device.*', 'reading.created', 'event.created'];
    if (!Array.isArray(events) || !events.length || events.some((e) => !allowed.includes(e))) throw new HttpError(400, 'invalid_events', `events must be from: ${allowed.join(', ')}`);
    const secret = `whsec_${randomToken(24)}`;
    const w = await d.store.createWebhook(key.orgId, url, events, secret);
    await d.store.audit(`apikey:${key.id}`, key.orgId, 'webhook.created', w.id, { url, events });
    return { status: 201, body: { webhook: { ...w } } }; // secret shown once
  });
  r.delete('/v1/webhooks/:id', async (req) => {
    const key = await apiKey(req, 'manage:webhooks');
    if (!(await d.store.deleteWebhook(req.params.id, key.orgId))) throw new HttpError(404, 'not_found');
    return { status: 204 };
  });

  // Grants (owner side)
  r.get('/v1/grants', async (req) => {
    const key = await apiKey(req, 'manage:grants');
    return { body: { given: await d.store.listActiveGrantsFrom(key.orgId), received: await d.store.listActiveGrantsFor(key.orgId) } };
  });
  r.post('/v1/grants', async (req) => {
    const key = await apiKey(req, 'manage:grants');
    const b = req.body ?? {};
    if (typeof b.granteeOrgId !== 'string') throw new HttpError(400, 'invalid_request', 'granteeOrgId is required');
    const own = new Set((await d.store.listSitesForOrg(key.orgId)).map((s) => s.id));
    if (b.siteIds && (!Array.isArray(b.siteIds) || b.siteIds.some((s: string) => !own.has(s)))) throw new HttpError(400, 'invalid_sites', 'You can only share your own sites');
    const g = await d.store.createGrant({
      ownerOrgId: key.orgId, granteeOrgId: b.granteeOrgId, siteIds: b.siteIds ?? null, metrics: b.metrics ?? null,
      validFrom: b.validFrom ? parseDate(b.validFrom, new Date()) : null, validTo: b.validTo ? parseDate(b.validTo, new Date()) : null, live: b.live !== false,
    });
    await d.store.audit(`apikey:${key.id}`, key.orgId, 'grant.created', g.id, b);
    return { status: 201, body: { grant: g } };
  });
  r.delete('/v1/grants/:id', async (req) => {
    const key = await apiKey(req, 'manage:grants');
    if (!(await d.store.revokeGrant(req.params.id, key.orgId))) throw new HttpError(404, 'not_found');
    await d.store.audit(`apikey:${key.id}`, key.orgId, 'grant.revoked', req.params.id);
    return { status: 204 };
  });

  // ---------- Device control (owner organisation only) ----------
  if (d.actuators) {
    const act = d.actuators;
    const ownDevice = async (key: ApiKey, id: string) => {
      const dev = await d.store.getDevice(id);
      if (!dev || dev.orgId !== key.orgId) throw new HttpError(404, 'device_not_found');
      return dev;
    };
    r.get('/v1/devices/:id/commands', async (req) => {
      const key = await apiKey(req, 'control:devices');
      await ownDevice(key, req.params.id);
      return { body: { available: await act.catalogue(req.params.id), history: await act.history(req.params.id) } };
    });
    r.post('/v1/devices/:id/commands', async (req) => {
      const key = await apiKey(req, 'control:devices');
      await ownDevice(key, req.params.id);
      try {
        const out = await act.send(req.params.id, String(req.body?.command ?? ''), req.body?.args ?? {}, { source: 'api', actor: `apikey:${key.id}`, orgId: key.orgId });
        await d.store.audit(`apikey:${key.id}`, key.orgId, 'device.command', req.params.id, out);
        return { status: 202, body: { command: { ...out, status: 'sent' } } };
      } catch (e) {
        if (e instanceof CommandError) throw new HttpError(e.code === 'not_allowed' ? 403 : 400, e.code, e.message);
        throw e;
      }
    });
  }

  // ---------- Carbon (owners and organisations with access to a project site) ----------
  if (d.carbon) {
    const carbon = d.carbon;
    const wrap = async <T>(fn: () => Promise<T>) => {
      try { return await fn(); } catch (e) { if (e instanceof CarbonError) throw new HttpError(e.status, e.code, e.message); throw e; }
    };
    const visibleProject = async (key: ApiKey, id: string, write = false) => {
      const p = await wrap(() => carbon.getProject(id));
      if (p.org_id === key.orgId) return p;
      if (write) throw new HttpError(403, 'forbidden', 'Only the project owner can change it');
      const access = await resolveAccess(d.store, key.orgId);
      if (!(p.site_ids ?? []).some((s: string) => access.has(s))) throw new HttpError(404, 'not_found');
      return p;
    };
    r.get('/v1/carbon/projects', async (req) => {
      const key = await apiKey(req, 'read:carbon');
      const access = await resolveAccess(d.store, key.orgId);
      const projects = await carbon.listProjects(key.orgId, [...access.keys()]);
      return { body: { projects: await Promise.all(projects.map(async (p: any) => ({ ...p, summary: await carbon.summary(p.id) }))) } };
    });
    r.get('/v1/carbon/projects/:id', async (req) => {
      const key = await apiKey(req, 'read:carbon');
      const p = await visibleProject(key, req.params.id);
      return { body: { project: p, summary: await carbon.summary(p.id), activities: await carbon.listActivities(p.id) } };
    });
    r.get('/v1/carbon/activities/:id', async (req) => {
      const key = await apiKey(req, 'read:carbon');
      const out = await wrap(() => carbon.getActivity(req.params.id));
      await visibleProject(key, out.activity.project_id);
      return { body: out };
    });
    r.post('/v1/carbon/projects/:id/activities', async (req) => {
      const key = await apiKey(req, 'write:carbon');
      const p = await visibleProject(key, req.params.id, true);
      const b = req.body ?? {};
      const a = await wrap(() => carbon.openActivity({
        projectId: p.id, siteId: b.siteId ?? null, deviceId: b.deviceId ?? null, reference: b.reference ?? null,
        startedAt: b.startedAt ? parseDate(b.startedAt, new Date()) : undefined, endedAt: b.endedAt ? parseDate(b.endedAt, new Date()) : null, by: `apikey:${key.id}`,
      }));
      return { status: 201, body: { activity: a } };
    });
    const ownActivity = async (key: ApiKey, id: string) => {
      const out = await wrap(() => carbon.getActivity(id));
      await visibleProject(key, out.activity.project_id, true);
      return out.activity;
    };
    r.post('/v1/carbon/activities/:id/close', async (req) => {
      const key = await apiKey(req, 'write:carbon');
      await ownActivity(key, req.params.id);
      return { body: { activity: await wrap(() => carbon.closeActivity(req.params.id, req.body?.endedAt ? parseDate(req.body.endedAt, new Date()) : new Date())) } };
    });
    r.post('/v1/carbon/activities/:id/measurements', async (req) => {
      const key = await apiKey(req, 'write:carbon');
      await ownActivity(key, req.params.id);
      const b = req.body ?? {};
      const m = await wrap(() => carbon.addMeasurement({
        activityId: req.params.id, kind: String(b.kind ?? ''), value: Number(b.value), sampledAt: b.sampledAt ? parseDate(b.sampledAt, new Date()) : null,
        documentRef: b.documentRef ?? null, documentSha256: b.documentSha256 ?? null, note: b.note ?? null, supersedesId: b.supersedesId ?? null, by: `apikey:${key.id}`,
      }));
      return { status: 201, body: { measurement: m } };
    });
    r.post('/v1/carbon/activities/:id/calculate', async (req) => {
      const key = await apiKey(req, 'write:carbon');
      await ownActivity(key, req.params.id);
      return { body: { activity: await wrap(() => carbon.calculate(req.params.id)) } };
    });
  }

  return r;
}

function describeAccess(a: SiteAccess) {
  return { owned: a.owned, metrics: a.metrics ? [...a.metrics] : 'all', from: a.from?.toISOString() ?? null, to: a.to?.toISOString() ?? null };
}

function publicDevice(x: Device) {
  return {
    id: x.id, siteId: x.siteId, type: x.typeId, connectivity: x.connectivity, status: x.status,
    lastSeenAt: x.lastSeenAt?.toISOString() ?? null, configVersion: x.configVersion, configAcked: x.configAckedVersion >= x.configVersion,
  };
}

function publicReading(x: { time: Date; deviceId: string; siteId: string | null; channel: string; metric: string; value: number; quality: string; flags: number; seq: number | null; cal: string | null }) {
  return {
    time: x.time.toISOString(), siteId: x.siteId, deviceId: x.deviceId, channel: x.channel, metric: x.metric, value: x.value, quality: x.quality,
    buffered: (x.flags & 1) !== 0, timeEstimated: (x.flags & 2) !== 0, derived: (x.flags & 4) !== 0,
    integrity: (x.flags & 4) !== 0 ? 'derived' : (x.flags & 8) !== 0 ? 'shared-secret' : 'device-signed',
    seq: x.seq, cal: x.cal,
  };
}

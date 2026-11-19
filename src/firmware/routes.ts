import { mount, num, optStr, str, uuid, type Actor, type ActorResolvers, type RouteDef } from '../http/actors.js';
import { HttpError, type Req, type Router } from '../http/router.js';
import type { Device } from '../store/types.js';
import { FirmwareError, MAX_FIRMWARE_BYTES, type FirmwareService } from './firmware.js';

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof FirmwareError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
};

export function registerFirmware(r: Router, fw: FirmwareService, auth: ActorResolvers, deviceAuth: (req: Req) => Promise<Device>) {
  const defs: RouteDef[] = [
    {
      method: 'GET', path: '/firmware', scope: 'manage:firmware',
      handler: async (_req, a) => ({ body: { releases: await fw.listReleases(a.orgId), rollouts: await fw.listRollouts(a.orgId), publicKey: fw.publicKey } }),
    },
    {
      // Body: the raw .bin file. Query: type, version, notes.
      method: 'POST', path: '/firmware', scope: 'manage:firmware', privileged: true, maxBody: MAX_FIRMWARE_BYTES,
      handler: async (req, a) => {
        const release = await wrap(() => fw.createRelease({
          orgId: a.orgId, typeId: str(req.query.get('type'), 'type', 64), version: str(req.query.get('version'), 'version', 32),
          notes: optStr(req.query.get('notes'), 1000), binary: req.rawBody, by: a.actor,
        }));
        return { status: 201, body: { release } };
      },
    },
    {
      method: 'POST', path: '/firmware/:id/retire', scope: 'manage:firmware', privileged: true,
      handler: async (req, a) => { await wrap(() => fw.retire(uuid(req.params.id, 'id'), a.orgId)); return { body: { ok: true } }; },
    },
    {
      method: 'POST', path: '/firmware/:id/rollouts', scope: 'manage:firmware', privileged: true,
      handler: async (req, a) => {
        const b = req.body ?? {};
        const deviceIds = Array.isArray(b.deviceIds) ? b.deviceIds.map(String) : typeof b.deviceIds === 'string' && b.deviceIds.trim() ? b.deviceIds.split(/[\s,]+/).filter(Boolean) : null;
        const out = await wrap(() => fw.startRollout({
          releaseId: uuid(req.params.id, 'id'), scopeOrgId: a.orgId, targetOrgId: a.orgId === null ? optStr(b.orgId, 36) : null,
          siteId: optStr(b.siteId, 36), deviceIds, batchSize: num(b.batchSize, 'batchSize', { min: 1, max: 1000, optional: true }) ?? 10, by: a.actor,
        }));
        return { status: 201, body: out };
      },
    },
    {
      method: 'GET', path: '/firmware/rollouts/:id', scope: 'manage:firmware',
      handler: async (req, a) => ({ body: await wrap(() => fw.rolloutDevices(uuid(req.params.id, 'id'), a.orgId)) }),
    },
    ...(['pause', 'resume', 'cancel'] as const).map((act): RouteDef => ({
      method: 'POST', path: `/firmware/rollouts/:id/${act}`, scope: 'manage:firmware', privileged: true,
      handler: async (req, a: Actor) => {
        await wrap(() => fw.setRolloutStatus(uuid(req.params.id, 'id'), a.orgId, act === 'pause' ? 'paused' : act === 'resume' ? 'active' : 'cancelled'));
        return { body: { ok: true } };
      },
    })),
  ];
  mount(r, defs, auth);

  // Public key that firmware embeds to check update signatures.
  r.get('/api/firmware/public-key', () => ({ body: { alg: 'ed25519', publicKey: fw.publicKey, signs: 'sha256 digest of the firmware binary' } }));

  // Device download (HTTPS, device token).
  r.get('/api/device/firmware/:id', async (req) => {
    const device = await deviceAuth(req);
    const bin = await fw.binaryFor(device, req.params.id);
    if (!bin) throw new HttpError(404, 'not_found');
    return {
      body: bin.data,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Titan-Sha256': bin.sha256, 'X-Titan-Version': bin.version, 'Cache-Control': 'no-store' },
    };
  });
}

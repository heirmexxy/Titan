import type { DeviceService } from '../ingest/devices.js';
import type { Device, Store } from '../store/types.js';
import { HttpError, type Req } from './router.js';

/** HTTPS device authentication: `Authorization: Device <deviceId>:<token>` (Device Protocol v1 §12). */
export function createDeviceAuth(devices: DeviceService, store: Store) {
  return async (req: Req): Promise<Device> => {
    const m = /^Device ([A-Za-z0-9_-]+):(.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !(await devices.authenticate(m[1], m[2], m[1]))) throw new HttpError(401, 'unauthorized');
    return (await store.getDevice(m[1]))!;
  };
}

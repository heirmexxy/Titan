import type { Device } from '../store/types.js';

export interface DeviceConfigDoc {
  v: 1;
  cfg: number;
  interval: { telemetry_s: number; moisture_s: number; heartbeat_s: number };
  thresholds: Record<string, { min?: number; max?: number }>;
  alarm_enable: boolean;
  cal: Record<string, string>;
  time: number;
}

const FALLBACK = {
  wifi: { telemetry_s: 10, moisture_s: 60, heartbeat_s: 60 },
  gsm: { telemetry_s: 60, moisture_s: 300, heartbeat_s: 300 },
};

/**
 * Builds the full config document for a device:
 * device-type defaults for its connectivity (set by admin) → per-device override.
 */
export function buildDeviceConfig(device: Device, version: number, now = new Date()): DeviceConfigDoc {
  const typeDefaults = (device.typeDefaults as any)?.[device.connectivity] ?? {};
  const o = device.configOverride as any;
  const interval = { ...FALLBACK[device.connectivity], ...typeDefaults, ...(o?.interval ?? {}) };
  for (const k of Object.keys(interval)) {
    const n = Number(interval[k]);
    if (!Number.isInteger(n) || n < 1 || n > 86_400) throw new Error(`Invalid interval ${k}=${interval[k]}`);
    interval[k] = n;
  }
  return {
    v: 1,
    cfg: version,
    interval,
    thresholds: o?.thresholds ?? {},
    alarm_enable: o?.alarm_enable ?? true,
    cal: o?.cal ?? {},
    time: Math.floor(now.getTime() / 1000),
  };
}

export const configTopic = (deviceId: string) => `titan/v1/${deviceId}/down/config`;
export const commandTopic = (deviceId: string) => `titan/v1/${deviceId}/down/cmd`;

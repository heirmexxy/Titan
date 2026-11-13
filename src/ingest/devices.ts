import { randomUUID } from 'node:crypto';
import { b64urlDecode, randomToken, safeEqual, sha256Hex } from '../core/crypto.js';
import { buildDeviceConfig, commandTopic, configTopic } from '../core/device-config.js';
import type { Store } from '../store/types.js';

export interface Broker {
  publish(topic: string, payload: string, opts: { qos: 0 | 1; retain: boolean }): Promise<void>;
}

/** Publishes downlinks through the EMQX REST API. */
export class EmqxBroker implements Broker {
  constructor(private apiUrl: string, private key: string, private secret: string) {}
  async publish(topic: string, payload: string, opts: { qos: 0 | 1; retain: boolean }) {
    const res = await fetch(`${this.apiUrl}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${this.key}:${this.secret}`).toString('base64'),
      },
      body: JSON.stringify({ topic, payload, qos: opts.qos, retain: opts.retain, payload_encoding: 'plain' }),
    });
    if (!res.ok) throw new Error(`EMQX publish failed: ${res.status} ${await res.text()}`);
  }
}

export class DeviceService {
  constructor(private store: Store, private broker: Broker) {}

  /** EMQX HTTP authentication: username = device ID, password = device token. */
  async authenticate(username: string, password: string, clientId: string): Promise<boolean> {
    if (!username || !password || clientId !== username) return false;
    const d = await this.store.getDevice(username);
    if (!d || d.status === 'disabled' || !d.tokenHash) return false;
    return safeEqual(d.tokenHash, sha256Hex(password));
  }

  /**
   * EMQX HTTP authorisation: a device may only use its own topic tree. A LoRa gateway may also
   * publish uplinks and subscribe to downlinks for the nodes assigned to it.
   */
  async authorize(username: string, topic: string, action: 'publish' | 'subscribe' | string): Promise<boolean> {
    const m = /^titan\/v1\/([A-Za-z0-9_-]{3,64})\/(.+)$/.exec(topic);
    if (!m) return false;
    const [, target, rest] = m;
    if (target !== username) {
      const node = await this.store.getDevice(target);
      if (!node || node.gatewayId !== username) return false;
      if (action === 'publish' && rest === 'up/lwt') return false; // a gateway can't speak for a node's connection
    }
    if (action === 'publish') return /^up\/(telemetry|event|state|ack|lwt)$/.test(rest);
    if (action === 'subscribe') return rest === 'down/#' || rest === 'down/config' || rest === 'down/cmd';
    return false;
  }

  /** True if `username` may submit uplinks for `deviceId` (itself, or as its gateway). */
  async maySubmitFor(username: string, deviceId: string): Promise<boolean> {
    if (username === deviceId) return true;
    const node = await this.store.getDevice(deviceId);
    return !!node && node.gatewayId === username;
  }

  /** Issues a one-time provisioning code (valid 7 days). Returns the plain code to hand to the installer. */
  async issueProvisionCode(deviceId: string): Promise<string> {
    const code = randomToken(9);
    await this.store.setProvisionCode(deviceId, sha256Hex(code), new Date(Date.now() + 7 * 86_400_000));
    return code;
  }

  /** Device calls this on first boot with its freshly generated Ed25519 public key. */
  async provision(deviceId: string, code: string, publicKeyB64url: string): Promise<{ token: string; keyId: string } | { error: string }> {
    const d = await this.store.getDevice(deviceId);
    if (!d || !d.provisionCodeHash || !d.provisionExpiresAt) return { error: 'not_provisionable' };
    if (d.provisionExpiresAt < new Date()) return { error: 'code_expired' };
    if (!safeEqual(d.provisionCodeHash, sha256Hex(code))) return { error: 'bad_code' };
    if (b64urlDecode(publicKeyB64url).length !== 32) return { error: 'bad_public_key' };
    const keyId = `k${(await this.store.countDeviceKeys(deviceId)) + 1}`;
    await this.store.addDeviceKey(deviceId, { keyId, alg: 'ed25519', publicKey: publicKeyB64url });
    const token = randomToken(32);
    await this.store.completeProvisioning(deviceId, sha256Hex(token));
    await this.store.audit('system', d.orgId, 'device.provisioned', deviceId, { keyId });
    // Deliver the current config as soon as the device subscribes (retained).
    await this.pushConfig(deviceId, null).catch((e) => console.error(JSON.stringify({ level: 'warn', msg: 'config push after provisioning failed', err: String(e) })));
    return { token, keyId };
  }

  /** Rebuilds and publishes the device's full config (retained). Config shows pending until the device acks. */
  async pushConfig(deviceId: string, by: string | null) {
    const d = await this.store.getDevice(deviceId);
    if (!d) throw new Error(`Unknown device ${deviceId}`);
    const version = d.configVersion + 1;
    const doc = buildDeviceConfig(d, version);
    await this.store.saveConfig(deviceId, version, doc as unknown as Record<string, unknown>, by);
    await this.broker.publish(configTopic(deviceId), JSON.stringify(doc), { qos: 1, retain: true });
    return doc;
  }

  async sendCommand(deviceId: string, cmd: 'alarm_ack' | 'reboot' | 'time_sync' | 'send_state', args: Record<string, unknown> = {}) {
    const id = `c_${randomUUID().slice(0, 8)}`;
    if (cmd === 'time_sync') args = { ...args, time: Math.floor(Date.now() / 1000) };
    await this.broker.publish(commandTopic(deviceId), JSON.stringify({ v: 1, id, cmd, args }), { qos: 1, retain: false });
    return id;
  }
}

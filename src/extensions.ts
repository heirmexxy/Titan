/**
 * Wires the v1.2 modules (firmware OTA, self-serve sign-up, PAYG, verifiers and registries, exports,
 * GradeGuard quality and traceability, the field app API and health monitoring) into the app.
 */
import { join } from 'node:path';
import type { ActuatorService } from './actuators/service.js';
import type { OpsAgent } from './agent/ops-agent.js';
import { Paystack } from './billing/paystack.js';
import { registerExports } from './export/routes.js';
import { FirmwareService } from './firmware/firmware.js';
import { registerFirmware } from './firmware/routes.js';
import type { ApiKeyAuth } from './http/apikey.js';
import type { Actor, ActorResolvers } from './http/actors.js';
import { createDeviceAuth } from './http/deviceauth.js';
import type { Req, Router } from './http/router.js';
import type { DeviceService } from './ingest/devices.js';
import type { IngestPipeline, Notifier } from './ingest/pipeline.js';
import { registerFieldApp } from './fieldapp/routes.js';
import { Health, registerHealth } from './monitor/health.js';
import type { EmailSender, SmsSender } from './notify/providers.js';
import { PaygService } from './payg/payg.js';
import { registerPayg } from './payg/routes.js';
import { QualityService } from './quality/quality.js';
import { registerQuality } from './quality/routes.js';
import { registerSignup, runBillingCycle } from './signup/signup.js';
import type { Store } from './store/types.js';
import { RegistryService } from './verify/registry.js';
import { registerVerification } from './verify/routes.js';
import type { ExtraJob } from './workers/workers.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export interface ExtensionDeps {
  app: Router;
  pool: Pool;
  store: Store;
  pipeline: IngestPipeline;
  devices: DeviceService;
  actuators: ActuatorService | null;
  notifier: Notifier | null;
  email: EmailSender;
  sms: SmsSender | null;
  apiKey: ApiKeyAuth;
  adminSession: (req: Req, role?: 'admin') => Promise<{ userId: string; email: string; role: string }>;
  consoleWho: (req: Req, owner?: boolean) => Promise<{ userId: string; email: string; orgId: string; role: string; support: unknown }>;
  agent: OpsAgent | null;
  paystackSecret: string;
  paystackHooks: ((ev: any) => Promise<void>)[];
  publicUrl: string;
  secureCookies: boolean;
  dataDir: string;
  backupDir: string;
  emqx: { apiUrl: string; key: string; secret: string };
  mqtt: { host: string; port: number };
}

export function registerExtensions(d: ExtensionDeps) {
  const auth: ActorResolvers = {
    admin: async (req, privileged): Promise<Actor> => {
      const s = await d.adminSession(req, privileged ? 'admin' : undefined);
      return { orgId: null, actor: `user:${s.userId}`, kind: 'kitovu', email: s.email };
    },
    console: async (req, privileged): Promise<Actor> => {
      const w = await d.consoleWho(req, privileged);
      return { orgId: w.orgId, actor: `${w.support ? 'support' : 'user'}:${w.userId}`, kind: w.role === 'client_owner' ? 'owner' : 'member', email: w.email };
    },
    api: async (req, scope): Promise<Actor> => {
      const k = await d.apiKey(req, scope);
      return { orgId: k.orgId, actor: `apikey:${k.id}`, kind: 'apikey' };
    },
  };
  const paystack = d.paystackSecret ? new Paystack(d.paystackSecret) : null;

  const firmware = new FirmwareService(d.pool, d.actuators, join(d.dataDir, 'firmware'), d.publicUrl);
  const payg = new PaygService(d.pool, d.actuators, d.notifier, d.sms);
  const quality = new QualityService(d.pool);
  d.pipeline.addHook(firmware);
  d.pipeline.addHook(quality);
  d.pipeline.addHook({ onReadings: (dev, rows) => payg.onReadings(dev, rows) });

  registerFirmware(d.app, firmware, auth, createDeviceAuth(d.devices, d.store));
  registerPayg(d.app, payg, auth, { paystack, publicUrl: d.publicUrl, paystackHooks: d.paystackHooks });
  registerQuality(d.app, quality, auth);
  registerExports(d.app, d.pool, auth);
  registerSignup(d.app, { pool: d.pool, email: d.email, paystack, publicUrl: d.publicUrl, secureCookies: d.secureCookies, who: d.consoleWho, paystackHooks: d.paystackHooks });
  const registry = new RegistryService(d.pool, async (id) => {
    if (!d.agent) throw new Error('verifier packs need the operations agent');
    return d.agent.verifierPack(id);
  }, d.publicUrl);
  registerVerification(d.app, registry, { auth, apiKey: d.apiKey, email: d.email, publicUrl: d.publicUrl, secureCookies: d.secureCookies });
  registerFieldApp(d.app, { pool: d.pool, adminSession: d.adminSession, consoleWho: d.consoleWho, devices: d.devices, secureCookies: d.secureCookies });

  const host = (u: string) => { try { return new URL(u).hostname; } catch { return 'localhost'; } };
  const health = new Health({ pool: d.pool, emqx: d.emqx, mqttHost: d.mqtt.host, mqttPort: d.mqtt.port, publicHost: host(d.publicUrl), backupDir: d.backupDir, dataDir: d.dataDir });
  registerHealth(d.app, health, (req) => d.adminSession(req));

  const jobs: ExtraJob[] = [
    { name: 'heartbeat', everyMs: 30_000, run: () => health.beat('workers', { pid: process.pid, uptimeS: Math.round(process.uptime()) }) },
    { name: 'firmware rollouts', everyMs: 30_000, run: () => firmware.tick() },
    { name: 'payg', everyMs: 60_000, run: () => payg.tick() },
    { name: 'billing cycle', everyMs: 3_600_000, run: () => runBillingCycle(d.pool, paystack, d.email, d.publicUrl) },
  ];
  return { firmware, payg, quality, registry, health, jobs, webhookEvents: ['payg.payment', 'payg.locked', 'payg.unlocked', 'payg.paid_off', 'payg.*'] };
}

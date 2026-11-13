import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { registerAdmin } from './admin/routes.js';
import { ActuatorService } from './actuators/service.js';
import { CarbonService } from './carbon/service.js';
import { Billing } from './billing/billing.js';
import { createApp } from './http/app.js';
import { DeviceService, EmqxBroker } from './ingest/devices.js';
import { IngestPipeline } from './ingest/pipeline.js';
import { Dispatcher } from './notify/dispatcher.js';
import { ResendEmail, TermiiSms } from './notify/providers.js';
import { PostgresStore } from './store/postgres.js';
import { startWorkers } from './workers/workers.js';

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, here.includes('/dist/') ? '../../web' : '../web');

const store = PostgresStore.fromUrl(config.databaseUrl);
const email = new ResendEmail();
const dispatcher = new Dispatcher(store, email, new TermiiSms(), config.publicUrl);
const broker = new EmqxBroker(config.emqx.apiUrl, config.emqx.apiKey, config.emqx.apiSecret);
const actuators = new ActuatorService(store.pool, broker);
const carbon = new CarbonService(store.pool);
const pipeline = new IngestPipeline(store, dispatcher, [actuators, carbon]);
const devices = new DeviceService(store, broker);
const billing = config.paystack.secretKey ? new Billing(store.pool, config.paystack.secretKey) : null;

const app = createApp({
  store, pipeline, devices, email, billing,
  internalSecret: config.internalSecret,
  publicUrl: config.publicUrl,
  demoInbox: config.resend.demoInbox,
  mqtt: config.mqtt,
  staticDir,
  actuators,
  carbon,
});

registerAdmin(app, { pool: store.pool, devices, actuators, carbon, secureCookies: config.publicUrl.startsWith('https') });

const server = createServer(app.handler());
server.keepAliveTimeout = 65_000; // longer than Nginx's upstream keepalive
server.listen(config.port, '127.0.0.1', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'titan listening', port: config.port, staticDir }));
});
const stopWorkers = startWorkers({ store, pipeline, dispatcher, billing, sweepSeconds: config.offlineSweepSeconds, pool: store.pool });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopWorkers();
    server.close(() => store.pool.end().then(() => process.exit(0)));
  });
}

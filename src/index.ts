import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { registerAdmin } from './admin/routes.js';
import { ActuatorService } from './actuators/service.js';
import { CarbonService } from './carbon/service.js';
import { registerMcp } from './mcp/server.js';
import { registerConsole } from './console/routes.js';
import { OpsAgent } from './agent/ops-agent.js';
import { registerAgentAdmin, registerAgentConsole } from './agent/routes.js';
import { Writer } from './agent/writer.js';
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

const admin = registerAdmin(app, { pool: store.pool, devices, actuators, carbon, secureCookies: config.publicUrl.startsWith('https') });
const consoleApi = registerConsole(app, { pool: store.pool, store, devices, actuators, carbon, billing, publicUrl: config.publicUrl, secureCookies: config.publicUrl.startsWith('https') });
const agent = new OpsAgent(store.pool, new Writer(), email, config.publicUrl);
registerAgentAdmin(app, { pool: store.pool, agent, session: admin.session });
registerAgentConsole(app, { pool: store.pool, who: consoleApi.who });
registerMcp(app, { store, selfBaseUrl: () => `http://127.0.0.1:${config.port}` });

const handler = app.handler();
const servers = config.hosts.map((host) => {
  const s = createServer(handler);
  s.keepAliveTimeout = 65_000; // longer than the proxy's upstream keepalive
  s.listen(config.port, host, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'titan listening', host, port: config.port, staticDir }));
  });
  return s;
});
const stopWorkers = startWorkers({ store, pipeline, dispatcher, billing, sweepSeconds: config.offlineSweepSeconds, pool: store.pool, agent });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopWorkers();
    let open = servers.length;
    for (const s of servers) s.close(() => { if (--open === 0) store.pool.end().then(() => process.exit(0)); });
  });
}

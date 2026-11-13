/**
 * MCP server for AI agents (Model Context Protocol, Streamable HTTP transport, JSON responses).
 * Endpoint: POST /mcp with `Authorization: Bearer tk_live_…`.
 * Every tool forwards to the REST API with the caller's own key, so agents get exactly the
 * permissions, data grants, rate limits and audit trail of that key, nothing more.
 */
import { sha256Hex } from '../core/crypto.js';
import { HttpError, type Req, type Router } from '../http/router.js';
import type { Store } from '../store/types.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT = 100_000;

interface Tool {
  name: string;
  title: string;
  description: string;
  scope?: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  call: (args: any) => { method: 'GET' | 'POST'; path: string; body?: unknown };
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const s = (description: string) => ({ type: 'string', description });
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  const t = p.toString();
  return t ? `?${t}` : '';
};
const enc = encodeURIComponent;

export const TOOLS: Tool[] = [
  {
    name: 'list_sites', title: 'List sites', readOnly: true,
    description: 'Sites (warehouses, farms, kilns, etc.) this key can see, with what access it has to each. Optionally find a site by its external ID (e.g. a StorageX warehouse ID).',
    inputSchema: obj({ ref: s('External ID to look up, optional') }),
    call: (a) => ({ method: 'GET', path: `/v1/sites${qs({ ref: a.ref })}` }),
  },
  {
    name: 'get_site', title: 'Site and its devices', readOnly: true,
    description: 'One site and the devices installed there, with their status.',
    inputSchema: obj({ siteId: s('Site ID') }, ['siteId']),
    call: (a) => ({ method: 'GET', path: `/v1/sites/${enc(a.siteId)}` }),
  },
  {
    name: 'latest_readings', title: 'Latest readings', scope: 'read:readings', readOnly: true,
    description: 'Current value of every reading on every channel at a site (last 7 days).',
    inputSchema: obj({ siteId: s('Site ID') }, ['siteId']),
    call: (a) => ({ method: 'GET', path: `/v1/latest${qs({ site: a.siteId })}` }),
  },
  {
    name: 'query_readings', title: 'Reading history', scope: 'read:readings', readOnly: true,
    description: 'Readings over time for a site or device. Use interval 1h or 1d for long periods; raw returns individual signed readings. Times are ISO 8601.',
    inputSchema: obj({
      siteId: s('Site ID'), deviceId: s('Device ID'),
      metrics: { type: 'array', items: { type: 'string' }, description: 'Metric keys, e.g. ["air.humidity","produce.moisture"]; see list_metrics' },
      channel: s('One channel, e.g. z1/stack-a/mst1'), from: s('Start, ISO 8601; default 24 h ago'), to: s('End, ISO 8601; default now'),
      interval: { type: 'string', enum: ['raw', '1m', '1h', '1d'], description: 'Default 1h' },
      limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Default 2000' },
    }),
    call: (a) => ({ method: 'GET', path: `/v1/readings${qs({ site: a.siteId, device: a.deviceId, metric: a.metrics, channel: a.channel, from: a.from, to: a.to, interval: a.interval ?? '1h', limit: Math.min(Number(a.limit ?? 2000), 5000) })}` }),
  },
  {
    name: 'condition_report', title: 'Storage condition report', scope: 'read:readings', readOnly: true,
    description: 'Min/max/average of each reading, alerts, data completeness and crop safe-moisture check for a site, zone or stack over a period, e.g. a warehouse receipt\'s storage period.',
    inputSchema: obj({ siteId: s('Site ID'), lot: s('Lot/stack external ID, optional'), stack: s('Zone/stack code, e.g. z1/stack-a, optional'), from: s('ISO 8601, default 30 days ago'), to: s('ISO 8601, default now') }, ['siteId']),
    call: (a) => ({ method: 'GET', path: `/v1/sites/${enc(a.siteId)}/conditions${qs({ lot: a.lot, stack: a.stack, from: a.from, to: a.to })}` }),
  },
  {
    name: 'list_alerts', title: 'Alerts', scope: 'read:alerts', readOnly: true,
    description: 'Alerts on visible sites: threshold breaches, offline devices, tamper, intruders, sensor faults.',
    inputSchema: obj({ siteId: s('Site ID, optional'), status: { type: 'string', enum: ['open', 'acknowledged', 'resolved'] } }),
    call: (a) => ({ method: 'GET', path: `/v1/alerts${qs({ site: a.siteId, status: a.status, limit: 200 })}` }),
  },
  {
    name: 'list_devices', title: 'Devices', readOnly: true,
    description: 'Devices on visible sites with status (online, offline, awaiting setup, disabled) and last contact.',
    inputSchema: obj({ siteId: s('Site ID, optional') }),
    call: (a) => ({ method: 'GET', path: `/v1/devices${qs({ site: a.siteId })}` }),
  },
  {
    name: 'list_metrics', title: 'Metric registry', readOnly: true,
    description: 'All metric keys with units, labels and valid ranges.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/v1/metrics' }),
  },
  {
    name: 'device_commands', title: 'Device commands and log', scope: 'control:devices', readOnly: true,
    description: 'Commands a device accepts (with argument types) and its recent command log.',
    inputSchema: obj({ deviceId: s('Device ID') }, ['deviceId']),
    call: (a) => ({ method: 'GET', path: `/v1/devices/${enc(a.deviceId)}/commands` }),
  },
  {
    name: 'send_command', title: 'Send a device command', scope: 'control:devices', readOnly: false,
    description: 'Sends a command to one of your own devices (e.g. relay.set, paygo.unlock). It changes physical equipment: confirm intent with the user first. Only commands the device type allows for API keys are accepted; every command is logged.',
    inputSchema: obj({ deviceId: s('Device ID'), command: s('Command name from device_commands'), args: { type: 'object', description: 'Arguments, e.g. {"channel":"fan1","on":true}' } }, ['deviceId', 'command']),
    call: (a) => ({ method: 'POST', path: `/v1/devices/${enc(a.deviceId)}/commands`, body: { command: a.command, args: a.args ?? {} } }),
  },
  {
    name: 'carbon_projects', title: 'Carbon projects', scope: 'read:carbon', readOnly: true,
    description: 'Carbon projects (biochar, cookstoves) this key can see, with totals.',
    inputSchema: obj({}),
    call: () => ({ method: 'GET', path: '/v1/carbon/projects' }),
  },
  {
    name: 'carbon_project', title: 'Carbon project detail', scope: 'read:carbon', readOnly: true,
    description: 'One carbon project: parameters, totals and its batches or periods.',
    inputSchema: obj({ projectId: s('Project ID') }, ['projectId']),
    call: (a) => ({ method: 'GET', path: `/v1/carbon/projects/${enc(a.projectId)}` }),
  },
  {
    name: 'carbon_activity', title: 'Carbon batch or period', scope: 'read:carbon', readOnly: true,
    description: 'One biochar batch or cookstove period: result, inputs with their sources, and lab measurements.',
    inputSchema: obj({ activityId: s('Activity ID') }, ['activityId']),
    call: (a) => ({ method: 'GET', path: `/v1/carbon/activities/${enc(a.activityId)}` }),
  },
];

const INSTRUCTIONS = `Titan holds signed IoT readings from warehouses, farms, kilns, cookstoves and energy systems.
Start with list_sites. Metric keys look like air.temperature or produce.moisture (see list_metrics); channels look like zone/stack/sensor.
Readings labelled buffered were sent late after an outage; timeEstimated means the device clock was unset.
send_command changes physical equipment: ask the user to confirm before calling it.`;

export function registerMcp(r: Router, d: { store: Store; selfBaseUrl: () => string; serverName?: string; version?: string }) {
  const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function handle(msg: any, auth: string, scopes: string[]): Promise<unknown | null> {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request');
    const isNotification = msg.id === undefined || msg.id === null;
    const ok = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
    const visible = TOOLS.filter((t) => !t.scope || scopes.includes(t.scope));

    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: d.serverName ?? 'titan', title: 'Titan by Kitovu', version: d.version ?? '1.0.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: visible.map((t) => ({
            name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
            annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, openWorldHint: false },
          })),
        });
      case 'tools/call': {
        const tool = visible.find((t) => t.name === msg.params?.name);
        if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
        const args = msg.params?.arguments ?? {};
        const missing = ((tool.inputSchema.required as string[]) ?? []).filter((k) => args[k] === undefined || args[k] === '');
        if (missing.length) return ok({ content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }], isError: true });
        const { method, path, body } = tool.call(args);
        const res = await fetch(d.selfBaseUrl() + path, {
          method,
          headers: { Authorization: auth, 'X-Titan-Via': 'mcp', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        let text = await res.text();
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `\n…[truncated at ${MAX_TEXT} characters; narrow the query or use a coarser interval]`;
        return ok({ content: [{ type: 'text', text }], isError: !res.ok });
      }
      default:
        return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  r.post('/mcp', async (req: Req) => {
    const auth = req.headers.authorization ?? '';
    const m = /^Bearer (tk_(live|test)_[A-Za-z0-9_-]{20,})$/.exec(auth);
    const key = m ? await d.store.getApiKeyByHash(sha256Hex(m[1])) : null;
    if (!key || key.revokedAt) {
      return { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="titan"' }, body: rpcError(null, -32001, 'Send Authorization: Bearer <Titan API key>') };
    }
    const payload = req.body;
    if (payload === undefined) throw new HttpError(400, 'invalid_json', 'Send a JSON-RPC message with Content-Type: application/json');
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map((p) => handle(p, auth, key.scopes)))).filter((x) => x !== null);
      return out.length ? { body: out } : { status: 202 };
    }
    const out = await handle(payload, auth, key.scopes);
    return out === null ? { status: 202 } : { body: out };
  });

  r.get('/mcp', () => ({ status: 405, headers: { Allow: 'POST' }, body: { error: 'method_not_allowed', message: 'This server answers POST requests with JSON; it does not open event streams.' } }));
}

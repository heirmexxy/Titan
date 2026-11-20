import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  rawBody: Buffer;
  body: any;
  ip: string;
  /** True only for direct calls from this machine (EMQX hooks), never for requests through the web proxy. */
  local: boolean;
}

export interface Res {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

type Handler = (req: Req) => Promise<Res> | Res;
interface Route { method: string; parts: string[]; handler: Handler; maxBody: number }

const MAX_BODY = 1_000_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.md': 'text/markdown; charset=utf-8',
};

export class Router {
  private routes: Route[] = [];
  constructor(private staticDir?: string) {}

  on(method: string, path: string, handler: Handler, opts: { maxBody?: number } = {}) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler, maxBody: opts.maxBody ?? MAX_BODY });
    return this;
  }
  get(p: string, h: Handler) { return this.on('GET', p, h); }
  post(p: string, h: Handler, opts?: { maxBody?: number }) { return this.on('POST', p, h, opts); }
  delete(p: string, h: Handler) { return this.on('DELETE', p, h); }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = route.parts[i];
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(parts[i]);
        else if (rp !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  handler() {
    return async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      try {
        const found = this.match(method, url.pathname);
        if (!found) {
          if (method === 'GET' && this.staticDir && this.serveStatic(url.pathname, res)) return;
          throw new HttpError(404, 'not_found');
        }
        const rawBody = await readBody(req, found.route.maxBody);
        let body: any = undefined;
        if (rawBody.length && (req.headers['content-type'] ?? '').includes('json')) {
          try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json'); }
        }
        const out = await found.route.handler({
          method, path: url.pathname, params: found.params, query: url.searchParams, headers: req.headers, rawBody, body,
          ip: clientIp(req), local: isLocal(req),
        });
        send(res, out.status ?? 200, out.body, out.headers);
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
        console.error(JSON.stringify({ level: 'error', msg: 'unhandled', path: url.pathname, err: String((e as Error)?.stack ?? e) }));
        send(res, 500, { error: 'internal_error' });
      }
    };
  }

  private serveStatic(pathname: string, res: ServerResponse): boolean {
    const root = resolve(this.staticDir!);
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { return false; }
    if (decoded.includes('\0')) return false;
    let file = normalize(join(root, decoded));
    // Must stay inside the folder: "/web" must not match a sibling such as "/web-private".
    if (file !== root && !file.startsWith(root + sep)) return false;
    try {
      let st = statSync(file);
      if (st.isDirectory()) { file = join(file, 'index.html'); st = statSync(file); }
      res.writeHead(200, {
        ...securityHeaders(extname(file) === '.html'),
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': st.size,
        'Cache-Control': /\.(html|webmanifest)$|sw\.js$/.test(file) ? 'no-cache' : 'public, max-age=300',
      });
      createReadStream(file).pipe(res);
      return true;
    } catch {
      return false;
    }
  }
}

function readBody(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveP(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- Client address and proxy trust ----------
// Titan sits behind a reverse proxy (Traefik or Nginx) on this machine or the Docker bridge. Only then is
// X-Forwarded-For trusted, and only its last entry (the address the proxy itself saw); earlier entries are
// whatever the client claimed.
const isLoopback = (a: string) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const isProxyHop = (a: string) => isLoopback(a) || /^(::ffff:)?172\.(1[6-9]|2\d|3[01])\./.test(a) || /^(::ffff:)?10\./.test(a) || /^(::ffff:)?192\.168\./.test(a);
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff && isProxyHop(remote)) {
    const hops = xff.split(',').map((x) => x.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return remote;
}
function isLocal(req: IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];
}

// ---------- Security headers ----------
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob: https:", "media-src 'self'", "connect-src 'self'",
  "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
  "form-action 'self' https://checkout.paystack.com",
].join('; ');
export function securityHeaders(html: boolean): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=(), payment=()',
    ...(html ? { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' } : {}),
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  const html = /text\/html/.test(headers['Content-Type'] ?? '');
  const base = { ...securityHeaders(html), 'Cache-Control': 'no-store' };
  if (body === undefined || body === null) { res.writeHead(status, { ...base, ...headers }); res.end(); return; }
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { ...base, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), ...headers });
    res.end(body);
    return;
  }
  const isText = typeof body === 'string';
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(status, { ...base, 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(payload);
}

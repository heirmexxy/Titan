import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  rawBody: Buffer;
  body: any;
  ip: string;
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
          ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ?? req.socket.remoteAddress ?? '',
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
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root)) return false;
    try {
      let st = statSync(file);
      if (st.isDirectory()) { file = join(file, 'index.html'); st = statSync(file); }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': /\.(html|webmanifest)$|sw\.js$/.test(file) ? 'no-cache' : 'public, max-age=300' });
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

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  if (body === undefined || body === null) { res.writeHead(status, headers); res.end(); return; }
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), ...headers });
    res.end(body);
    return;
  }
  const isText = typeof body === 'string';
  const payload = isText ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(payload);
}

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const N = 16384;

/** Password hash format: scrypt$<N>$<salt b64url>$<hash b64url> */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('Password must be at least 10 characters');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, n, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const got = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(expected, got);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = 'titan_session';
export const SESSION_DAYS = 7;

export const CONSOLE_COOKIE = 'titan_console';

export function sessionCookie(token: string, secure: boolean, name = SESSION_COOKIE): string {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}
export function clearCookie(secure: boolean, name = SESSION_COOKIE): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

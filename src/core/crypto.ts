import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function b64urlEncode(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

export function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// DER prefix for an Ed25519 SubjectPublicKeyInfo; followed by the 32-byte raw key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519PublicKeyFromRaw(rawB64url: string) {
  const raw = b64urlDecode(rawB64url);
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function verifyEd25519(rawPublicKeyB64url: string, message: Buffer, signature: Buffer): boolean {
  try {
    return verify(null, message, ed25519PublicKeyFromRaw(rawPublicKeyB64url), signature);
  } catch {
    return false;
  }
}

export function verifyHmacSha256(secret: string, message: Buffer, signature: Buffer): boolean {
  const expected = createHmac('sha256', secret).update(message).digest();
  return expected.length === signature.length && timingSafeEqual(expected, signature);
}

/** Signature header for outgoing webhooks: t=<unix>,v1=<hex hmac(secret, t + "." + body)>. */
export function webhookSignature(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

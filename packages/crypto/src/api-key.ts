/**
 * Per-tenant API keys (layer-6 task H; SCL-09). A key is
 * `cgk_<prefix>_<secret>`: twelve lower-case letters and digits that find
 * the row, then 32 random bytes in base64url. Only the SHA-256 of the whole
 * key is stored; with 256 random bits nothing slower is needed. The key is
 * shown once, to the administrator who asked for it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEY = /^cgk_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

export interface NewApiKey {
  /** The whole key: shown once, never stored or logged. */
  key: string;
  prefix: string;
  hash: string;
}

export function newApiKey(): NewApiKey {
  const bytes = randomBytes(12);
  const prefix = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  const key = `cgk_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: apiKeyHash(key) };
}

export function apiKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The prefix of a well-formed key, or null. */
export function apiKeyPrefix(key: string): string | null {
  return KEY.exec(key)?.[1] ?? null;
}

/** Does the presented key match the stored hash? Constant time. */
export function apiKeyMatches(key: string, storedHash: string): boolean {
  const a = Buffer.from(apiKeyHash(key), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

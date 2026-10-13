/**
 * Resident tokens (SEC-09, RES-01, RULE-17): issued only after a reference
 * code and a one-time code sent to the contact on file both check out. They
 * name exactly one report and expire quickly; they carry no personal data.
 * HMAC-SHA256 over a compact JSON payload with a server-side secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ResidentClaims {
  tenantId: string;
  reportId: string;
  exp: number;
}

const enc = (b: Buffer) => b.toString('base64url');

export function signResidentToken(secret: string, claims: ResidentClaims): string {
  const body = enc(Buffer.from(JSON.stringify(claims)));
  const mac = enc(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyResidentToken(
  secret: string,
  token: string,
  now = Date.now(),
): ResidentClaims | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ResidentClaims;
    if (
      typeof claims.tenantId !== 'string' ||
      typeof claims.reportId !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp * 1000 <= now
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}

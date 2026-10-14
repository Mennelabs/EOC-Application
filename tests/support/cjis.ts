/**
 * CJIS enclave helpers for the stack and browser suites (layer 5). The
 * enclave has its own origin, identity provider and accounts; the exercise
 * accounts sign in through the development test client with the password
 * and a one-time code (the browser flow uses a passkey instead). Keycloak
 * refuses a code twice, so a second sign-in in the same 30-second window
 * waits for the next code. Synthetic accounts only (SCL-12).
 */
import { createHmac } from 'node:crypto';

export const CJIS_URL = process.env['CJIS_URL'] ?? 'https://localhost:8443';
export const CJIS_PASSWORD = 'Westwind-Exercise-2026!';
/** Mirrors services/cjis-api/src/provision/exercise.ts (development only). */
export const CJIS_OTP_SECRET = 'WESTWIND-EXERCISE-OTP-DEV-ONLY';
export const CJIS_TEST_CLIENT = { id: 'cjis-tests', secret: 'cjis-tests-dev-secret' } as const;

export const CJIS = {
  officer: 'deputy.reyes@sheriff.example.org',
  supervisor: 'sgt.hollis@sheriff.example.org',
  records: 'records.lane@sheriff.example.org',
  admin: 'tac.admin@sheriff.example.org',
  security: 'laso@sheriff.example.org',
  auditor: 'auditor@sheriff.example.org',
  lapsed: 'deputy.lapsed@sheriff.example.org',
  pending: 'deputy.pending@sheriff.example.org',
  lockoutDrill: 'lockout.drill@sheriff.example.org',
  cityOfficer: 'officer.vance@police.example.org',
  cityAdmin: 'admin@police.example.org',
  citySecurity: 'laso@police.example.org',
} as const;

export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', Buffer.from(secret)).update(counter).digest();
  const o = (h[h.length - 1] ?? 0) & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export interface GrantResult {
  status: number;
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

export async function enclaveGrant(
  username: string,
  extra: Record<string, string> = {},
): Promise<GrantResult> {
  const res = await fetch(`${CJIS_URL}/auth/realms/cjis/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: CJIS_TEST_CLIENT.id,
      client_secret: CJIS_TEST_CLIENT.secret,
      username,
      password: CJIS_PASSWORD,
      ...extra,
    }),
  });
  return { status: res.status, ...((await res.json()) as Omit<GrantResult, 'status'>) };
}

const cache = new Map<string, { token: string; refresh: string; exp: number }>();
const lastCode = new Map<string, string>();

export function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

/** An enclave access token with the second factor, cached and refreshed per account. */
export async function enclaveToken(username: string): Promise<string> {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // the enclave gateway's local CA (development only)
  const hit = cache.get(username);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  if (hit) {
    const res = await fetch(`${CJIS_URL}/auth/realms/cjis/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CJIS_TEST_CLIENT.id,
        client_secret: CJIS_TEST_CLIENT.secret,
        refresh_token: hit.refresh,
      }),
    });
    if (res.ok) return remember(username, (await res.json()) as GrantResult);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    let code = totp(CJIS_OTP_SECRET);
    if (lastCode.get(username) === code) {
      await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 250));
      code = totp(CJIS_OTP_SECRET);
    }
    lastCode.set(username, code);
    const t = await enclaveGrant(username, { totp: code });
    if (t.access_token) return remember(username, t);
    // Another suite may have used this code already: wait for the next one.
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 250));
  }
  throw new Error(`no enclave token for ${username}`);
}

function remember(username: string, t: GrantResult): string {
  if (!t.access_token || !t.refresh_token) throw new Error('enclave token response incomplete');
  const exp = Number(claims(t.access_token)['exp'] ?? 0) * 1000;
  cache.set(username, { token: t.access_token, refresh: t.refresh_token, exp });
  return t.access_token;
}

export interface EnclaveCall {
  method?: string;
  body?: unknown;
  version?: number;
  confirm?: string;
  key?: string;
}

/** Calls the enclave API with a bearer token; returns status and parsed body. */
export async function enclaveApi(token: string, path: string, init: EnclaveCall = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'idempotency-key': init.key ?? crypto.randomUUID(),
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.version !== undefined) headers['if-match'] = `"${init.version}"`;
  if (init.confirm) {
    headers['x-confirm'] = 'true';
    headers['x-reason'] = init.confirm;
  }
  const res = await fetch(`${CJIS_URL}/api/v1${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as Record<string, unknown> & unknown[] };
}

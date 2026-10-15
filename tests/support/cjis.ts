/**
 * CJIS enclave helpers for the stack and browser suites (layer 5). The
 * enclave has its own origin, identity provider and accounts; the exercise
 * accounts sign in through the development test client with the password
 * and a one-time code (the browser flow uses a passkey instead). Keycloak
 * refuses a code twice for an account, and each refusal counts toward the
 * account's lockout, so test processes (Playwright workers, vitest pools)
 * share, under a lock file, which code each account last used and the tokens
 * they obtained: a process reuses or refreshes a token another one got, and
 * only asks for a new one with a code nobody has used. Synthetic accounts
 * only (SCL-12).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

interface Held {
  token: string;
  refresh: string;
  exp: number;
}

const cache = new Map<string, Held>();

/*
 * Shared between test processes (Playwright workers, vitest pools): which code
 * each account used last, and the tokens obtained, so a process that finds a
 * fresh token reuses it instead of needing a code of its own. One code per
 * account per 30 seconds otherwise starves a worker that keeps losing the race
 * for the next code. Synthetic accounts of the development realm only; the
 * file is readable by its owner only.
 */
const OTP_LOCK = join(tmpdir(), 'cg-enclave-otp.lock');
const OTP_STATE = join(tmpdir(), 'cg-enclave-otp-state.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const untilNextCode = () => sleep(30_000 - (Date.now() % 30_000) + 250);

/** One process at a time reads and writes the shared state; a lock older than a minute is a dead process's. */
async function withOtpLock<T>(fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      mkdirSync(OTP_LOCK);
      break;
    } catch {
      try {
        if (Date.now() - statSync(OTP_LOCK).mtimeMs > 60_000)
          rmSync(OTP_LOCK, { recursive: true, force: true });
      } catch {
        // Released meanwhile.
      }
      await sleep(50 + Math.random() * 100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(OTP_LOCK, { recursive: true, force: true });
  }
}

interface SharedState {
  used: Record<string, string>;
  tokens: Record<string, Held>;
}

function readState(): SharedState {
  try {
    const s = JSON.parse(readFileSync(OTP_STATE, 'utf8')) as Partial<SharedState>;
    return { used: s.used ?? {}, tokens: s.tokens ?? {} };
  } catch {
    return { used: {}, tokens: {} };
  }
}

function writeState(state: SharedState): void {
  writeFileSync(OTP_STATE, JSON.stringify(state), { mode: 0o600 });
}

export function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function held(t: GrantResult): Held | null {
  if (!t.access_token || !t.refresh_token) return null;
  return {
    token: t.access_token,
    refresh: t.refresh_token,
    exp: Number(claims(t.access_token)['exp'] ?? 0) * 1000,
  };
}

async function refreshGrant(refresh: string): Promise<GrantResult | null> {
  const res = await fetch(`${CJIS_URL}/auth/realms/cjis/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CJIS_TEST_CLIENT.id,
      client_secret: CJIS_TEST_CLIENT.secret,
      refresh_token: refresh,
    }),
  });
  return res.ok
    ? { ...((await res.json()) as Omit<GrantResult, 'status'>), status: res.status }
    : null;
}

type Step = { token: Held } | { wait: true } | { failed: GrantResult };

let realmKeys: Promise<Set<string>> | null = null;
/** The key ids the enclave realm signs with now (once per process). */
function currentKeyIds(): Promise<Set<string>> {
  realmKeys ??= fetch(`${CJIS_URL}/auth/realms/cjis/protocol/openid-connect/certs`)
    .then((r) => r.json() as Promise<{ keys?: { kid?: string }[] }>)
    .then((j) => new Set((j.keys ?? []).flatMap((k) => (k.kid ? [k.kid] : []))))
    .catch(() => new Set<string>());
  return realmKeys;
}

/**
 * A token left by a run against a stack since recreated (`docker compose
 * down -v`) is unexpired but signed by a key the new realm never had; the
 * enclave refuses it. Unknown when the key set could not be read.
 */
function signedByCurrentKey(token: string, keys: Set<string>): boolean {
  if (keys.size === 0) return true;
  const header = JSON.parse(
    Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
  ) as { kid?: unknown };
  return typeof header.kid === 'string' && keys.has(header.kid);
}

/**
 * Under the lock: a token another process left that is still fresh, else a
 * refresh of it, else a grant with a code this account has not used yet.
 */
function nextStep(username: string): Promise<Step> {
  return withOtpLock(async () => {
    const state = readState();
    const keys = await currentKeyIds();
    let shared = state.tokens[username];
    if (shared && !signedByCurrentKey(shared.token, keys)) {
      delete state.tokens[username];
      writeState(state);
      shared = undefined;
    }
    if (shared && shared.exp > Date.now() + 30_000) return { token: shared };
    if (shared) {
      const refreshed = await refreshGrant(shared.refresh);
      const h = refreshed && held(refreshed);
      if (h) {
        state.tokens[username] = h;
        writeState(state);
        return { token: h };
      }
    }
    const code = totp(CJIS_OTP_SECRET);
    if (state.used[username] === code) return { wait: true };
    state.used[username] = code;
    writeState(state);
    const granted = await enclaveGrant(username, { totp: code });
    const h = held(granted);
    if (!h) return { failed: granted };
    state.tokens[username] = h;
    writeState(state);
    return { token: h };
  });
}

/** An enclave access token with the second factor, shared and refreshed per account. */
export async function enclaveToken(username: string): Promise<string> {
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // the enclave gateway's local CA (development only)
  const hit = cache.get(username);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  let last: GrantResult | undefined;
  for (let failures = 0; failures < 3;) {
    const step = await nextStep(username);
    if ('token' in step) {
      cache.set(username, step.token);
      return step.token.token;
    }
    if ('failed' in step) {
      last = step.failed;
      failures++;
    }
    await untilNextCode();
  }
  throw new Error(
    `no enclave token for ${username}: ${last?.error ?? last?.status} ${last?.error_description ?? ''}`,
  );
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

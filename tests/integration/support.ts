/**
 * Shared helpers for the stack suites: the compose database as an observer,
 * tokens through the development test client, the staff and public APIs,
 * Mailpit, and a web submission that waits for the worker to file it.
 * Everything here is synthetic (SCL-12).
 */
import { execFileSync } from 'node:child_process';
import { expect } from 'vitest';

export const BASE = process.env['STACK_URL'] ?? 'https://localhost';
export const MAIL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // Caddy local CA in development only.

export const PASSWORD = 'Westwind-Exercise-2026!';
export const RUN = Date.now().toString(36);
/** The seeded county toll-free number (docs/06). */
export const COUNTY_NUMBER = '+13145550100';
export const CODE = /[A-HJKMNP-Z]{4}-[2-9]{4}/;

export function compose(...args: string[]): string {
  const files = (process.env['COMPOSE_FILES'] ?? 'compose.yaml')
    .split(',')
    .flatMap((f) => ['-f', f]);
  try {
    return execFileSync('docker', ['compose', ...files, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

/** Reads (or, where a test must move the clock, adjusts) the compose database as the superuser. */
export const sql = (text: string): string[] =>
  compose('exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'cg', '-Atc', text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export async function token(realm: string, user: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'cg-tests',
      client_secret: 'cg-tests-dev-secret',
      username: user,
      password: PASSWORD,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new Error(`token for ${user}@${realm}: ${body.error_description}`);
  return body.access_token;
}

export interface Call {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  confirm?: string;
  version?: number;
  idempotencyKey?: string;
}

export type Json = Record<string, unknown> & unknown[];

export async function call(url: string, tok: string | null, c: Call = {}) {
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  if (tok) headers['authorization'] = `Bearer ${tok}`;
  if (c.body !== undefined) headers['content-type'] = 'application/json';
  if (c.confirm) {
    headers['x-confirm'] = 'true';
    headers['x-reason'] = c.confirm;
  }
  if (c.version !== undefined) headers['if-match'] = `"${c.version}"`;
  if (c.idempotencyKey) headers['idempotency-key'] = c.idempotencyKey;
  const res = await fetch(url, {
    method: c.method ?? (c.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return {
    status: res.status,
    body: json as Json,
    text,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

export const api = (tok: string | null, path: string, c: Call = {}) =>
  call(`${BASE}/api/v1${path}`, tok, c);
export const pub = (path: string, c: Call = {}) => call(`${BASE}/api/public${path}`, null, c);

export async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The text of the first Mailpit message to `address` whose subject and body match. */
export async function mailFor(
  address: string,
  subjectPart: string,
  textPart?: string,
): Promise<string> {
  return waitFor(async () => {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
    const body = (await res.json()) as { messages: { ID: string; Subject: string }[] };
    for (const hit of body.messages) {
      if (!hit.Subject.toLowerCase().includes(subjectPart.toLowerCase())) continue;
      const msg = (await (await fetch(`${MAIL}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
      if (!textPart || msg.Text.includes(textPart)) return msg.Text;
    }
    return undefined;
  }, 90_000);
}

/** Plays a resident's phone against the simulator webhook; returns the replies. */
export async function text(from: string, body: string): Promise<string[]> {
  const res = await call(`${BASE}/api/webhooks/simulator/sms`, null, {
    body: { from, to: COUNTY_NUMBER, body },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body['replies'] as string[];
}

let graph: { key: string; version: number } | undefined;
export async function graphInfo() {
  if (!graph) {
    const res = await pub('/intake/county/westwind');
    expect(res.status).toBe(200);
    const g = res.body['graph'] as { key: string; version: number };
    graph = { key: g.key, version: g.version };
  }
  return graph;
}

export type Answer = { kind: 'value'; value: unknown } | { kind: 'unknown' } | { kind: 'skipped' };
export const v = (value: unknown): Answer => ({ kind: 'value', value });

let seq = 1000 + (Date.now() % 8000);
export const next = () => seq++;

/** A complete own-home report; `extra` overrides any answer. */
export function ownHome(n: number, extra: Record<string, Answer> = {}): Record<string, Answer> {
  return {
    danger_now: v('no'),
    relationship: v('own_home'),
    address: v({ line1: `${n} Acceptance Ave`, city: 'Westwind', postal: '63001' }),
    home_type: v('house'),
    cause: v('wind_tornado'),
    damage_types: v(['roof']),
    roof_state: v('large_hole'),
    habitable: v('no'),
    tonight: v('yes'),
    insurance: { kind: 'unknown' },
    contact_name: v(`Resident ${n}`),
    contact: v({ phone: `314555${String(n).padStart(4, '0').slice(-4)}`, preferred: 'text' }),
    ...extra,
  };
}

export async function submit(input: {
  relationship?: string;
  answers: Record<string, Answer>;
  needs?: string[];
  consent?: Record<string, boolean>;
  ownWords?: string;
  afterSubmission?: Record<string, Answer>;
  smsOptIn?: boolean;
}): Promise<{ executionId: string; code: string }> {
  const g = await graphInfo();
  const executionId = crypto.randomUUID();
  const res = await pub('/intake/county/westwind/submissions', {
    idempotencyKey: executionId,
    body: {
      executionId,
      channel: 'web',
      language: 'en',
      graphKey: g.key,
      graphVersion: g.version,
      relationship: input.relationship ?? 'own_home',
      answers: input.answers,
      needs: input.needs ?? [],
      consent: input.consent ?? {},
      ...(input.ownWords ? { ownWords: input.ownWords } : {}),
      ...(input.afterSubmission ? { afterSubmission: input.afterSubmission } : {}),
      ...(input.smsOptIn !== undefined ? { smsOptIn: input.smsOptIn } : {}),
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return { executionId, code: res.body['referenceCode'] as string };
}

/** The filed report id, once the worker has it (queue → worker → cg.report). */
export async function filed(staffToken: string, code: string, ms = 90_000): Promise<string> {
  return waitFor(async () => {
    const rows = await api(staffToken, `/reports?reference=${code}`);
    const row = (rows.body as { id: string }[])[0];
    return row?.id;
  }, ms);
}

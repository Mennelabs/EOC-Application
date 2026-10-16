import type { FastifyPluginAsync } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AccountSubject } from '@cg/authz';
import { buildApp } from '../src/app.ts';
import { ApiError } from '../src/errors.ts';
import type { SubjectLoader } from '../src/auth/subject.ts';
import { AuthError } from '../src/auth/subject.ts';

const base = {
  productName: 'Test Product',
  version: '0.0.0',
  dataMode: 'synthetic' as const,
  logLevel: 'silent',
  probes: [],
};

const alice: AccountSubject = {
  kind: 'account',
  accountId: '0190a11c-e000-4000-8000-000000000001',
  tenantId: '0190000a-0000-4000-8000-00000000000a',
  tenantPath: 'a',
  status: 'active',
  roles: [],
  resolvedAt: new Date(),
};

const subjects: SubjectLoader = {
  async fromBearer(token) {
    if (token === 'good') return alice;
    throw new AuthError('invalid_token');
  },
};

const STALE = '0190beef-0000-4000-8000-000000000099';
const things: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/things/:id', async (request, reply) => {
    if (request.params.id === STALE)
      throw new ApiError(409, 'version_conflict', 'This record changed since you loaded it.');
    if (request.params.id === 'replayed') reply.header('Idempotency-Replayed', 'true');
    return { ok: true };
  });
};

const counter = (text: string, line: string) => {
  const hit = text.split('\n').find((l) => l.startsWith(line + ' '));
  return hit ? Number(hit.slice(line.length + 1)) : 0;
};

describe('NFR-10: API metrics', () => {
  it('counts requests by route template, never the id, with latency, conflicts and replays', async () => {
    const app = await buildApp({ ...base, subjects, routes: [things] });
    const auth = { authorization: 'Bearer good' };
    const before = (await app.inject({ url: '/metrics' })).body;
    const id = '0190cafe-0000-4000-8000-000000000042';
    expect((await app.inject({ url: `/api/v1/things/${id}`, headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/things/${STALE}`, headers: auth })).statusCode).toBe(
      409,
    );
    await app.inject({ url: '/api/v1/things/replayed', headers: auth });
    await app.inject({ url: `/api/v1/things/${id}` }); // no token: 401
    await app.inject({ url: `/api/v1/nowhere/${id}`, headers: auth }); // 404

    const res = await app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = res.body;
    const ok = 'cg_http_requests_total{method="GET",route="/api/v1/things/:id",status="2xx"}';
    expect(counter(text, ok) - counter(before, ok)).toBe(2);
    const conflict = 'cg_http_requests_total{method="GET",route="/api/v1/things/:id",status="4xx"}';
    expect(counter(text, conflict) - counter(before, conflict)).toBe(2); // 409 and 401
    const vc = 'cg_api_errors_total{code="version_conflict"}';
    expect(counter(text, vc) - counter(before, vc)).toBe(1);
    const replay = 'cg_idempotent_replays_total{route="/api/v1/things/:id"}';
    expect(counter(text, replay) - counter(before, replay)).toBe(1);
    expect(text).toContain('route="unmatched"');
    expect(text).toContain(
      'cg_http_request_duration_seconds_count{method="GET",route="/api/v1/things/:id"}',
    );
    // No id, token or path a caller typed reaches a label.
    expect(text).not.toContain(id);
    expect(text).not.toContain(STALE);
    expect(text).not.toContain('nowhere');
    expect(text).not.toContain('Bearer');
    // The metrics endpoint does not count itself.
    expect(text).not.toContain('route="/metrics"');
    await app.close();
  });

  it('is not under /api, so the gateway (which routes /api/*) never serves it', async () => {
    const app = await buildApp({ ...base, subjects });
    expect((await app.inject({ url: '/api/metrics' })).statusCode).not.toBe(200);
    expect((await app.inject({ url: '/api/v1/metrics' })).statusCode).not.toBe(200);
    await app.close();
  });
});

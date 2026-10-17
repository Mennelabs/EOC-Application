import { describe, expect, it } from 'vitest';
import type { AccountSubject } from '@cg/authz';
import { buildApp } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';

const base = {
  productName: 'Test Product',
  version: '0.0.0',
  dataMode: 'synthetic' as const,
  logLevel: 'silent',
};

const alice: AccountSubject = {
  kind: 'account',
  accountId: '0190a11c-e000-4000-8000-000000000001',
  tenantId: '0190000a-0000-4000-8000-00000000000a',
  tenantPath: 'a',
  status: 'active',
  roles: [
    {
      roleId: 'r',
      key: 'tenant_admin',
      version: 1,
      templateKey: 'tenant_admin',
      grants: [{ action: '*' }],
      scope: {},
    },
  ],
  resolvedAt: new Date(),
};

const fakeSubjects = (subject: AccountSubject | null): SubjectLoader => ({
  async fromBearer(token) {
    if (token === 'good' && subject) return subject;
    throw new AuthError('invalid_token');
  },
});

describe('api health and metadata', () => {
  it('liveness does not depend on dependencies', async () => {
    const app = await buildApp({
      ...base,
      probes: [{ name: 'db', check: () => Promise.reject(new Error('down')) }],
    });
    const res = await app.inject({ url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('readiness returns 503 and names the failed dependency', async () => {
    const app = await buildApp({
      ...base,
      probes: [
        { name: 'db', check: async () => undefined },
        { name: 'queue', check: () => Promise.reject(new Error('down')) },
      ],
    });
    const res = await app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual([
      expect.objectContaining({ name: 'db', ok: true }),
      expect.objectContaining({ name: 'queue', ok: false }),
    ]);
  });

  it('ADM-03: product name comes from configuration', async () => {
    const app = await buildApp({ ...base, productName: 'Renamed Product', probes: [] });
    const res = await app.inject({ url: '/api/meta' });
    expect(res.json().productName).toBe('Renamed Product');
    const docs = await app.inject({ url: '/api/docs/json' });
    expect(docs.json().info.title).toBe('Renamed Product API');
  });
});

// These tests mount every route module (the whole API), and the first import of them all takes
// seconds on a busy runner: the default 5 s is too tight while the rest of the suite runs alongside.
describe('request context and authorization chain', { timeout: 30_000 }, () => {
  it('a bad bearer token is 401 with a generic code', async () => {
    const app = await buildApp({ ...base, probes: [], subjects: fakeSubjects(alice) });
    const res = await app.inject({ url: '/api/meta', headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('invalid_token');
  });

  it('a route is denied to the public and allowed to a granted account (G2, default deny)', async () => {
    const { routes } = await import('../src/routes/index.ts');
    const app = await buildApp({ ...base, probes: [], subjects: fakeSubjects(alice), routes });
    const anon = await app.inject({ url: '/api/v1/me' });
    expect(anon.statusCode).toBe(401);
    const ok = await app.inject({ url: '/api/v1/me', headers: { authorization: 'Bearer good' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      accountId: alice.accountId,
      roles: [{ key: 'tenant_admin' }],
      timeZone: 'UTC',
    });
    // BRD:FR-00.08: the tenant's approved zone rides on the account; the console shows times in it.
    const zoned = await buildApp({
      ...base,
      probes: [],
      subjects: fakeSubjects({ ...alice, tenantTimeZone: 'America/Chicago' }),
      routes,
    });
    const me = await zoned.inject({ url: '/api/v1/me', headers: { authorization: 'Bearer good' } });
    expect(me.json()).toMatchObject({ timeZone: 'America/Chicago' });
  });

  it('an inactive account is denied on its next action (AC-01A) without details', async () => {
    const { routes } = await import('../src/routes/index.ts');
    const app = await buildApp({
      ...base,
      probes: [],
      subjects: fakeSubjects({ ...alice, status: 'deactivated' }),
      routes,
    });
    const res = await app.inject({ url: '/api/v1/me', headers: { authorization: 'Bearer good' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
    expect(res.body).not.toContain('deactivated');
  });

  it('idempotent routes demand an Idempotency-Key (BRD:FR-00.06)', async () => {
    const app = await buildApp({ ...base, probes: [], subjects: fakeSubjects(alice) });
    app.post('/api/v1/things', { config: { idempotent: true } }, async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/things',
      headers: { authorization: 'Bearer good' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('idempotency_key_required');
  });

  it('versioned routes demand If-Match (BRD:FR-00.05)', async () => {
    const app = await buildApp({ ...base, probes: [], subjects: fakeSubjects(alice) });
    app.patch('/api/v1/things/1', { config: { requiresVersion: true } }, async () => ({
      ok: true,
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/things/1',
      headers: { authorization: 'Bearer good' },
      payload: {},
    });
    expect(res.statusCode).toBe(428);
    expect(res.json().code).toBe('version_required');
  });
});

/**
 * Single sign-on through the county's identity provider, against the
 * database (SEC-07, ADM-05, plan reading 49): an administrator proposes SAML
 * metadata or OIDC addresses with a reason; metadata with a document type
 * declaration, or without what a sign-in needs, is refused; one proposal
 * waits at a time; the one who proposed cannot approve it; a second
 * administrator's approval puts it in force and asks the worker to apply it;
 * a newer approval replaces it; switching off asks the worker again. The
 * OIDC client secret is stored encrypted and never returned, and neither it
 * nor the metadata reaches the audit. The worker applies the provider in
 * force (the secret decrypted only for Keycloak) and records when, or why
 * not; an account invited while single sign-on is on is asked for its
 * passkey only. Runs only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { SsoProviderSpec } from '../../worker/src/idp/keycloak.ts';
import { accountInvited } from '../../worker/src/jobs/handlers.ts';
import { ssoApply } from '../../worker/src/jobs/sso.ts';
import type { JobContext, OutboxMessage } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const CONFIRM = { 'x-confirm': 'true', 'x-reason': 'Exercise: county sign-in' };

/** Synthetic identity provider metadata (the certificate is a placeholder; Keycloak is faked here). */
const metadata = (entityId: string) => `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>MIIBexercise</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.westwind.example.gov/saml"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

interface Sso {
  id: string;
  version: number;
  protocol: string;
  status: string;
  idpEntityId: string | null;
  askedByYou: boolean;
  decidedBy: string | null;
  appliedAt: string | null;
  applyError: string | null;
  oidc: Record<string, string> | null;
}

describe.skipIf(!appUrl || !workerUrl)('single sign-on (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-sso-${run}`;
  const people: Record<string, string> = {};
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(dbWorker, { tenantId: county }, fn);

  /** The worker's view of Keycloak: what it was asked to do. */
  const idpCalls: { op: string; args: unknown[] }[] = [];
  let failNext: Error | null = null;
  const fakeIdp = {
    realmExists: async () => true,
    ensureSsoProvider: async (...args: unknown[]) => {
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      idpCalls.push({ op: 'ensure', args });
    },
    disableSsoProvider: async (...args: unknown[]) => {
      idpCalls.push({ op: 'disable', args });
    },
    ensureUser: async (...args: unknown[]) => {
      idpCalls.push({ op: 'user', args });
      return randomUUID();
    },
    sendInvitation: async (...args: unknown[]) => {
      idpCalls.push({ op: 'invite', args });
    },
  };
  const worker = (): JobContext =>
    ({
      db: dbWorker,
      crypto,
      idp: fakeIdp,
      urls: { gatewayPublic: 'https://localhost' },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    }) as unknown as JobContext;
  const message = (topic: string, payload: Record<string, unknown>): OutboxMessage =>
    ({
      id: randomUUID(),
      tenantId: county,
      topic,
      payload,
      executionId: null,
    }) as unknown as OutboxMessage;

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise sign-on county ${run}`,
        status: 'active',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await tx(async (trx) => {
      for (const [who, name] of [
        ['admin', 'Exercise Tenant Admin'],
        ['security', 'Exercise Security Admin'],
        ['director', 'Exercise EM Director'],
      ] as const)
        people[who] = (
          await trx
            .insertInto('cg.account')
            .values({
              tenant_id: county,
              email: `${who}-${run}@example.org`,
              display_name: name,
              status: 'active',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
    });
    const subject = (template: string, accountId: string): AccountSubject => {
      const r = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId,
        tenantId: county,
        tenantPath: c.path as string,
        tenantKind: c.kind,
        status: 'active',
        roles: [
          {
            roleId: randomUUID(),
            key: r.key,
            version: 1,
            templateKey: r.key,
            grants: r.grants,
            scope: {},
          },
        ],
        resolvedAt: new Date(),
      };
    };
    const subjects: Record<string, AccountSubject> = {
      admin: subject('tenant_admin', people['admin']!),
      security: subject('security_admin', people['security']!),
      director: subject('county_em_director', people['director']!),
    };
    const loader: SubjectLoader = {
      async fromBearer(token) {
        const s = subjects[token];
        if (!s) throw new AuthError('invalid_token');
        return s;
      },
    };
    app = await buildApp({
      productName: 'Test Product',
      version: '0.0.0',
      dataMode: 'synthetic',
      logLevel: 'silent',
      probes: [],
      db: dbApp,
      fieldCrypto: crypto,
      subjects: loader,
      routes: routesWith({ sso: { idpPublicBase: 'https://westwind.example.gov/auth' } }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', '=', slug)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const call = async <T>(
    who: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as T, text: res.body };
  };
  const decide = (who: string, s: { id: string; version: number }, op: string) =>
    call<Sso>(who, 'POST', `/sso/${s.id}/${op}`, undefined, {
      ...CONFIRM,
      'if-match': `"${s.version}"`,
    });
  const outbox = () =>
    tx((trx) =>
      trx
        .selectFrom('cg.outbox')
        .select(['topic', 'payload'])
        .where('tenant_id', '=', county)
        .where('topic', '=', 'sso.apply')
        .execute(),
    );

  it('SEC-07: what to give the identity provider, and nothing to non-administrators', async () => {
    const got = await call<{ serviceProvider: Record<string, string>; active: unknown }>(
      'admin',
      'GET',
      '/sso',
    );
    expect(got.status).toBe(200);
    expect(got.body.serviceProvider).toEqual({
      entityId: `https://westwind.example.gov/auth/realms/${slug}`,
      redirectUri: `https://westwind.example.gov/auth/realms/${slug}/broker/county-sso/endpoint`,
      metadataUrl: `https://westwind.example.gov/auth/realms/${slug}/broker/county-sso/endpoint/descriptor`,
    });
    expect(got.body.active).toBeNull();
    expect((await call('director', 'GET', '/sso')).status).toBe(403);
  });

  it('SEC-07: metadata is screened, a reason is required, and one proposal waits at a time', async () => {
    const saml = {
      protocol: 'saml',
      displayName: 'Westwind County account',
      metadata: metadata('https://idp.westwind.example.gov/saml'),
    };
    // No document type declarations or entities, ever.
    const hostile = await call(
      'admin',
      'POST',
      '/sso',
      {
        ...saml,
        metadata: `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${saml.metadata}`,
      },
      CONFIRM,
    );
    expect(hostile.status).toBe(400);
    expect(hostile.text).toContain('document type declaration');
    const notIdp = await call(
      'admin',
      'POST',
      '/sso',
      {
        ...saml,
        metadata: saml.metadata.replace(/IDPSSODescriptor/g, 'SPSSODescriptor'),
      },
      CONFIRM,
    );
    expect(notIdp.status).toBe(400);
    const plainHttp = await call(
      'admin',
      'POST',
      '/sso',
      {
        protocol: 'oidc',
        displayName: 'Westwind County account',
        issuer: 'http://idp.westwind.example.gov',
        authorizationUrl: 'https://idp.westwind.example.gov/authorize',
        tokenUrl: 'https://idp.westwind.example.gov/token',
        jwksUrl: 'https://idp.westwind.example.gov/keys',
        clientId: 'common-ground',
        clientSecret: 'exercise-secret',
      },
      CONFIRM,
    );
    expect(plainHttp.status).toBe(400);
    // Consequential: no reason, no change (ADM-05).
    expect((await call('admin', 'POST', '/sso', saml)).status).toBe(428);

    const proposed = await call<Sso>('admin', 'POST', '/sso', saml, CONFIRM);
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({
      status: 'proposed',
      protocol: 'saml',
      idpEntityId: 'https://idp.westwind.example.gov/saml',
      askedByYou: true,
    });
    expect(proposed.text).not.toContain('X509Certificate');
    const again = await call('security', 'POST', '/sso', saml, CONFIRM);
    expect(again.status).toBe(409);

    // ADM-05, G6: never approved by the one who proposed it.
    expect((await decide('admin', proposed.body, 'approve')).status).toBe(403);
    const declined = await decide('security', proposed.body, 'decline');
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('declined');
    expect(await outbox()).toHaveLength(0);
  });

  it('SEC-07: approval puts it in force through the worker; the passkey-only invitation follows', async () => {
    const proposed = await call<Sso>(
      'admin',
      'POST',
      '/sso',
      {
        protocol: 'saml',
        displayName: 'Westwind County account',
        metadata: metadata('https://idp.westwind.example.gov/saml'),
      },
      CONFIRM,
    );
    expect(proposed.status).toBe(201);
    const approved = await decide('security', proposed.body, 'approve');
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'active', appliedAt: null });
    expect(approved.body.decidedBy).toBe('Exercise Security Admin');
    const queued = await outbox();
    expect(queued).toHaveLength(1);

    // The worker applies it; a failure is written for the console and retried.
    failNext = new Error('keycloak could not read the SAML metadata: HTTP 400');
    await expect(
      ssoApply(worker(), message('sso.apply', { ssoId: approved.body.id })),
    ).rejects.toThrow();
    let state = await call<{ active: Sso }>('admin', 'GET', '/sso');
    expect(state.body.active.applyError).toContain('could not read the SAML metadata');
    await ssoApply(worker(), message('sso.apply', { ssoId: approved.body.id }));
    const ensured = idpCalls.find((c) => c.op === 'ensure')!;
    expect(ensured.args[0]).toBe(slug);
    expect((ensured.args[1] as SsoProviderSpec).protocol).toBe('saml');
    state = await call<{ active: Sso }>('admin', 'GET', '/sso');
    expect(state.body.active.appliedAt).not.toBeNull();
    expect(state.body.active.applyError).toBeNull();

    // A new account is asked for its passkey only: the county signs it in.
    const invitee = await tx(
      async (trx) =>
        (
          await trx
            .insertInto('cg.account')
            .values({
              tenant_id: county,
              email: `invitee-${run}@example.org`,
              display_name: 'Exercise Invitee',
              status: 'invited',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
    );
    await accountInvited(worker(), message('account.invited', { accountId: invitee }));
    const user = idpCalls.find((c) => c.op === 'user')!;
    expect(user.args[1]).toMatchObject({ email: `invitee-${run}@example.org`, sso: true });
    const invite = idpCalls.find((c) => c.op === 'invite')!;
    expect(invite.args[3]).toBe(true);
  });

  it('SEC-07: an OIDC secret is encrypted and never shown; a newer approval replaces; switching off goes to the worker', async () => {
    const secret = `exercise-oidc-secret-${run}`;
    const proposed = await call<Sso>(
      'security',
      'POST',
      '/sso',
      {
        protocol: 'oidc',
        displayName: 'Westwind County account',
        issuer: 'https://idp.westwind.example.gov',
        authorizationUrl: 'https://idp.westwind.example.gov/authorize',
        tokenUrl: 'https://idp.westwind.example.gov/token',
        jwksUrl: 'https://idp.westwind.example.gov/keys',
        clientId: 'common-ground',
        clientSecret: secret,
      },
      CONFIRM,
    );
    expect(proposed.status).toBe(201);
    expect(proposed.text).not.toContain(secret);
    const stored = await tx((trx) =>
      trx
        .selectFrom('cg.tenant_sso')
        .select(['oidc_client_secret_enc'])
        .where('id', '=', proposed.body.id)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.oidc_client_secret_enc!.toString('utf8')).not.toContain(secret);

    const approved = await decide('admin', proposed.body, 'approve');
    expect(approved.status).toBe(200);
    const state = await call<{ active: Sso; history: Sso[] }>('admin', 'GET', '/sso');
    expect(state.body.active.protocol).toBe('oidc');
    expect(state.body.history.some((h) => h.status === 'replaced')).toBe(true);
    expect(JSON.stringify(state.body)).not.toContain(secret);

    idpCalls.length = 0;
    await ssoApply(worker(), message('sso.apply', { ssoId: approved.body.id }));
    const spec = idpCalls.find((c) => c.op === 'ensure')!.args[1] as SsoProviderSpec;
    expect(spec).toMatchObject({
      protocol: 'oidc',
      clientId: 'common-ground',
      clientSecret: secret,
    });

    // Neither the secret nor the metadata reaches the audit.
    const audit = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'changes'])
        .where('tenant_id', '=', county)
        .where('target_type', '=', 'tenant_sso')
        .execute(),
    );
    expect(audit.length).toBeGreaterThanOrEqual(5);
    const text = JSON.stringify(audit);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('X509Certificate');

    // Either administrator may switch it off; the worker switches the provider off.
    const current = (await call<{ active: Sso }>('admin', 'GET', '/sso')).body.active;
    expect((await call('admin', 'POST', `/sso/${current.id}/disable`)).status).toBe(428);
    const off = await decide('admin', current, 'disable');
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('disabled');
    idpCalls.length = 0;
    await ssoApply(worker(), message('sso.apply', { ssoId: current.id }));
    expect(idpCalls.map((c) => c.op)).toEqual(['disable']);
    expect((await call<{ active: Sso | null }>('admin', 'GET', '/sso')).body.active).toBeNull();
  });
});

/**
 * FL:FR-20: walk-up volunteers sign themselves up by QR. Reception opens a
 * code for an active event; the volunteer reads and accepts the county's
 * waiver on their phone when the county gave its text (in their language when
 * it exists), names skills from a fixed list, and gets a desk code and nothing
 * else. A retried submission makes no second request. Reception sees the
 * request without the contact, completes it through the usual reception step
 * (the contact goes straight to the roster, encrypted) or declines it, and
 * either way the request's details are erased. A closed code, or one whose
 * event closed, is not found. Roles without reception see nothing. Runs on a
 * county of its own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Signup {
  id: string;
  version: number;
  deskCode: string;
  name: string;
  agency: string | null;
  gavePhone: boolean;
  gaveEmail: boolean;
  skills: string[];
  waiverAcceptedAt: string | null;
}

describe.skipIf(!appUrl || !workerUrl)('walk-up volunteer sign-up by QR (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let slug = '';
  let eventId = '';
  let token = '';
  let linkId = '';
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const phone = '+13145550147';

  const call = async (
    who: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.body, json: <T>() => res.json() as T };
  };
  const join = (t: string, method: 'GET' | 'POST' = 'GET', payload?: unknown, lang = 'en') =>
    app.inject({
      method,
      url: `/api/public/volunteers/${slug}/join/${t}?lang=${lang}`,
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const signUp = (t: string, extra: Record<string, unknown> = {}) =>
    join(t, 'POST', {
      executionId: randomUUID(),
      person: { name: `Exercise walk-up ${run}`, phone, agency: 'Exercise CERT' },
      skills: ['chainsaw', 'spanish_speaker'],
      waiverAccepted: true,
      ...extra,
    });
  const tokenOf = (url: string) => new URL(url).searchParams.get('join')!;

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    slug = `exercise-signup-${run}`;
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise sign-up county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      eventId = (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise sign-up flood ${run}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    const as = (template: string): AccountSubject => {
      const t = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId: randomUUID(),
        tenantId: county,
        tenantPath: c.path,
        tenantKind: c.kind,
        status: 'active',
        roles: [
          {
            roleId: randomUUID(),
            key: t.key,
            version: 1,
            templateKey: t.key,
            grants: t.grants,
            scope: {},
          },
        ],
        resolvedAt: new Date(),
      };
    };
    subjects['reception'] = as('volunteer_reception');
    subjects['other'] = as('volunteer_reception');
    subjects['pio'] = as('public_information_officer');
    const loader: SubjectLoader = {
      async fromBearer(t) {
        const s = subjects[t];
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
      routes: routesWith(),
      publicRoutes: [
        publicRoutes({
          resolver: new TenantResolver(dbApp),
          codes: new ReferenceCodeLeaser(dbApp, 'test'),
          risk: new RiskScorer(),
          getQueue: () => undefined,
          residentTokenSecret: 'test-secret-'.repeat(4),
          defaultGraph: westwindGraph,
        }),
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', county)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('FL:FR-20: reception opens a code; the volunteer reads the waiver in their language and gets a desk code only; a retry makes no second request', async () => {
    expect(
      (
        await call('pio', 'POST', '/volunteer-signup-links', {
          eventId,
          waiverVersion: 'exercise-waiver-1',
        })
      ).status,
    ).toBe(403);
    const opened = await call('reception', 'POST', '/volunteer-signup-links', {
      eventId,
      waiverVersion: 'exercise-waiver-1',
      waiverText: { en: 'Exercise waiver text.', es: 'Texto de la exención de ejercicio.' },
      hours: 4,
    });
    expect(opened.status, opened.body).toBe(201);
    const link = opened.json<{ id: string; url: string; waiverLanguages: string[] }>();
    expect(link.waiverLanguages.sort()).toEqual(['en', 'es']);
    expect(link.url).toContain(`/${slug}/help?view=volunteer&join=`);
    token = tokenOf(link.url);
    linkId = link.id;
    // The token itself is never stored.
    const stored = await dbWorker
      .selectFrom('cg.volunteer_signup_link')
      .select('token_hash')
      .where('id', '=', linkId)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash.toString('base64url')).not.toBe(token);

    const es = await join(token, 'GET', undefined, 'es');
    expect(es.statusCode, es.body).toBe(200);
    expect(es.json()).toMatchObject({
      eventName: `Exercise sign-up flood ${run}`,
      waiver: 'Texto de la exención de ejercicio.',
      waiverLang: 'es',
      waiverVersion: 'exercise-waiver-1',
    });
    expect((await join('x'.repeat(43))).statusCode).toBe(404);

    // The waiver shown must be accepted; skills come from the fixed list only.
    expect((await signUp(token, { waiverAccepted: undefined })).statusCode).toBe(400);
    expect((await signUp(token, { skills: ['lock picking'] })).statusCode).toBe(400);
    const executionId = randomUUID();
    const first = await signUp(token, { executionId });
    expect(first.statusCode, first.body).toBe(202);
    const answer = first.json<{ deskCode: string }>();
    expect(Object.keys(answer).sort()).toEqual(['deskCode', 'message', 'received']);
    expect(answer.deskCode).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
    expect(first.body).not.toContain(phone);
    const again = await signUp(token, { executionId });
    expect(again.statusCode).toBe(202);
    expect(again.json<{ deskCode: string }>().deskCode).toBe(answer.deskCode);
    const rows = await dbWorker
      .selectFrom('cg.volunteer_signup')
      .select(['details_enc', 'waiver_accepted_at'])
      .where('execution_id', '=', executionId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.waiver_accepted_at).not.toBeNull();
    expect(rows[0]!.details_enc!.toString('utf8')).not.toContain('5550147');
  });

  it('FL:FR-20, SEC-10: reception sees who is waiting without the contact, and the read is audited; other roles see nothing', async () => {
    expect((await call('pio', 'GET', `/volunteer-signups?eventId=${eventId}`)).status).toBe(403);
    const list = await call('reception', 'GET', `/volunteer-signups?eventId=${eventId}`);
    expect(list.status, list.body).toBe(200);
    expect(list.body).not.toContain('5550147');
    const mine = list.json<Signup[]>().find((r) => r.name === `Exercise walk-up ${run}`)!;
    expect(mine).toMatchObject({
      agency: 'Exercise CERT',
      gavePhone: true,
      gaveEmail: false,
      skills: ['chainsaw', 'spanish_speaker'],
    });
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', county)
      .where('action', '=', 'volunteer_registration.read')
      .where('target_type', '=', 'volunteer_signup')
      .execute();
    expect(audited.length).toBeGreaterThan(0);
  });

  it('FL:FR-20, PER-01, RULE-11: reception completes a request through the usual step; the contact reaches the roster encrypted, the waiver time is the phone acceptance, and the request is erased', async () => {
    const [waiting] = (
      await call('reception', 'GET', `/volunteer-signups?eventId=${eventId}`)
    ).json<Signup[]>();
    const body = {
      clientUuid: randomUUID(),
      eventId,
      signupId: waiting!.id,
      skills: waiting!.skills,
      waiverSigned: true,
      waiverVersion: 'exercise-waiver-1',
      backgroundCheckStatus: 'pending',
    };
    const made = await call('reception', 'POST', '/volunteer-registrations', body);
    expect(made.status, made.body).toBe(201);
    const reg = made.json<{ id: string; personnelId: string; name: string }>();
    expect(reg.name).toBe(`Exercise walk-up ${run}`);
    const person = await dbWorker
      .selectFrom('cg.personnel')
      .select(['contact_enc', 'agency'])
      .where('id', '=', reg.personnelId)
      .executeTakeFirstOrThrow();
    expect(person.agency).toBe('Exercise CERT');
    expect(person.contact_enc!.toString('utf8')).not.toContain('5550147');
    expect(await crypto.decrypt(county, person.contact_enc!)).toContain(phone);
    const signup = await dbWorker
      .selectFrom('cg.volunteer_signup')
      .select(['status', 'details_enc', 'registration_id', 'waiver_accepted_at'])
      .where('id', '=', waiting!.id)
      .executeTakeFirstOrThrow();
    expect(signup).toMatchObject({
      status: 'registered',
      details_enc: null,
      registration_id: reg.id,
    });
    const registration = await dbWorker
      .selectFrom('cg.volunteer_registration')
      .select('waiver_signed_at')
      .where('id', '=', reg.id)
      .executeTakeFirstOrThrow();
    expect(registration.waiver_signed_at!.toISOString()).toBe(
      signup.waiver_accepted_at!.toISOString(),
    );
    // A second desk taking the same request is refused, not registered twice.
    const twice = await call('other', 'POST', '/volunteer-registrations', {
      ...body,
      clientUuid: randomUUID(),
    });
    expect(twice.status).toBe(409);
    expect(
      (await call('reception', 'GET', `/volunteer-signups?eventId=${eventId}`))
        .json<Signup[]>()
        .some((r) => r.id === waiting!.id),
    ).toBe(false);
  });

  it('FL:FR-20: a declined request is erased; a closed code, or one whose event closed, is not found; without waiver text the waiver is signed at the desk', async () => {
    const d = await signUp(token);
    expect(d.statusCode).toBe(202);
    const code = d.json<{ deskCode: string }>().deskCode;
    const r = (await call('reception', 'GET', `/volunteer-signups?eventId=${eventId}`))
      .json<Signup[]>()
      .find((x) => x.deskCode === code)!;
    const declined = await call(
      'reception',
      'POST',
      `/volunteer-signups/${r.id}/decline`,
      undefined,
      {
        'if-match': `"${r.version}"`,
      },
    );
    expect(declined.status, declined.body).toBe(204);
    const gone = await dbWorker
      .selectFrom('cg.volunteer_signup')
      .select(['status', 'details_enc'])
      .where('id', '=', r.id)
      .executeTakeFirstOrThrow();
    expect(gone).toEqual({ status: 'declined', details_enc: null });
    expect(
      (
        await call('reception', 'POST', `/volunteer-signups/${r.id}/decline`, undefined, {
          'if-match': `"${r.version + 1}"`,
        })
      ).status,
    ).toBe(409);

    expect(
      (await call('reception', 'POST', `/volunteer-signup-links/${linkId}/close`)).status,
    ).toBe(204);
    expect((await join(token)).statusCode).toBe(404);
    expect((await signUp(token)).statusCode).toBe(404);

    const plain = await call('reception', 'POST', '/volunteer-signup-links', {
      eventId,
      waiverVersion: 'exercise-waiver-1',
    });
    const plainToken = tokenOf(plain.json<{ url: string }>().url);
    const info = await join(plainToken);
    expect(info.json()).toMatchObject({ waiver: null, waiverLang: null });
    const noWaiver = await signUp(plainToken, { waiverAccepted: undefined });
    expect(noWaiver.statusCode, noWaiver.body).toBe(202);
    const row = await dbWorker
      .selectFrom('cg.volunteer_signup')
      .select('waiver_accepted_at')
      .where('desk_code', '=', noWaiver.json<{ deskCode: string }>().deskCode)
      .where('tenant_id', '=', county)
      .executeTakeFirstOrThrow();
    expect(row.waiver_accepted_at).toBeNull();

    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.event')
        .set({ status: 'closed', closed_at: new Date() })
        .where('id', '=', eventId)
        .execute(),
    );
    expect((await join(plainToken)).statusCode).toBe(404);
  });
});

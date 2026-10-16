/**
 * FL:FR-06: targeted boil-water and safety notices. Public health drafts a
 * notice for an area; its reach is counts only; the drafter cannot approve it
 * (ADM-05 G4) and approval needs a reason; once approved it is on the public
 * help page, first for a visitor in its ZIP code; residents in the area are
 * told once in their language: a text only with SMS opt-in, an email only when
 * email is how they asked to be reached, nobody outside the area, nobody whose
 * report was withdrawn, and the same phone once. A redelivered job sends
 * nothing twice. Lifting it takes it off the page and tells the same residents
 * it ended. Roles without health notices see nothing. Runs on a county of its
 * own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, randomCode, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { healthNoticeSend } from '../../worker/src/jobs/health-notices.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Notice {
  id: string;
  version: number;
  status: string;
  sent: { sms: number; email: number };
  endedSent: { sms: number; email: number };
}
interface Outbox {
  payload: {
    template: string;
    channel: string;
    language: string;
    partyId: string;
    toEnc: string;
    variables: Record<string, string>;
  };
}

describe.skipIf(!appUrl || !workerUrl)('health notices (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let slug = '';
  let eventId = '';
  let notice: Notice;
  const run = randomUUID().slice(0, 8);
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const subjects: Record<string, AccountSubject> = {};
  const party: Record<string, string> = {};
  let ctx: JobContext;

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PUT',
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
  const confirmed = (version: number) => ({
    'if-match': `"${version}"`,
    'x-confirm': 'true',
    'x-reason': 'Exercise water main break',
  });
  /** The worker's own messages for this notice, read from the outbox. */
  const queued = async (template: string) =>
    (
      (await dbWorker
        .selectFrom('cg.outbox')
        .select('payload')
        .where('tenant_id', '=', county)
        .where('topic', '=', 'message.send')
        .where(sql<boolean>`payload->>'template' = ${template}`)
        .execute()) as unknown as Outbox[]
    ).map((r) => r.payload);
  const runJob = (phase: 'issued' | 'ended') =>
    healthNoticeSend(ctx, {
      id: Math.floor(Math.random() * 1e9),
      tenantId: county,
      topic: 'health_notice.send',
      payload: { noticeId: notice.id, phase },
      executionId: randomUUID(),
    });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    slug = `exercise-notices-${run}`;
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise notices county ${run}`,
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
            name: `Exercise notices flood ${run}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // Residents: [key, contact, opted in, language, ZIP, point, withdrawn]
      const people: [
        string,
        { phone?: string; email?: string; preferred?: string },
        boolean,
        string,
        string | null,
        [number, number] | null,
        boolean,
      ][] = [
        ['texter', { phone: '+13145550101' }, true, 'es', '63002', null, false],
        ['same-phone', { phone: '+13145550101' }, true, 'es', '63002', null, false],
        [
          'no-opt-in',
          { phone: '+13145550102', email: 'b@example.org', preferred: 'text' },
          false,
          'en',
          '63002',
          null,
          false,
        ],
        [
          'emailer',
          { email: 'c@example.org', preferred: 'email' },
          false,
          'en',
          null,
          [38.8, -90.86],
          false,
        ],
        ['outside', { phone: '+13145550104' }, true, 'en', '63099', null, false],
        ['withdrawn', { phone: '+13145550105' }, true, 'en', '63002', null, true],
        ['unreadable', { phone: '+13145550106' }, true, 'en', '63002', null, false],
      ];
      for (const [key, contact, optIn, language, postal, point, withdrawn] of people) {
        const p = await trx
          .insertInto('cg.party')
          .values({
            tenant_id: county,
            kind: 'resident',
            contact_enc: await crypto.encrypt(county, JSON.stringify(contact)),
            phone_bidx: contact.phone
              ? await crypto.blindIndex(county, 'phone', contact.phone)
              : null,
            email_bidx: contact.email
              ? await crypto.blindIndex(county, 'email', contact.email)
              : null,
            language,
            sms_opt_in: optIn,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        party[key] = p.id;
        // A contact that cannot be read must not stop the others from being told.
        if (key === 'unreadable')
          await trx
            .updateTable('cg.party')
            .set({ contact_enc: Buffer.from('not a ciphertext') })
            .where('id', '=', p.id)
            .execute();
        const loc = await trx
          .insertInto('cg.location')
          .values({
            tenant_id: county,
            postal,
            ...(point
              ? { geom: sql`ST_SetSRID(ST_MakePoint(${point[1]}, ${point[0]}), 4326)` }
              : {}),
          } as never)
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.report')
          .values({
            tenant_id: county,
            event_id: eventId,
            reference_code: randomCode(),
            execution_id: randomUUID(),
            graph_key: 'damage',
            graph_version: 1,
            channel_of_origin: 'web',
            relationship: 'own_home',
            reporter_party_id: p.id,
            location_id: loc.id,
            ...(withdrawn ? { withdrawn_at: new Date() } : {}),
          } as never)
          .execute();
      }
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
    subjects['health'] = as('public_health_inspector');
    subjects['pio'] = as('public_information_officer');
    subjects['volunteer'] = as('field_volunteer');
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
    ctx = {
      db: dbWorker,
      crypto,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      urls: { gatewayPublic: 'https://cg.example.org' },
    } as unknown as JobContext;
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

  it('FL:FR-06: public health drafts a notice for ZIP codes and a circle; its reach is counts only; others see nothing', async () => {
    expect((await call('volunteer', 'GET', '/health-notices')).status).toBe(403);
    const draft = {
      eventId,
      kind: 'boil_water',
      en: {
        title: 'Boil water before drinking',
        body: 'Boil tap water for one minute before drinking or cooking.\n\nThe notice stays until the county lifts it.',
      },
      es: {
        title: 'Hierva el agua antes de beberla',
        body: 'Hierva el agua de la llave un minuto antes de beberla o cocinar.',
      },
      areaLabel: `Exercise Cedar Ridge water system ${run}`,
      zips: ['63002'],
      circle: { lat: 38.8, lon: -90.86, radiusM: 500 },
    };
    expect(
      (await call('health', 'POST', '/health-notices', { ...draft, zips: [], circle: undefined }))
        .status,
    ).toBe(400);
    const made = await call('health', 'POST', '/health-notices', draft);
    expect(made.status, made.body).toBe(201);
    notice = made.json<Notice>();
    expect(notice.status).toBe('draft');
    const reach = await call('health', 'GET', `/health-notices/${notice.id}/reach`);
    expect(reach.status, reach.body).toBe(200);
    // The texter once (the same phone twice), the emailer by email; the one without opt-in and
    // the one whose contact cannot be read are not reached.
    expect(reach.json()).toEqual({ sms: 1, email: 1, unreachable: 2 });
    expect(reach.body).not.toContain('555');
    // Not on the public page while a draft.
    const page = await app.inject({ method: 'GET', url: `/api/public/help/${slug}?near=63002` });
    expect(page.json<{ healthNotices: unknown[] }>().healthNotices).toEqual([]);
  });

  it('FL:FR-06, ADM-05 G4: the drafter cannot approve; a second person approves with a reason; it is published and each resident in the area is told once, in their language', async () => {
    expect(
      (
        await call(
          'health',
          'POST',
          `/health-notices/${notice.id}/approve`,
          undefined,
          confirmed(notice.version),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call('pio', 'POST', `/health-notices/${notice.id}/approve`, undefined, {
          'if-match': `"${notice.version}"`,
        })
      ).status,
    ).toBe(428);
    const approved = await call(
      'pio',
      'POST',
      `/health-notices/${notice.id}/approve`,
      undefined,
      confirmed(notice.version),
    );
    expect(approved.status, approved.body).toBe(200);
    notice = approved.json<Notice>();
    expect(notice.status).toBe('active');
    const job = await dbWorker
      .selectFrom('cg.outbox')
      .select('payload')
      .where('tenant_id', '=', county)
      .where('topic', '=', 'health_notice.send')
      .execute();
    expect(job).toHaveLength(1);

    await runJob('issued');
    await runJob('issued'); // a redelivery sends nothing twice
    const sent = await queued('health_notice');
    expect(sent).toHaveLength(2);
    const text = sent.find((m) => m.channel === 'sms')!;
    expect([party['texter'], party['same-phone']]).toContain(text.partyId);
    expect(text.language).toBe('es');
    expect(text.variables['title']).toBe('Hierva el agua antes de beberla');
    expect(await crypto.decrypt(county, Buffer.from(text.toEnc, 'base64'))).toBe('+13145550101');
    const email = sent.find((m) => m.channel === 'email')!;
    expect(email.partyId).toBe(party['emailer']);
    expect(email.language).toBe('en');
    expect(email.variables['text']).toContain('Boil tap water');
    for (const key of ['no-opt-in', 'outside', 'withdrawn', 'unreadable'])
      expect(sent.some((m) => m.partyId === party[key])).toBe(false);
    const row = (await call('pio', 'GET', '/health-notices')).json<Notice[]>()[0]!;
    expect(row.sent).toMatchObject({ sms: 1, email: 1 });

    // On the public page, for the visitor's ZIP first and in their language.
    const page = await app.inject({
      method: 'GET',
      url: `/api/public/help/${slug}?near=63002&lang=es`,
    });
    const shown = page.json<{
      healthNotices: { title: string; here: boolean; areaLabel: string }[];
    }>().healthNotices;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'Hierva el agua antes de beberla', here: true });
    const elsewhere = await app.inject({
      method: 'GET',
      url: `/api/public/help/${slug}?near=63099`,
    });
    expect(elsewhere.json<{ healthNotices: { here: boolean }[] }>().healthNotices[0]!.here).toBe(
      false,
    );
  });

  it('FL:FR-06: lifting the notice takes it off the page and tells the residents who were told, once', async () => {
    // The counts the worker recorded moved the version; the screen reloads before ending.
    notice = (await call('health', 'GET', '/health-notices')).json<Notice[]>()[0]!;
    const ended = await call(
      'health',
      'POST',
      `/health-notices/${notice.id}/end`,
      { reason: 'lifted', tellResidents: true },
      confirmed(notice.version),
    );
    expect(ended.status, ended.body).toBe(200);
    expect(ended.json<Notice>().status).toBe('ended');
    expect(
      (
        await call(
          'health',
          'POST',
          `/health-notices/${notice.id}/end`,
          { reason: 'lifted' },
          confirmed(notice.version + 1),
        )
      ).status,
    ).toBe(409);
    await runJob('ended');
    await runJob('ended');
    const told = await queued('health_notice_ended');
    expect(told).toHaveLength(2);
    expect(told.find((m) => m.channel === 'sms')!.variables['what']).toBe('levantado');
    const page = await app.inject({ method: 'GET', url: `/api/public/help/${slug}?near=63002` });
    expect(page.json<{ healthNotices: unknown[] }>().healthNotices).toEqual([]);
    // The ledger names parties and phases, never a contact.
    const ledger = await dbWorker
      .selectFrom('cg.health_notice_recipient')
      .selectAll()
      .where('notice_id', '=', notice.id)
      .execute();
    expect(ledger.map((r) => r.phase).sort()).toEqual(['ended', 'ended', 'issued', 'issued']);
    expect(JSON.stringify(ledger)).not.toContain('555');
  });
});

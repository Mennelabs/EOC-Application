/**
 * Partner sharing against a real PostgreSQL (NED-04, NED-05, AC-17C, FL-03,
 * SEC-05/06, SEC-18, BRD:RULE-12): a resident's report with consent for two
 * organization types becomes one share grant per matching agreement, each
 * cut to its service's minimum sections; partners read only through the
 * grants, masked further by their role's data categories, and every read is
 * audited; a partner never sees the county's report itself; county staff
 * without the grant get nothing; NOSHARE from the resident's phone withdraws
 * every sharing consent, revokes the grants and queues recall notices that
 * the grant records; NOSHARE from another phone changes nothing. Runs only
 * with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorSms } from '@cg/adapters';
import { fakeProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import type { Kysely } from 'kysely';
import { loadSeed, SEED_COUNTY_NUMBER } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../../worker/src/idp/keycloak.ts';
import { sweepStoredSubmissions } from '../../worker/src/jobs/intake.ts';
import { messageSend } from '../../worker/src/jobs/messages.ts';
import { consentChanged } from '../../worker/src/jobs/reports.ts';
import type { JobContext, OutboxMessage } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { webhookRoutes } from '../src/channels/routes.ts';
import { ChannelSessions } from '../src/channels/session.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { submitIntake } from '../src/public/submit.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routes } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface SharedView {
  grantIds: string[];
  reportId: string;
  referenceCode: string | null;
  orgTypes: string[];
  sections: string[];
  maskedSections: string[];
  name: string | null;
  contact: { phone?: string; email?: string } | null;
  contactPreference: string | null;
  address: { line1?: string; postal?: string } | null;
  area: { city?: string; postal?: string } | null;
  householdBand: string | null;
  needs: { category: string; status: string }[] | null;
  accessNeeds: string[] | null;
}

describe.skipIf(!appUrl || !workerUrl)('partner sharing (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let tenants: Record<string, string>;
  let subjects: Record<string, AccountSubject>;
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  let worker: JobContext;
  const run = Date.now().toString().slice(-7);
  const residentPhone = `+1314559${run.slice(-4)}`;
  const strangerPhone = `+1314560${run.slice(-4)}`;
  const headers = (who: string) => ({ authorization: `Bearer ${who}` });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    tenants = seeded.tenants;
    const paths = Object.fromEntries(
      (
        await dbWorker
          .selectFrom('cg.tenant')
          .select(['id', 'path'])
          .where('id', 'in', Object.values(tenants))
          .execute()
      ).map((t) => [t.id, t.path]),
    );
    const subjectFor = (tenantKey: string, templateKey: string, accountId: string) => {
      const t = roleTemplates.find((r) => r.key === templateKey)!;
      const tenantId = tenants[tenantKey]!;
      return {
        kind: 'account' as const,
        accountId,
        tenantId,
        tenantPath: paths[tenantId]!,
        status: 'active' as const,
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
    subjects = {
      // County staff without shared.read (the assessment coordinator reviews reports).
      priya: subjectFor(
        'county',
        'damage_assessment_coordinator',
        seeded.accounts['priya.assessment@example.org']!,
      ),
      // Partners: the seeded canteen commander, the shelter nurse, the COAD chair; a cleanup lead (no seeded account).
      ruth: subjectFor(
        'canteen',
        'ngo_incident_commander',
        seeded.accounts['ruth.canteen@example.org']!,
      ),
      nurse: subjectFor('shelter-ngo', 'shelter_nurse', seeded.accounts['nurse@example.org']!),
      jen: subjectFor('coad', 'coad_chair', seeded.accounts['jen.coad@example.org']!),
      crew: subjectFor('cleanup', 'cleanup_crew_lead', randomUUID()),
      // Agreements: the director drafts, a second administrator signs (ADM-02).
      dana: subjectFor(
        'county',
        'county_em_director',
        seeded.accounts['dana.director@example.org']!,
      ),
      coordinator: subjectFor('county', 'partner_coordinator', randomUUID()),
    };
    const loader: SubjectLoader = {
      async fromBearer(token) {
        const s = subjects[token];
        if (!s) throw new AuthError('invalid_token');
        return s;
      },
    };
    const resolver = new TenantResolver(dbApp);
    const codes = new ReferenceCodeLeaser(dbApp, 'test');
    const risk = new RiskScorer();
    const submitDeps = {
      codes,
      risk,
      getQueue: () => undefined,
      defaultGraph: westwindGraph,
      crypto,
      now: () => new Date(),
    };
    const ai = { providerFor: async () => fakeProvider };
    const sessions = new ChannelSessions({
      crypto,
      defaultGraph: westwindGraph,
      submit: (req, input) => submitIntake(submitDeps, req, input),
      publicBase: 'https://localhost',
    });
    app = await buildApp({
      productName: 'Test Product',
      version: '0.0.0',
      dataMode: 'synthetic',
      logLevel: 'silent',
      probes: [],
      db: dbApp,
      fieldCrypto: crypto,
      subjects: loader,
      routes,
      reportDeps: { ai, submit: (req, input) => submitIntake(submitDeps, req, input) },
      publicRoutes: [
        publicRoutes({
          resolver,
          codes,
          risk,
          getQueue: () => undefined,
          residentTokenSecret: 'test-secret-'.repeat(4),
          defaultGraph: westwindGraph,
          ai,
        }),
      ],
      webhookRoutes: [
        webhookRoutes({ resolver, sessions, publicBase: 'https://localhost', simulator: true }),
      ],
    });
    worker = {
      db: dbWorker,
      log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as JobContext['log'],
      idp: {} as unknown as KeycloakAdmin,
      mail: { send: async () => undefined },
      sms: new SimulatorSms(),
      crypto,
      urls: { gatewayPublic: 'https://localhost', idpPublic: '', idpInternal: '' },
      objects: null,
      devDirectGrant: false,
      ai,
      defaultGraph: westwindGraph,
    };
  });

  afterAll(async () => {
    await app?.close();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  async function text(from: string, body: string): Promise<string[]> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/simulator/sms',
      payload: { from, to: SEED_COUNTY_NUMBER, body },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().replies as string[];
  }

  async function outbox(topic: string): Promise<OutboxMessage[]> {
    const rows = await dbWorker
      .selectFrom('cg.outbox')
      .select(['id', 'tenant_id', 'topic', 'payload', 'execution_id'])
      .where('tenant_id', '=', tenants['county']!)
      .where('topic', '=', topic)
      .where('published_at', 'is', null)
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      id: Number(r.id),
      tenantId: r.tenant_id,
      topic: r.topic,
      payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<
        string,
        unknown
      >,
      executionId: r.execution_id,
    }));
  }

  async function grants() {
    return dbWorker
      .selectFrom('cg.share_grant')
      .innerJoin('cg.tenant', 'cg.tenant.id', 'cg.share_grant.to_tenant_id')
      .select([
        'cg.share_grant.id as id',
        'cg.tenant.slug as partner',
        'cg.share_grant.org_type as org_type',
        'cg.share_grant.sections as sections',
        'cg.share_grant.revoked_at as revoked_at',
        'cg.share_grant.revoke_reason as revoke_reason',
        'cg.share_grant.recall_notice_message_id as recall_notice_message_id',
        'cg.share_grant.projection as projection',
      ])
      .where('cg.share_grant.report_id', '=', reportId)
      .orderBy('cg.tenant.slug')
      .execute();
  }

  let reportId: string;
  let referenceCode: string;

  it('filing a report with consent cuts one grant per matching agreement, each to its service minimum (NED-04)', async () => {
    const executionId = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/intake/county/westwind/submissions',
      headers: { 'idempotency-key': executionId },
      payload: {
        executionId,
        channel: 'web',
        language: 'en',
        graphKey: westwindGraph.key,
        graphVersion: westwindGraph.version,
        relationship: 'own_home',
        answers: {
          danger_now: { kind: 'value', value: 'no' },
          relationship: { kind: 'value', value: 'own_home' },
          address: {
            kind: 'value',
            value: { line1: `${run} Share Ln`, city: 'Westwind', postal: '63002' },
          },
          home_type: { kind: 'value', value: 'house' },
          cause: { kind: 'value', value: 'wind_tornado' },
          damage_types: { kind: 'value', value: ['roof', 'water_inside'] },
          roof_state: { kind: 'value', value: 'large_hole' },
          habitable: { kind: 'value', value: 'no' },
          tonight: { kind: 'value', value: 'no' },
          insurance: { kind: 'unknown' },
          contact_name: { kind: 'value', value: 'Rosa Delgado' },
          contact: {
            kind: 'value',
            value: { phone: residentPhone, email: `rosa-${run}@example.org`, preferred: 'text' },
          },
        },
        afterSubmission: {
          household_size: { kind: 'value', value: 5 },
          access_needs: { kind: 'value', value: ['mobility'] },
        },
        needs: ['shelter_tonight', 'cleanup_tarp'],
        consent: { volunteer_cleanup: true, relief_agencies: true, community_groups: true },
        smsOptIn: true,
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    referenceCode = res.json().referenceCode;
    await sweepStoredSubmissions(worker);
    const report = await dbWorker
      .selectFrom('cg.report')
      .select('id')
      .where('reference_code', '=', referenceCode)
      .executeTakeFirstOrThrow();
    reportId = report.id;

    const rows = await grants();
    expect(rows.map((g) => [g.partner, g.org_type, g.sections.join(',')])).toEqual([
      ['canteen', 'relief_agencies', 'area,household_band,need'],
      ['cleanup', 'volunteer_cleanup', 'name,contact,contact_preference,address_exact,need'],
      ['legal', 'relief_agencies', 'name,contact'],
      ['shelter-ngo', 'relief_agencies', 'contact,need,access_needs'],
    ]);
    // The COAD coordinates; its agreement names no categories, so nothing is cut for it.
    expect(rows.find((g) => g.partner === 'coad')).toBeUndefined();
    const canteen = rows.find((g) => g.partner === 'canteen')!.projection as Record<
      string,
      unknown
    >;
    expect(canteen['householdBand']).toBe('5-7');
    expect(canteen['area']).toEqual({ city: 'Westwind', postal: '63002' });
    expect(canteen['address']).toBeUndefined();
    expect(JSON.stringify(canteen)).not.toContain('Rosa');
    expect(JSON.stringify(canteen)).not.toContain(residentPhone);
    // A second sweep (a redelivery) changes nothing (BRD:FR-00.06).
    await sweepStoredSubmissions(worker);
    const again = await grants();
    expect(again.map((g) => g.id)).toEqual(rows.map((g) => g.id));
  });

  it('the cleanup crew reads name, contact and the exact address; nothing of the household (AC-17C, FL-03, SEC-18)', async () => {
    const list = await app.inject({ url: '/api/v1/shared/reports', headers: headers('crew') });
    expect(list.statusCode, list.body).toBe(200);
    const rows = list.json() as SharedView[];
    const mine = rows.find((r) => r.reportId === reportId)!;
    expect(mine).toBeDefined();
    expect(mine.referenceCode).toBe(referenceCode);
    const detail = await app.inject({
      url: `/api/v1/shared/reports/${reportId}`,
      headers: headers('crew'),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const view = detail.json() as SharedView;
    expect(view.name).toBe('Rosa Delgado');
    expect(view.contact).toEqual({ phone: residentPhone, email: `rosa-${run}@example.org` });
    expect(view.contactPreference).toBe('text');
    expect(view.address?.line1).toBe(`${run} Share Ln`);
    expect(view.needs?.map((n) => n.category).sort()).toEqual(['cleanup_tarp', 'shelter_tonight']);
    expect(view.householdBand).toBeNull();
    expect(view.accessNeeds).toBeNull();
    expect(view.maskedSections).toEqual([]);
    const audits = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['action', 'target_id', 'classification_read'])
      .where('tenant_id', '=', tenants['cleanup']!)
      .where('action', '=', 'shared.read')
      .where('actor_account_id', '=', subjects['crew']!.accountId)
      .execute();
    // The list and the detail each audited this grant (other grants on the list have their own rows).
    const onThisGrant = audits.filter((a) => a.target_id === view.grantIds[0]);
    expect(onThisGrant.length).toBeGreaterThanOrEqual(2);
    // The name is restricted by classification (basic category), the phone by category.
    expect(onThisGrant.at(-1)!.classification_read).toEqual(['basic', 'contact']);
  });

  it('the canteen reads the area and a household band, never the street, the name or the phone (NED-04)', async () => {
    const detail = await app.inject({
      url: `/api/v1/shared/reports/${reportId}`,
      headers: headers('ruth'),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const view = detail.json() as SharedView;
    expect(view.area).toEqual({ city: 'Westwind', postal: '63002' });
    expect(view.householdBand).toBe('5-7');
    expect(view.needs?.length).toBe(2);
    expect(view.name).toBeNull();
    expect(view.contact).toBeNull();
    expect(view.address).toBeNull();
    expect(view.accessNeeds).toBeNull();
    expect(detail.body).not.toContain('Share Ln');
  });

  it('the shelter nurse reads contact and access needs because shelter was asked and the role qualifies (ADM-05)', async () => {
    const detail = await app.inject({
      url: `/api/v1/shared/reports/${reportId}`,
      headers: headers('nurse'),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const view = detail.json() as SharedView;
    expect(view.contact?.phone).toBe(residentPhone);
    expect(view.accessNeeds).toEqual(['mobility']);
    expect(view.address).toBeNull();
    expect(view.name).toBeNull(); // the shelter service's row has no name section
  });

  it('the COAD chair sees nothing shared; county staff without the grant are refused; a partner cannot open the county report (SEC-05/06)', async () => {
    const coad = await app.inject({ url: '/api/v1/shared/reports', headers: headers('jen') });
    expect(coad.statusCode, coad.body).toBe(200);
    expect((coad.json() as SharedView[]).find((r) => r.reportId === reportId)).toBeUndefined();
    const staff = await app.inject({ url: '/api/v1/shared/reports', headers: headers('priya') });
    expect(staff.statusCode, staff.body).toBe(403);
    const direct = await app.inject({
      url: `/api/v1/reports/${reportId}`,
      headers: headers('crew'),
    });
    expect([403, 404]).toContain(direct.statusCode);
    const unknown = await app.inject({
      url: `/api/v1/shared/reports/${randomUUID()}`,
      headers: headers('crew'),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('NOSHARE from another phone changes nothing and reveals nothing (NED-05)', async () => {
    const replies = await text(strangerPhone, `NOSHARE ${referenceCode}`);
    expect(replies[0]).toContain('found no report');
    expect((await grants()).every((g) => g.revoked_at === null)).toBe(true);
    const consents = await dbWorker
      .selectFrom('cg.consent')
      .select('granted')
      .where('report_id', '=', reportId)
      .execute();
    expect(consents.every((c) => c.granted)).toBe(true);
  });

  it('NOSHARE from the resident withdraws every sharing consent; the worker revokes the grants and queues recall notices the grants record (NED-05, AC-17C)', async () => {
    const replies = await text(residentPhone, `noshare ${referenceCode.toLowerCase()}`);
    expect(replies[0]).toContain(`report ${referenceCode} is no longer shared`);
    const consents = await dbWorker
      .selectFrom('cg.consent')
      .select(['granted', 'channel', 'withdrawn_at'])
      .where('report_id', '=', reportId)
      .execute();
    expect(consents).toHaveLength(3);
    expect(consents.every((c) => !c.granted && c.channel === 'sms' && c.withdrawn_at)).toBe(true);

    const changes = await outbox('consent.changed');
    const mine = changes.filter((m) => m.payload['reportId'] === reportId);
    expect(mine).toHaveLength(1);
    await consentChanged(worker, mine[0]!);
    const rows = await grants();
    expect(rows).toHaveLength(4);
    expect(rows.every((g) => g.revoked_at !== null && g.revoke_reason === 'consent')).toBe(true);

    // One recall notice per partner that had the record: to the seeded accounts holding partner roles,
    // else to the partner's security contact (the cleanup and legal tenants have no accounts seeded).
    const notices = (await outbox('message.send')).filter(
      (m) => m.payload['template'] === 'sharing_recall' && m.payload['reportId'] === reportId,
    );
    const grantIds = new Set(notices.map((m) => m.payload['shareGrantId']));
    expect(grantIds).toEqual(new Set(rows.map((g) => g.id)));
    await messageSend(worker, notices[0]!);
    const sent = await dbWorker
      .selectFrom('cg.message')
      .select(['id', 'state', 'template', 'channel', 'body_enc'])
      .where('report_id', '=', reportId)
      .where('template', '=', 'sharing_recall')
      .execute();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.state).toBe('sent');
    expect(sent[0]!.channel).toBe('email');
    const body = await crypto.decrypt(tenants['county']!, sent[0]!.body_enc);
    expect(body).toContain(referenceCode);
    expect(body).toContain('delete');
    const stamped = (await grants()).find((g) => g.id === notices[0]!.payload['shareGrantId'])!;
    expect(stamped.recall_notice_message_id).toBe(sent[0]!.id);

    // The board hides the record from every partner at once.
    const list = await app.inject({ url: '/api/v1/shared/reports', headers: headers('crew') });
    expect((list.json() as SharedView[]).find((r) => r.reportId === reportId)).toBeUndefined();
    const detail = await app.inject({
      url: `/api/v1/shared/reports/${reportId}`,
      headers: headers('nurse'),
    });
    expect(detail.statusCode).toBe(404);
    // Running the sync again changes nothing.
    await consentChanged(worker, mine[0]!);
    expect((await grants()).map((g) => g.revoked_at?.toISOString())).toEqual(
      rows.map((g) => g.revoked_at?.toISOString()),
    );
  });

  it('an agreement is drafted by the county, signed by the partner with its version and a reason, and revoked by the county (ADM-02, SCL-01)', async () => {
    const confirmed = (reason: string) => ({ 'x-confirm': 'true', 'x-reason': reason });
    const drafted = await app.inject({
      method: 'POST',
      url: '/api/v1/agreements',
      headers: { ...headers('dana'), 'idempotency-key': randomUUID() },
      payload: {
        toTenantId: tenants['coad'],
        scope: 'consented_records',
        dataCategories: [],
        terms: { orgType: 'community_groups', service: 'coordination', recallOnWithdrawal: true },
      },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    const agreement = drafted.json() as {
      id: string;
      version: number;
      status: string;
      terms: Record<string, unknown>;
    };
    expect(agreement.status).toBe('draft');
    expect(agreement.terms['service']).toBe('coordination');
    // The county cannot sign its own draft; the partner signs, with the version and a reason.
    const countySigns = await app.inject({
      method: 'POST',
      url: `/api/v1/agreements/${agreement.id}/sign`,
      headers: {
        ...headers('coordinator'),
        'if-match': String(agreement.version),
        ...confirmed('not my side'),
      },
    });
    expect(countySigns.statusCode).toBe(404);
    const unconfirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/agreements/${agreement.id}/sign`,
      headers: { ...headers('jen'), 'if-match': String(agreement.version) },
    });
    expect(unconfirmed.statusCode).toBe(428);
    const signed = await app.inject({
      method: 'POST',
      url: `/api/v1/agreements/${agreement.id}/sign`,
      headers: {
        ...headers('jen'),
        'if-match': String(agreement.version),
        ...confirmed('Board approved'),
      },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    const after = signed.json() as {
      version: number;
      status: string;
      signedAt: string | null;
      signedBy: string | null;
    };
    expect(after.status).toBe('signed');
    expect(after.signedBy).toBe(subjects['jen']!.accountId);
    const partnerRevokes = await app.inject({
      method: 'POST',
      url: `/api/v1/agreements/${agreement.id}/revoke`,
      headers: {
        ...headers('jen'),
        'if-match': String(after.version),
        ...confirmed('not my side'),
      },
    });
    expect(partnerRevokes.statusCode).toBe(404);
    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/agreements/${agreement.id}/revoke`,
      headers: {
        ...headers('dana'),
        'if-match': String(after.version),
        ...confirmed('Partner left the COAD'),
      },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((revoked.json() as { status: string }).status).toBe('revoked');
  });
});

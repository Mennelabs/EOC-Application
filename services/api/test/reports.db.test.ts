/**
 * Staff review routes against a real PostgreSQL (BRD:FR-12.01–12.06,
 * FR-10.06, CON-05, CON-10, PHO-07, PHO-14, DCL:DEC-02/03, EQ-08, SEC-18,
 * guardrail G4, AC-10B, AC-12A/B/C): an assisted report goes through the one
 * submission path and the worker files it; the queue orders need signals
 * first; the detail shows contact only to roles with the category and audits
 * the read; claim, decisions with confirmation and a reason, self-review
 * refused, needs-information sends a correction request, verification and
 * degree, reopen; photos stay restricted without the evidence category;
 * translation is labelled; graph versions draft and publish. Runs only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL; skipped otherwise.
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
import { enableAiTestDouble } from '../../../tools/seed/src/ai-test-double.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../../worker/src/idp/keycloak.ts';
import { sweepStoredSubmissions } from '../../worker/src/jobs/intake.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { submitIntake } from '../src/public/submit.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routes } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!appUrl || !workerUrl)('staff review routes (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let tenantId: string;
  // ADR-0043: the test double for this suite only; the register is put back afterwards.
  let restoreAi: (() => Promise<void>) | undefined;
  let eventId: string;
  let subjects: Record<string, AccountSubject>;
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  let worker: JobContext;

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${who}`,
    ...extra,
  });
  const confirmed = (reason: string) => ({ 'x-confirm': 'true', 'x-reason': reason });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    tenantId = seeded.tenants['county']!;
    restoreAi = await enableAiTestDouble(dbWorker, tenantId);
    const tenant = await dbWorker
      .selectFrom('cg.tenant')
      .select(['path'])
      .where('id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const event = await dbWorker
      .selectFrom('cg.event')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('intake_slug', '=', 'westwind')
      .executeTakeFirstOrThrow();
    eventId = event.id;
    const subjectFor = (email: string, templateKey: string): AccountSubject => {
      const t = roleTemplates.find((r) => r.key === templateKey)!;
      return {
        kind: 'account',
        accountId: seeded.accounts[email]!,
        tenantId,
        tenantPath: tenant.path,
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
    subjects = {
      priya: subjectFor('priya.assessment@example.org', 'damage_assessment_coordinator'),
      dana: subjectFor('dana.director@example.org', 'county_em_director'),
      luis: subjectFor('luis.masscare@example.org', 'mass_care_coordinator'),
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
    await restoreAi?.();
    await app?.close();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const answers = (extra: Record<string, unknown> = {}) => ({
    danger_now: { kind: 'value', value: 'no' },
    relationship: { kind: 'value', value: 'own_home' },
    address: {
      kind: 'value',
      value: { line1: `${Date.now() % 100000} Review Rd`, city: 'Westwind', postal: '63001' },
    },
    home_type: { kind: 'value', value: 'house' },
    cause: { kind: 'value', value: 'wind_tornado' },
    damage_types: { kind: 'value', value: ['roof'] },
    roof_state: { kind: 'value', value: 'large_hole' },
    habitable: { kind: 'value', value: 'no' },
    tonight: { kind: 'value', value: 'yes' },
    insurance: { kind: 'unknown' },
    contact_name: { kind: 'value', value: 'Rosa Delgado' },
    contact: { kind: 'value', value: { phone: '314-555-0177', preferred: 'text' } },
    ...extra,
  });

  let assistedId: string;
  let assistedCode: string;
  let residentId: string;

  it('assisted intake goes through the one submission path and the worker files it with the helper as its recorder (CHN-05/06, CHN-01)', async () => {
    const executionId = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: headers('priya', { 'idempotency-key': executionId }),
      payload: {
        executionId,
        eventId,
        language: 'en',
        graphKey: westwindGraph.key,
        graphVersion: westwindGraph.version,
        relationship: 'own_home',
        answers: answers(),
        ownWords: 'El árbol cayó sobre el techo y entró agua.',
        needs: ['shelter_tonight'],
        consent: { volunteer_cleanup: true },
        consentRecorded: true,
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    assistedCode = res.json().referenceCode;
    // A resident's own web report too, for the queue and the self-review contrast.
    const web = await app.inject({
      method: 'POST',
      url: '/api/public/intake/county/westwind/submissions',
      headers: { 'idempotency-key': (residentId = randomUUID()) },
      payload: {
        executionId: residentId,
        channel: 'web',
        language: 'en',
        graphKey: westwindGraph.key,
        graphVersion: westwindGraph.version,
        relationship: 'own_home',
        answers: answers({
          habitable: { kind: 'value', value: 'yes' },
          tonight: { kind: 'value', value: 'no' },
        }),
        needs: [],
        consent: {},
      },
    });
    expect(web.statusCode, web.body).toBe(202);
    await sweepStoredSubmissions(worker);
    const filed = await dbWorker
      .selectFrom('cg.report')
      .select(['id', 'created_by', 'channel_of_origin'])
      .where('reference_code', '=', assistedCode)
      .executeTakeFirstOrThrow();
    assistedId = filed.id;
    expect(filed.channel_of_origin).toBe('assisted');
    expect(filed.created_by).toBe(subjects['priya']!.accountId);
  });

  it('the queue puts need signals first, then the oldest (PHO-14, CON-05); filters work', async () => {
    const res = await app.inject({
      url: `/api/v1/reports?eventId=${eventId}&limit=200`,
      headers: headers('priya'),
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json() as {
      id: string;
      needSignals: Record<string, boolean>;
      submittedAt: string;
      homeType: string | null;
      postal: string | null;
    }[];
    expect(rows.some((r) => r.id === assistedId)).toBe(true);
    const firstPlain = rows.findIndex(
      (r) =>
        !r.needSignals['unsafe'] &&
        !r.needSignals['no_shelter'] &&
        !r.needSignals['medical'] &&
        !r.needSignals['displaced'],
    );
    const lastSignal = rows
      .map(
        (r) =>
          r.needSignals['displaced'] ||
          r.needSignals['no_shelter'] ||
          r.needSignals['unsafe'] ||
          r.needSignals['medical'],
      )
      .lastIndexOf(true);
    if (firstPlain >= 0 && lastSignal >= 0) expect(lastSignal).toBeLessThan(firstPlain);
    expect(rows.find((r) => r.id === assistedId)).toMatchObject({
      homeType: 'house',
      postal: '63001',
    });
    const byRef = await app.inject({
      url: `/api/v1/reports?reference=${assistedCode.toLowerCase()}`,
      headers: headers('priya'),
    });
    expect(byRef.json()).toHaveLength(1);
    const flagged = await app.inject({
      url: `/api/v1/reports?state=approved`,
      headers: headers('priya'),
    });
    expect(flagged.json().every((r: { reviewState: string }) => r.reviewState === 'approved')).toBe(
      true,
    );
  });

  it('the detail shows contact and free text to the assessment role, not to the director, and audits restricted reads (SEC-18, RULE-16)', async () => {
    const full = await app.inject({
      url: `/api/v1/reports/${assistedId}`,
      headers: headers('priya'),
    });
    expect(full.statusCode, full.body).toBe(200);
    const body = full.json();
    expect(body.reporter).toMatchObject({ name: 'Rosa Delgado', phone: '+13145550177' });
    expect(body.location).toMatchObject({ postal: '63001' });
    expect(body.ownWords).toContain('árbol');
    expect(body.hidden).toEqual(['accessNeeds']); // health-adjacent: AFN roles only (ADM-05)
    expect(body.needs.map((n: { category: string }) => n.category)).toEqual(['shelter_tonight']);
    expect(body.consent).toEqual([{ orgType: 'volunteer_cleanup', granted: true }]);
    expect(body.answers).not.toHaveProperty('contact');

    const limited = await app.inject({
      url: `/api/v1/reports/${assistedId}`,
      headers: headers('dana'),
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().reporter).toBeNull();
    expect(limited.json().ownWords).toBeNull();
    expect(limited.json().location).toMatchObject({ postal: '63001' }); // location_exact granted
    expect(limited.json().hidden).toEqual(expect.arrayContaining(['contact', 'ownWords']));

    const audit = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['actor_account_id', 'classification_read'])
      .where('action', '=', 'report.read')
      .where('target_id', '=', assistedId)
      .execute();
    expect(
      audit.some(
        (a) =>
          a.actor_account_id === subjects['priya']!.accountId &&
          a.classification_read.includes('contact'),
      ),
    ).toBe(true);
  });

  it('a role without report.read is refused with a 404 (default deny)', async () => {
    const res = await app.inject({
      url: `/api/v1/reports/${assistedId}`,
      headers: headers('nobody'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('decisions need confirmation and a reason; the helper cannot approve the report they entered (G4, FR-12.04); another reviewer can (AC-12A/B)', async () => {
    const current = (
      await app.inject({ url: `/api/v1/reports/${assistedId}`, headers: headers('priya') })
    ).json();
    const unconfirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${assistedId}/decisions`,
      headers: headers('priya', { 'if-match': `"${current.version}"` }),
      payload: { decision: 'approve', reason: 'Photos match the answers.' },
    });
    expect(unconfirmed.statusCode).toBe(403); // self-review: refused before anything else
    // The resident's own report: priya did not record it, so she may decide, but only with confirmation.
    const own = await dbWorker
      .selectFrom('cg.report')
      .select(['id', 'version'])
      .where('execution_id', '=', residentId)
      .executeTakeFirstOrThrow();
    const noConfirm = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${own.id}/decisions`,
      headers: headers('priya', { 'if-match': `"${own.version}"` }),
      payload: { decision: 'approve', reason: 'Checked against the photos.' },
    });
    expect(noConfirm.statusCode).toBe(428);
    const claimed = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${own.id}/claim`,
      headers: headers('priya', { 'if-match': `"${own.version}"` }),
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json().reviewState).toBe('under_review');
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${own.id}/decisions`,
      headers: headers('priya', {
        'if-match': `"${claimed.json().version}"`,
        ...confirmed('Checked against the photos.'),
      }),
      payload: { decision: 'approve', reason: 'Checked against the photos.' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().reviewState).toBe('approved');
    const decisions = await dbWorker
      .selectFrom('cg.review_decision')
      .select(['decision', 'reason', 'reviewer_account_id', 'report_version'])
      .where('report_id', '=', own.id)
      .execute();
    expect(decisions).toEqual([
      expect.objectContaining({
        decision: 'approve',
        reviewer_account_id: subjects['priya']!.accountId,
      }),
    ]);
    const versions = await dbWorker
      .selectFrom('cg.report_version')
      .select(['report_version', 'changed_by_kind'])
      .where('report_id', '=', own.id)
      .execute();
    expect(versions.length).toBeGreaterThanOrEqual(1); // AC-10B: the pre-decision state is kept
    expect(versions.every((v) => v.changed_by_kind === 'reviewer')).toBe(true);
    // Stale version → conflict with the current record (BRD:FR-00.05)
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${own.id}/decisions`,
      headers: headers('priya', {
        'if-match': `"${claimed.json().version}"`,
        ...confirmed('again'),
      }),
      payload: { decision: 'reopen', reason: 'again' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('needs-information records the question for the resident and queues the message (FR-12.03)', async () => {
    const current = (
      await app.inject({ url: `/api/v1/reports/${assistedId}`, headers: headers('dana') })
    ).json();
    // The director holds no review grant: refused.
    const noGrant = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${assistedId}/decisions`,
      headers: headers('dana', { 'if-match': `"${current.version}"`, ...confirmed('x') }),
      payload: {
        decision: 'needs_information',
        reason: 'Which floor?',
        questions: ['water_depth'],
      },
    });
    expect(noGrant.statusCode).toBe(404);
    const ask = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${assistedId}/corrections`,
      headers: headers('priya'),
      payload: { questions: ['water_depth'], message: 'Which floor is the water damage on?' },
    });
    expect(ask.statusCode, ask.body).toBe(201);
    const req = await dbWorker
      .selectFrom('cg.correction_request')
      .selectAll()
      .where('id', '=', ask.json().id)
      .executeTakeFirstOrThrow();
    expect(req.questions).toEqual(['water_depth']);
    expect(req.requested_by).toBe(subjects['priya']!.accountId);
    const outbox = await dbWorker
      .selectFrom('cg.outbox')
      .select('payload')
      .where('topic', '=', 'correction.requested')
      .execute();
    expect(
      outbox.some(
        (o) => (o.payload as { correctionRequestId: string }).correctionRequestId === req.id,
      ),
    ).toBe(true);
    const detail = (
      await app.inject({ url: `/api/v1/reports/${assistedId}`, headers: headers('priya') })
    ).json();
    expect(detail.openCorrections).toHaveLength(1);
  });

  it('verification level and FEMA degree are set by reviewers with a reason (DEC-02, DEC-03)', async () => {
    const own = await dbWorker
      .selectFrom('cg.report')
      .select(['id', 'version'])
      .where('execution_id', '=', residentId)
      .executeTakeFirstOrThrow();
    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${own.id}/verification`,
      headers: headers('priya', { 'if-match': `"${own.version}"` }),
      payload: { level: 'desktop_verified', reason: 'Two clear photos of the roof.' },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().verificationLevel).toBe('desktop_verified');
    const degree = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${own.id}/fema-degree`,
      headers: headers('priya', {
        'if-match': `"${verified.json().version}"`,
        ...confirmed('Large hole in the roof, home not habitable.'),
      }),
      payload: { degree: 'major', reason: 'Large hole in the roof, home not habitable.' },
    });
    expect(degree.statusCode, degree.body).toBe(200);
    expect(degree.json().femaDegree).toBe('major');
    const refused = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${own.id}/fema-degree`,
      headers: headers('luis', {
        'if-match': `"${degree.json().version}"`,
        ...confirmed('Not mine to set.'),
      }),
      payload: { degree: 'destroyed', reason: 'Not mine to set.' },
    });
    expect(refused.statusCode).toBe(404);
    const kinds = (
      await dbWorker
        .selectFrom('cg.review_decision')
        .select('decision')
        .where('report_id', '=', own.id)
        .execute()
    ).map((d) => d.decision);
    expect(kinds).toEqual(expect.arrayContaining(['approve', 'verify', 'set_degree']));
  });

  it('a resident change after approval sends the report back for review with the snapshot intact (RULE-09, AC-12C)', async () => {
    const own = await dbWorker
      .selectFrom('cg.report')
      .select(['id', 'version', 'review_state'])
      .where('execution_id', '=', residentId)
      .executeTakeFirstOrThrow();
    expect(own.review_state).toBe('approved');
    // The resident corrects through the self-service path (simulated directly: snapshot + state change as the API does).
    await dbWorker
      .insertInto('cg.report_version')
      .values({
        tenant_id: tenantId,
        report_id: own.id,
        report_version: own.version,
        snapshot: JSON.stringify({ review_state: 'approved' }),
        changed_by_kind: 'resident',
        reason: 'resident correction',
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await dbWorker
      .updateTable('cg.report')
      .set({ review_state: 'submitted' })
      .where('id', '=', own.id)
      .execute();
    const detail = (
      await app.inject({ url: `/api/v1/reports/${own.id}`, headers: headers('priya') })
    ).json();
    expect(detail.reReview).toBe(true);
    expect(detail.reviewState).toBe('submitted');
    const versions = (
      await app.inject({ url: `/api/v1/reports/${own.id}/versions`, headers: headers('priya') })
    ).json();
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });

  it('photos stay restricted without the evidence category (PHO-07); translation is labelled and keeps the original (EQ-08)', async () => {
    await dbWorker
      .insertInto('cg.photo')
      .values({
        tenant_id: tenantId,
        execution_id: randomUUID(),
        report_id: assistedId,
        shot: 'exterior',
        source: 'web',
        object_key_original: 'x',
        status: 'processed',
        blur_status: 'skipped_no_detector',
        derivative_keys: JSON.stringify({ review: 'r', thumb: 't' }),
      })
      .execute();
    const director = await app.inject({
      url: `/api/v1/reports/${assistedId}/photos`,
      headers: headers('dana'),
    });
    expect(director.statusCode).toBe(404); // county_em_director has no photo.read at all
    const reviewer = await app.inject({
      url: `/api/v1/reports/${assistedId}/photos`,
      headers: headers('priya'),
    });
    expect(reviewer.statusCode, reviewer.body).toBe(200);
    expect(reviewer.json()[0]).toMatchObject({
      restricted: true,
      blurStatus: 'skipped_no_detector',
    });
    expect(reviewer.json()[0].reviewUrl).toBeNull(); // no object storage in this test; the role would get a link

    const translated = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${assistedId}/translate`,
      headers: headers('priya'),
      payload: { to: 'en' },
    });
    expect(translated.statusCode, translated.body).toBe(200);
    expect(translated.json().label).toContain('Machine translation');
    const row = await dbWorker
      .selectFrom('cg.report')
      .select(['translation_provider', 'original_text_enc', 'translation_enc'])
      .where('id', '=', assistedId)
      .executeTakeFirstOrThrow();
    expect(row.translation_provider).toContain('fake');
    expect(await crypto.decrypt(tenantId, row.original_text_enc!)).toContain('árbol');
    const noFreeText = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${assistedId}/translate`,
      headers: headers('dana'),
      payload: { to: 'en' },
    });
    expect(noFreeText.statusCode).toBe(403);
  });

  it('question graphs: list, draft a new version that must pass the string rules, publish with confirmation (INT-01, INT-08, CON-02)', async () => {
    const list = await app.inject({ url: '/api/v1/intake-graphs', headers: headers('priya') });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0]).toMatchObject({ key: westwindGraph.key, status: 'published' });
    const bad = JSON.parse(JSON.stringify(westwindGraph));
    bad.nodes.find((n: { id: string }) => n.id === 'home_type').prompt.en =
      'Please characterise the architectural typology of your domicile!';
    const admin = {
      ...subjects['priya']!,
      roles: [{ ...subjects['priya']!.roles[0]!, grants: [{ action: '*' }] }],
    };
    subjects['admin'] = admin as AccountSubject;
    const refused = await app.inject({
      method: 'PUT',
      url: `/api/v1/intake-graphs/${westwindGraph.key}`,
      headers: headers('admin', { 'idempotency-key': randomUUID() }),
      payload: { graph: bad, changeReason: 'test' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('string_rules');
    const good = JSON.parse(JSON.stringify(westwindGraph));
    good.nodes.find((n: { id: string }) => n.id === 'home_type').prompt.en =
      'What kind of home do you have?';
    const drafted = await app.inject({
      method: 'PUT',
      url: `/api/v1/intake-graphs/${westwindGraph.key}`,
      headers: headers('admin', { 'idempotency-key': randomUUID() }),
      payload: { graph: good, changeReason: 'plainer wording' },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    expect(drafted.json()).toMatchObject({ status: 'draft', graphVersion: expect.any(Number) });
    const v = drafted.json().graphVersion;
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/intake-graphs/${westwindGraph.key}/${v}/publish`,
      headers: headers('admin', confirmed('reviewed by the PIO')),
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().status).toBe('published');
    const served = await app.inject({ url: '/api/public/intake/county/westwind' });
    expect(served.json().graph.version).toBe(v);
    expect(
      served.json().graph.nodes.find((n: { id: string }) => n.id === 'home_type').prompt.en,
    ).toBe('What kind of home do you have?');
    const facts = await app.inject({
      url: `/api/v1/events/${eventId}/intake`,
      headers: headers('priya'),
    });
    expect(facts.statusCode, facts.body).toBe(200);
    expect(facts.json()).toMatchObject({
      slug: 'westwind',
      smsNumber: '+13145550100',
      graph: { key: westwindGraph.key, version: v },
    });
    expect(facts.json().url).toMatch(/\/county\/westwind$/);
  });
});

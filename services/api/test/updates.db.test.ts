/**
 * Resident updates, replies and referrals against a real PostgreSQL (FL-10,
 * FL-11, BRD:FR-17.03/17.04/17.05, NED-04, SEC-10/18, AIG-10): county staff
 * send a plain-language update to a resident who opted in to texts; the text
 * goes through the output filter; the worker sends it and records the
 * message; the resident's reply from the same number lands on the report as
 * an inbound message and is acknowledged; both show on the report for a role
 * that may read them; a partner with a grant can send too, a partner without
 * cannot; a referral to an organization the resident consented to is created,
 * notifies that organization, and is accepted and finished by it. Runs only
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
import { sql, type Kysely } from 'kysely';
import { loadSeed, SEED_COUNTY_NUMBER } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../../worker/src/idp/keycloak.ts';
import { sweepStoredSubmissions } from '../../worker/src/jobs/intake.ts';
import { messageSend } from '../../worker/src/jobs/messages.ts';
import { referralCreated } from '../../worker/src/jobs/referrals.ts';
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

interface Msg {
  id: string;
  direction: string;
  template: string;
  state: string;
  body: string | null;
  to: string | null;
}
interface Referral {
  id: string;
  status: string;
  toTenantId: string | null;
  referenceCode: string | null;
  outcome: string | null;
  attempts: unknown[];
}

describe.skipIf(!appUrl || !workerUrl)(
  'resident updates, replies and referrals (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let tenants: Record<string, string>;
    let subjects: Record<string, AccountSubject>;
    const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
    let worker: JobContext;
    const run = Date.now().toString().slice(-7);
    const phone = `+1314562${run.slice(-4)}`;
    const headers = (who: string, extra: Record<string, string> = {}) => ({
      authorization: `Bearer ${who}`,
      ...extra,
    });

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
      const subjectFor = (
        tenantKey: string,
        templateKey: string,
        accountId: string,
      ): AccountSubject => {
        const t = roleTemplates.find((r) => r.key === templateKey)!;
        const tenantId = tenants[tenantKey]!;
        return {
          kind: 'account',
          accountId,
          tenantId,
          tenantPath: paths[tenantId]!,
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
        luis: subjectFor(
          'county',
          'mass_care_coordinator',
          seeded.accounts['luis.masscare@example.org']!,
        ),
        priya: subjectFor(
          'county',
          'damage_assessment_coordinator',
          seeded.accounts['priya.assessment@example.org']!,
        ),
        ruth: subjectFor(
          'canteen',
          'ngo_incident_commander',
          seeded.accounts['ruth.canteen@example.org']!,
        ),
        crew: subjectFor('cleanup', 'cleanup_crew_lead', randomUUID()),
        nurse: subjectFor('shelter-ngo', 'shelter_nurse', seeded.accounts['nurse@example.org']!),
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

    async function outbox(
      topic: string,
      where: (p: Record<string, unknown>) => boolean,
    ): Promise<OutboxMessage[]> {
      const rows = await dbWorker
        .selectFrom('cg.outbox')
        .select(['id', 'tenant_id', 'topic', 'payload', 'execution_id'])
        .where('tenant_id', '=', tenants['county']!)
        .where('topic', '=', topic)
        .orderBy('id')
        .execute();
      return rows
        .map((r) => ({
          id: Number(r.id),
          tenantId: r.tenant_id,
          topic: r.topic,
          payload: r.payload as Record<string, unknown>,
          executionId: r.execution_id,
        }))
        .filter((m) => where(m.payload));
    }

    let reportId: string;
    let code: string;

    it('a resident reports with text opt-in and consent for cleanup and relief partners', async () => {
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
              value: { line1: `${run} Update Ct`, city: 'Westwind', postal: '63003' },
            },
            home_type: { kind: 'value', value: 'house' },
            cause: { kind: 'value', value: 'wind_tornado' },
            damage_types: { kind: 'value', value: ['roof'] },
            roof_state: { kind: 'value', value: 'some_missing' },
            habitable: { kind: 'value', value: 'yes' },
            tonight: { kind: 'value', value: 'no' },
            insurance: { kind: 'unknown' },
            contact_name: { kind: 'value', value: 'Sam Reyes' },
            contact: { kind: 'value', value: { phone, preferred: 'text' } },
          },
          needs: ['cleanup_tarp'],
          consent: { volunteer_cleanup: true, relief_agencies: true },
          smsOptIn: true,
        },
      });
      expect(res.statusCode, res.body).toBe(202);
      code = res.json().referenceCode;
      await sweepStoredSubmissions(worker);
      reportId = (
        await dbWorker
          .selectFrom('cg.report')
          .select('id')
          .where('reference_code', '=', code)
          .executeTakeFirstOrThrow()
      ).id;
    });

    it('county staff send an update by text; the output filter refuses eligibility promises; the worker sends and records it (FL-11, AIG-10)', async () => {
      const refused = await app.inject({
        method: 'POST',
        url: `/api/v1/reports/${reportId}/messages`,
        headers: headers('luis'),
        payload: { text: 'You are eligible for FEMA aid and you will receive a check next week.' },
      });
      expect(refused.statusCode, refused.body).toBe(400);
      const sent = await app.inject({
        method: 'POST',
        url: `/api/v1/reports/${reportId}/messages`,
        headers: headers('luis'),
        payload: {
          text: 'A cleanup crew is scheduled for Tuesday morning. Reply with a time that works.',
        },
      });
      expect(sent.statusCode, sent.body).toBe(202);
      expect(sent.json()).toEqual({ queued: true, channel: 'sms', reason: null });
      const queued = await outbox(
        'message.send',
        (p) => p['template'] === 'staff_update' && p['reportId'] === reportId,
      );
      expect(queued).toHaveLength(1);
      await messageSend(worker, queued[0]!);
      const stored = await dbWorker
        .selectFrom('cg.message')
        .select(['direction', 'state', 'template', 'body_enc'])
        .where('report_id', '=', reportId)
        .executeTakeFirstOrThrow();
      expect(stored.direction).toBe('outbound');
      expect(stored.state).toBe('sent');
      const body = await crypto.decrypt(tenants['county']!, stored.body_enc);
      expect(body).toContain('A cleanup crew is scheduled for Tuesday morning');
      expect(body).toContain(code);
      expect(body).toContain('STOP');
    });

    it("the resident's reply from the same number lands on the report and is acknowledged; the exchange shows to a role that may read it (FR-17.04/17.05, SEC-18)", async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/simulator/sms',
        payload: { from: phone, to: SEED_COUNTY_NUMBER, body: 'Tuesday after 10 works for us' },
      });
      expect(res.statusCode, res.body).toBe(200);
      const replies = res.json().replies as string[];
      expect(replies[0]).toContain(`your message was added to report ${code}`);
      const list = await app.inject({
        url: `/api/v1/reports/${reportId}/messages`,
        headers: headers('luis'),
      });
      expect(list.statusCode, list.body).toBe(200);
      const msgs = list.json() as Msg[];
      expect(msgs.map((m) => [m.direction, m.template, m.state])).toEqual([
        ['inbound', 'reply', 'delivered'],
        ['outbound', 'staff_update', 'sent'],
      ]);
      expect(msgs[0]!.body).toBe('Tuesday after 10 works for us');
      expect(msgs[0]!.to).toBe(phone);
      const audit = await dbWorker
        .selectFrom('cg.audit_event')
        .select('classification_read')
        .where('action', '=', 'message.read')
        .where('target_id', '=', reportId)
        .where('actor_account_id', '=', subjects['luis']!.accountId)
        .executeTakeFirstOrThrow();
      expect(audit.classification_read).toEqual(expect.arrayContaining(['free_text', 'contact']));
      // The same number with a keyword still runs the keyword, never the reply path.
      const help = await app.inject({
        method: 'POST',
        url: '/api/webhooks/simulator/sms',
        payload: { from: phone, to: SEED_COUNTY_NUMBER, body: 'HELP' },
      });
      expect((help.json().replies as string[])[0]).toContain('help line');
    });

    it('a partner with a contact grant can send an update; one without the grant cannot; a partner reads only through its grant (NED-04)', async () => {
      const crew = await app.inject({
        method: 'POST',
        url: `/api/v1/reports/${reportId}/messages`,
        headers: headers('crew'),
        payload: { text: 'Gateway Cleanup here: our crew arrives Tuesday at 10.' },
      });
      expect(crew.statusCode, crew.body).toBe(202);
      expect((crew.json() as { channel: string }).channel).toBe('sms');
      const queued = await outbox(
        'message.send',
        (p) => p['template'] === 'staff_update' && p['reportId'] === reportId,
      );
      expect(queued).toHaveLength(2);
      expect((queued[1]!.payload['variables'] as { sender: string }).sender).toBe(
        'Gateway Cleanup Volunteers',
      );
      const canteen = await app.inject({
        method: 'POST',
        url: `/api/v1/reports/${reportId}/messages`,
        headers: headers('ruth'),
        payload: { text: 'Hope Canteen: meals at noon.' },
      });
      expect(canteen.statusCode).toBe(404); // feeding gets area and need, never contact
      const crewList = await app.inject({
        url: `/api/v1/reports/${reportId}/messages`,
        headers: headers('crew'),
      });
      expect(crewList.statusCode, crewList.body).toBe(200);
      expect((crewList.json() as Msg[]).length).toBeGreaterThanOrEqual(2);
    });

    it('a referral goes only to an organization the resident consented to, notifies it, and is accepted and finished by it (FL-10, FR-17.03)', async () => {
      const noConsent = await app.inject({
        method: 'POST',
        url: '/api/v1/referrals',
        headers: headers('luis'),
        payload: { reportId, toTenantId: tenants['coad'], purpose: 'Coordination' },
      });
      expect(noConsent.statusCode, noConsent.body).toBe(400);
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/referrals',
        headers: headers('luis'),
        payload: {
          reportId,
          toTenantId: tenants['legal'],
          purpose: 'Landlord refuses repairs; needs legal advice on the lease.',
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const ref = created.json() as Referral;
      expect(ref.status).toBe('open');
      expect(ref.referenceCode).toBe(code);
      const notify = await outbox('referral.created', (p) => p['referralId'] === ref.id);
      expect(notify).toHaveLength(1);
      await referralCreated(worker, notify[0]!);
      await referralCreated(worker, notify[0]!); // redelivery queues nothing twice
      const notices = await outbox(
        'message.send',
        (p) => p['template'] === 'referral_notice' && p['referralId'] === ref.id,
      );
      // The legal tenant has no role holding shared.read: the notice goes to its administrator
      // (seeded since 2026-10-13), ahead of the security contact.
      expect(notices).toHaveLength(1);
      expect(
        await crypto.decrypt(
          tenants['county']!,
          Buffer.from(notices[0]!.payload['toEnc'] as string, 'base64'),
        ),
      ).toBe('admin.legal@example.org');

      // Only the receiving organization responds; the county and the crew cannot.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/referrals/${ref.id}/accept`,
            headers: headers('luis'),
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/referrals/${ref.id}/accept`,
            headers: headers('crew'),
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      subjects['attorney'] = {
        ...subjects['nurse']!,
        tenantId: tenants['legal']!,
        accountId: randomUUID(),
        roles: [
          {
            roleId: randomUUID(),
            key: 'legal_aid_attorney',
            version: 1,
            templateKey: 'legal_aid_attorney',
            grants: roleTemplates.find((t) => t.key === 'legal_aid_attorney')!.grants,
            scope: {},
          },
        ],
      };
      const inbox = await app.inject({
        url: '/api/v1/referrals?direction=in',
        headers: headers('attorney'),
      });
      expect(inbox.statusCode, inbox.body).toBe(200);
      expect((inbox.json() as Referral[]).some((r) => r.id === ref.id)).toBe(true);
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/v1/referrals/${ref.id}/accept`,
        headers: headers('attorney'),
        payload: { note: 'Intake call booked' },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((accepted.json() as Referral).status).toBe('accepted');
      const done = await app.inject({
        method: 'POST',
        url: `/api/v1/referrals/${ref.id}/done`,
        headers: headers('attorney'),
        payload: { note: 'Advised on tenant rights; landlord notified in writing.' },
      });
      expect(done.statusCode, done.body).toBe(200);
      const finished = done.json() as Referral;
      expect(finished.status).toBe('done');
      expect(finished.outcome).toContain('tenant rights');
      expect(finished.attempts).toHaveLength(3);
      const mine = await app.inject({
        url: '/api/v1/referrals?direction=out',
        headers: headers('luis'),
      });
      expect((mine.json() as Referral[]).find((r) => r.id === ref.id)?.status).toBe('done');
      const audits = await dbWorker
        .selectFrom('cg.audit_event')
        .select(['action', 'tenant_id'])
        .where('target_id', '=', ref.id)
        .execute();
      expect(audits.map((a) => a.action).sort()).toEqual([
        'referral.create',
        'referral.notified',
        'referral.respond',
        'referral.respond',
      ]);
      expect(audits.every((a) => a.tenant_id === tenants['county'])).toBe(true);
      await sql`select 1`.execute(dbWorker);
    });
  },
);

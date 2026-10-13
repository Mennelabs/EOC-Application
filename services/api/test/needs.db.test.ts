/**
 * Needs board against a real PostgreSQL (CON-08, CON-15, CON-04, NED-02/03,
 * NED-07, AC-17B, SEC-05/06, SEC-18): a household asks for help without a
 * damage report and the worker files standalone needs with their own code,
 * consent rows and partner grants; county staff see the board with who it is
 * shared with; a partner sees only what its grants cover and claims inside
 * the county's record with an audited, attributed history; a second claim on
 * the same address warns; assignment needs the resident's consent; release,
 * done and reopen follow their rules; who sees whose claims is configurable
 * per agency; the CSV export is audited; the key counts add up; NOSHARE by
 * text takes the standalone needs off every partner's board. Runs only with
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
import { sql, type Kysely } from 'kysely';
import { loadSeed, SEED_COUNTY_NUMBER } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../../worker/src/idp/keycloak.ts';
import { sweepStoredSubmissions } from '../../worker/src/jobs/intake.ts';
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

interface Need {
  id: string;
  referenceCode: string | null;
  category: string;
  status: string;
  source: string;
  area: { city: string | null; postal: string | null } | null;
  claimed: boolean;
  claim: { tenantId: string; tenantName: string; accountId: string | null } | null;
  sharedWith: { tenantId: string; name: string }[];
  doneNote: string | null;
}
interface Action {
  need: Need;
  warnings: { kind: string; needId: string; claimedByTenantName: string | null }[];
}

describe.skipIf(!appUrl || !workerUrl)('needs board (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let tenants: Record<string, string>;
  let subjects: Record<string, AccountSubject>;
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  let worker: JobContext;
  const run = Date.now().toString().slice(-7);
  const phone = `+1314561${run.slice(-4)}`;
  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${who}`,
    ...extra,
  });
  const confirmed = (reason: string) => ({ 'x-confirm': 'true', 'x-reason': reason });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    tenants = seeded.tenants;
    // Visibility rules left by an earlier local run would change what this run's partners see.
    await dbWorker
      .deleteFrom('cg.board_visibility')
      .where('subject_key', 'in', [tenants['cleanup']!, tenants['canteen']!])
      .execute();
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
      luis: subjectFor(
        'county',
        'mass_care_coordinator',
        seeded.accounts['luis.masscare@example.org']!,
      ),
      admin: subjectFor('county', 'tenant_admin', seeded.accounts['admin@example.org']!),
      tomas: subjectFor(
        'county',
        'public_information_officer',
        seeded.accounts['tomas.pio@example.org']!,
      ),
      ruth: subjectFor(
        'canteen',
        'ngo_incident_commander',
        seeded.accounts['ruth.canteen@example.org']!,
      ),
      jen: subjectFor('coad', 'coad_chair', seeded.accounts['jen.coad@example.org']!),
      crew: subjectFor('cleanup', 'cleanup_crew_lead', randomUUID()),
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

  const get = async (who: string, url: string, extra: Record<string, string> = {}) => {
    const res = await app.inject({ url, headers: headers(who, extra) });
    return { status: res.statusCode, body: res.body, json: () => res.json() as unknown };
  };
  const post = async (who: string, url: string, payload: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: headers(who),
      payload: payload as Record<string, unknown>,
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() as Action };
  };
  const mine = (rows: Need[]) => rows.filter((n) => n.referenceCode === code);

  let code: string;
  let needIds: string[];
  let executionId: string;

  it('a household asks for help without a damage report: standalone needs, consent, code, grants (NED-02/03)', async () => {
    executionId = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/needs/county/westwind',
      headers: { 'idempotency-key': executionId },
      payload: {
        executionId,
        language: 'en',
        needs: ['food_water', 'cleanup_tarp'],
        note: 'Tree across the drive; two adults, no car.',
        address: { line1: `${run} Standalone Way`, city: 'Harmon City', postal: '63003' },
        contactName: 'Dee Okafor',
        contact: { phone, email: `dee-${run}@example.org`, preferred: 'text' },
        consent: { volunteer_cleanup: true, relief_agencies: true },
        smsOptIn: false,
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    code = res.json().referenceCode;
    await sweepStoredSubmissions(worker);
    const needs = await dbWorker
      .selectFrom('cg.need')
      .select([
        'id',
        'category',
        'status',
        'source',
        'report_id',
        'reference_code',
        'detail',
        'contact_party_id',
        'location_id',
      ])
      .where('execution_id', '=', executionId)
      .orderBy('created_at')
      .execute();
    expect(
      needs.map((n) => [n.category, n.status, n.source, n.report_id, n.reference_code]),
    ).toEqual([
      ['food_water', 'open', 'standalone', null, code],
      ['cleanup_tarp', 'open', 'standalone', null, code],
    ]);
    expect(needs[0]!.detail).toContain('Tree across');
    expect(needs[1]!.detail).toBeNull();
    expect(needs[0]!.location_id).not.toBeNull();
    needIds = needs.map((n) => n.id);
    const consents = await dbWorker
      .selectFrom('cg.consent')
      .select(['org_type', 'granted', 'report_id'])
      .where('party_id', '=', needs[0]!.contact_party_id!)
      .execute();
    expect(consents.map((c) => [c.org_type, c.granted, c.report_id]).sort()).toEqual([
      ['relief_agencies', true, null],
      ['volunteer_cleanup', true, null],
    ]);
    const grants = await dbWorker
      .selectFrom('cg.share_grant')
      .innerJoin('cg.tenant', 'cg.tenant.id', 'cg.share_grant.to_tenant_id')
      .select([
        'cg.tenant.slug as partner',
        'cg.share_grant.need_id as need_id',
        'cg.share_grant.sections as sections',
      ])
      .where('cg.share_grant.need_id', 'in', needIds)
      .where('cg.share_grant.revoked_at', 'is', null)
      .execute();
    const byPartner = (slug: string) => grants.filter((g) => g.partner === slug);
    expect(byPartner('cleanup')).toHaveLength(2);
    expect(byPartner('canteen')).toHaveLength(2);
    expect(byPartner('shelter-ngo').every((g) => !g.sections.includes('access_needs'))).toBe(true);
    expect(byPartner('legal').every((g) => !g.sections.includes('need'))).toBe(true);
    const confirmation = await dbWorker
      .selectFrom('cg.outbox')
      .select('payload')
      .where('tenant_id', '=', tenants['county']!)
      .where('topic', '=', 'message.send')
      .where(sql`payload->>'template'`, '=', 'needs_confirmation')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const payload = confirmation.payload as { toEnc: string; channel: string };
    expect(payload.channel).toBe('email');
    expect(await crypto.decrypt(tenants['county']!, Buffer.from(payload.toEnc, 'base64'))).toBe(
      `dee-${run}@example.org`,
    );
    // A second sweep files nothing twice (BRD:FR-00.06).
    await sweepStoredSubmissions(worker);
    expect(
      (
        await dbWorker
          .selectFrom('cg.need')
          .select('id')
          .where('execution_id', '=', executionId)
          .execute()
      ).length,
    ).toBe(2);
  });

  it('county staff see the board with who it is shared with; a role without need.read is refused (CON-08)', async () => {
    const res = await get('luis', `/api/v1/needs?reference=${code}`);
    expect(res.status, res.body).toBe(200);
    const rows = mine(res.json() as Need[]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.area).toEqual({ city: 'Harmon City', postal: '63003' });
    expect(rows[0]!.claimed).toBe(false);
    expect(rows[0]!.sharedWith.map((p) => p.name).sort()).toEqual([
      'Gateway Cleanup Volunteers',
      'Hope Canteen Services',
      'Prairie Shelter Alliance',
    ]);
    const pio = await get('tomas', '/api/v1/needs');
    expect(pio.status).toBe(403);
  });

  it('a partner sees only what its grants cover and claims inside the county record, attributed and audited (NED-04, SEC-18)', async () => {
    const crew = await get('crew', `/api/v1/needs?reference=${code}`);
    expect(crew.status, crew.body).toBe(200);
    const visible = mine(crew.json() as Need[]);
    expect(visible.map((n) => n.category).sort()).toEqual(['cleanup_tarp', 'food_water']);
    expect(visible[0]!.sharedWith).toEqual([]); // the county's partner list is the county's
    const coad = await get('jen', `/api/v1/needs?reference=${code}`);
    expect(mine(coad.json() as Need[])).toEqual([]); // coordination shares nothing

    const claim = await post('crew', `/api/v1/needs/${needIds[1]}/claim`, {
      note: 'Crew 3 on Tuesday',
    });
    expect(claim.status, claim.body).toBe(200);
    expect(claim.json().need.claim?.tenantName).toBe('Gateway Cleanup Volunteers');
    expect(claim.json().warnings).toEqual([]);
    const events = await dbWorker
      .selectFrom('cg.need_event')
      .select(['kind', 'actor_tenant_id', 'actor_account_id', 'note'])
      .where('need_id', '=', needIds[1]!)
      .execute();
    expect(events).toEqual([
      {
        kind: 'claimed',
        actor_tenant_id: tenants['cleanup'],
        actor_account_id: subjects['crew']!.accountId,
        note: 'Crew 3 on Tuesday',
      },
    ]);
    const audit = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['tenant_id', 'actor_account_id'])
      .where('action', '=', 'need.claimed')
      .where('target_id', '=', needIds[1]!)
      .executeTakeFirstOrThrow();
    expect(audit.tenant_id).toBe(tenants['county']);
    expect(audit.actor_account_id).toBe(subjects['crew']!.accountId);
  });

  it('a second organization claiming at the same address is warned; a claim on a held need conflicts (AC-17B)', async () => {
    const ruth = await post('ruth', `/api/v1/needs/${needIds[0]}/claim`, {});
    expect(ruth.status, ruth.body).toBe(200);
    expect(ruth.json().warnings).toEqual([
      {
        kind: 'same_address',
        needId: needIds[1],
        category: 'cleanup_tarp',
        claimedByTenantName: 'Gateway Cleanup Volunteers',
      },
    ]);
    const again = await post('ruth', `/api/v1/needs/${needIds[1]}/claim`, {});
    expect(again.status).toBe(409);
  });

  it("assignment needs the resident's consent; release, done and reopen follow their rules (NED-07)", async () => {
    const noConsent = await post('luis', `/api/v1/needs/${needIds[0]}/assign`, {
      toTenantId: tenants['legal'],
    });
    expect(noConsent.status, noConsent.body).toBe(400);
    const release = await post('luis', `/api/v1/needs/${needIds[0]}/release`, {
      note: 'Canteen asked to hand it back',
    });
    expect(release.status, release.body).toBe(200);
    expect(release.json().need.status).toBe('open');
    const assign = await post('luis', `/api/v1/needs/${needIds[0]}/assign`, {
      toTenantId: tenants['canteen'],
      note: 'Canteen covers Harmon City',
    });
    expect(assign.status, assign.body).toBe(200);
    expect(assign.json().need.claim?.tenantId).toBe(tenants['canteen']);
    expect(assign.json().warnings.map((w) => w.kind)).toEqual(['same_address']);
    // A partner cannot release or finish another organization's need, nor assign or reopen anything.
    expect((await post('crew', `/api/v1/needs/${needIds[0]}/release`, {})).status).toBe(403);
    expect(
      (await post('crew', `/api/v1/needs/${needIds[0]}/assign`, { toTenantId: tenants['cleanup'] }))
        .status,
    ).toBe(403);
    const done = await post('crew', `/api/v1/needs/${needIds[1]}/done`, {
      note: 'Tarp on, drive cleared',
    });
    expect(done.status, done.body).toBe(200);
    expect(done.json().need.status).toBe('met');
    expect(done.json().need.doneNote).toBe('Tarp on, drive cleared');
    expect(
      (await post('crew', `/api/v1/needs/${needIds[1]}/reopen`, { note: 'not mine' })).status,
    ).toBe(403);
    const reopen = await post('luis', `/api/v1/needs/${needIds[1]}/reopen`, {
      note: 'Tarp blew off overnight',
    });
    expect(reopen.status, reopen.body).toBe(200);
    expect(reopen.json().need.status).toBe('open');
    expect(reopen.json().need.claimed).toBe(false);
    const detail = await get('luis', `/api/v1/needs/${needIds[1]}`);
    expect(detail.status).toBe(200);
    expect((detail.json() as { history: { kind: string }[] }).history.map((h) => h.kind)).toEqual([
      'claimed',
      'done',
      'reopened',
    ]);
  });

  it('who sees whose claims is configured per agency (CON-15)', async () => {
    const before = mine((await get('crew', `/api/v1/needs?reference=${code}`)).json() as Need[]);
    expect(before.find((n) => n.id === needIds[0])!.claim?.tenantName).toBe(
      'Hope Canteen Services',
    );
    const refused = await app.inject({
      method: 'PUT',
      url: '/api/v1/board-visibility',
      headers: headers('luis', confirmed('test')),
      payload: {
        scope: 'agency',
        subjectKey: tenants['cleanup'],
        sees: 'own',
        reason: 'Cleanup crews see their own claims only',
      },
    });
    expect(refused.statusCode).toBe(403);
    const set = await app.inject({
      method: 'PUT',
      url: '/api/v1/board-visibility',
      headers: headers('admin', confirmed('Cleanup crews see their own claims only')),
      payload: {
        scope: 'agency',
        subjectKey: tenants['cleanup'],
        sees: 'own',
        reason: 'Cleanup crews see their own claims only',
      },
    });
    expect(set.statusCode, set.body).toBe(200);
    const after = mine((await get('crew', `/api/v1/needs?reference=${code}`)).json() as Need[]);
    const other = after.find((n) => n.id === needIds[0])!;
    expect(other.claimed).toBe(true);
    expect(other.claim).toBeNull();
    const list = await get('admin', '/api/v1/board-visibility');
    expect(
      (list.json() as { subjectKey: string; sees: string }[]).some(
        (v) => v.subjectKey === tenants['cleanup'] && v.sees === 'own',
      ),
    ).toBe(true);
  });

  it('the CSV export is audited; the key counts add up (NED-07, CON-04)', async () => {
    const unconfirmed = await get('luis', `/api/v1/needs.csv?reference=${code}`);
    expect(unconfirmed.status).toBe(428);
    const csv = await get(
      'luis',
      `/api/v1/needs.csv?reference=${code}`,
      confirmed('Weekly VOAD call'),
    );
    expect(csv.status, csv.body).toBe(200);
    const lines = csv.body.trim().split('\n');
    expect(lines[0]).toContain('id,reference,category,status');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(code);
    const audit = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['reason', 'changes'])
      .where('action', '=', 'need.export')
      .where('actor_account_id', '=', subjects['luis']!.accountId)
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('Weekly VOAD call');
    const exported = await dbWorker
      .selectFrom('cg.need_event')
      .select('kind')
      .where('need_id', 'in', needIds)
      .where('kind', '=', 'exported')
      .execute();
    expect(exported).toHaveLength(2);
    const counts = await get('luis', '/api/v1/dashboard/counts');
    expect(counts.status, counts.body).toBe(200);
    const c = counts.json() as {
      asOf: string;
      needs: { total: number; standalone: number; byStatus: Record<string, number> };
      sites: { byStatus: Record<string, number>; published: number };
      sharing: { activeGrants: number; partners: number };
      claims: { name: string; count: number }[];
    };
    expect(c.needs.standalone).toBeGreaterThanOrEqual(2);
    expect(c.needs.byStatus['claimed']).toBeGreaterThanOrEqual(1);
    expect(c.sites.published).toBeGreaterThanOrEqual(3);
    expect(c.sharing.partners).toBeGreaterThanOrEqual(2);
    expect(c.claims.some((x) => x.name === 'Hope Canteen Services')).toBe(true);
    expect(new Date(c.asOf).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('NOSHARE by text takes standalone needs off every partner board (NED-05)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/simulator/sms',
      payload: { from: phone, to: SEED_COUNTY_NUMBER, body: `NOSHARE ${code}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().replies as string[])[0]).toContain('no longer shared');
    const queued = await dbWorker
      .selectFrom('cg.outbox')
      .select(['id', 'tenant_id', 'topic', 'payload', 'execution_id'])
      .where('topic', '=', 'consent.changed')
      .where('execution_id', '=', executionId)
      .execute();
    expect(queued).toHaveLength(1);
    const msg: OutboxMessage = {
      id: Number(queued[0]!.id),
      tenantId: queued[0]!.tenant_id,
      topic: 'consent.changed',
      payload: queued[0]!.payload as Record<string, unknown>,
      executionId: queued[0]!.execution_id,
    };
    expect(msg.payload['executionId']).toBe(executionId);
    await consentChanged(worker, msg);
    const grants = await dbWorker
      .selectFrom('cg.share_grant')
      .select(['revoked_at', 'revoke_reason'])
      .where('need_id', 'in', needIds)
      .execute();
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.revoked_at !== null && g.revoke_reason === 'consent')).toBe(true);
    expect(mine((await get('crew', `/api/v1/needs?reference=${code}`)).json() as Need[])).toEqual(
      [],
    );
    expect(mine((await get('ruth', `/api/v1/needs?reference=${code}`)).json() as Need[])).toEqual(
      [],
    );
    // The county still sees the needs; the claim stands until the county decides.
    expect(
      mine((await get('luis', `/api/v1/needs?reference=${code}`)).json() as Need[]),
    ).toHaveLength(2);
  });
});

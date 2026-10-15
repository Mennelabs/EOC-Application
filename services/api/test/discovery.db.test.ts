/**
 * Resource discovery against a real PostgreSQL (layer-7 task F; REC-13,
 * REC-14, REC-10, ADM-05). The county administrator names its HSDS
 * directory; a partner posts a service (and a confidential one that must
 * never surface); county EM asks for a run. The worker reads both, leaves out
 * the place already registered, and drafts candidates with their source
 * links, what is known and unknown, the pre-check, and a flag for the one
 * near unmet need in the active event. Planning may reject but not qualify a
 * place in; county EM qualifies one in, which enters the registry. A rejected
 * place stays rejected on the next run, and comes back only once something
 * about it changes. The place near unmet need is raised at once and a digest
 * of what is new goes once per period (REC-14). Web search runs only once the county lists it and the AI
 * use register has it on; its call is recorded, and a closure it reports for a
 * registered place retires the place only when county EM agrees. A role
 * without the actions sees nothing. Runs on a
 * county of its own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { fakeProvider } from '@cg/ai';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';
import { notifyDiscovery, runDiscovery } from '../../worker/src/jobs/discovery.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const FEED = 'https://211.westwind.example.org/hsds/locations';

interface Candidate {
  id: string;
  version: number;
  state: string;
  change: string;
  sourceKind: string;
  sourceName: string | null;
  name: string;
  kind: string;
  facilityId: string | null;
  facilityName: string | null;
  attributes: Record<string, unknown>;
  unknown: string[];
  sourceLinks: string[];
  precheck: Record<string, { fit: string; reasons: string[] }>;
  note: string | null;
  nearUnmetNeed: boolean;
  seenCount: number;
}

describe.skipIf(!appUrl || !workerUrl)('resource discovery (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let partner = '';
  let postedSite = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  // The county's directory as the fake portal serves it; tests change it between runs.
  let directory: unknown[] = [];

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PATCH',
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
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const discover = () =>
    runDiscovery(
      {
        db: dbWorker,
        log: { info() {}, warn() {}, error() {}, debug() {} },
        // The deterministic fake stands in for OpenAI here (tests only, ADR-0043).
        ai: { providerFor: async () => fakeProvider },
      } as unknown as JobContext,
      {
        tenantIds: [county],
        get: async (url) =>
          url === FEED
            ? {
                ok: true,
                body: JSON.stringify({ contents: directory }),
                contentType: 'application/json',
                url,
              }
            : { ok: false, error: 'The feed answered 404.' },
      },
    );
  const pending = async () =>
    (await call('em', 'GET', '/discovery/candidates?state=pending')).body as Candidate[];
  const audits = (action: string) =>
    dbWorker
      .selectFrom('cg.audit_event')
      .select(['action', 'reason'])
      .where('tenant_id', '=', county)
      .where('action', '=', action)
      .execute();

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-discovery-${run}`,
        name: `Exercise discovery county ${run}`,
        status: 'provisioning',
        timezone: 'America/Chicago',
        security_contact_email: `discovery-${run}@example.org`,
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    partner = (
      await dbWorker
        .insertInto('cg.tenant')
        .values({
          kind: 'partner_org',
          parent_id: county,
          slug: `exercise-discovery-partner-${run}`,
          name: `Exercise Hope Relief ${run}`,
          status: 'provisioning',
          timezone: 'America/Chicago',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    directory = [
      {
        id: 'grace',
        name: 'Exercise Grace Fellowship Church',
        latitude: 38.79,
        longitude: -90.85,
        addresses: [
          {
            address_type: 'physical',
            address_1: '12 Exercise Ave',
            city: 'Westwind',
            state_province: 'MO',
            postal_code: '63003',
          },
        ],
        accessibility: [{ description: 'Wheelchair accessible' }],
      },
      {
        id: 'union',
        name: 'Exercise Union Hall',
        latitude: 38.81,
        longitude: -90.8,
        addresses: [{ address_1: '7 Union St', city: 'Harmon City', postal_code: '63005' }],
      },
    ];
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      const place = async (lon: number, lat: number, line1: string, postal: string) =>
        (
          await trx
            .insertInto('cg.location')
            .values({
              tenant_id: county,
              line1,
              city: 'Westwind',
              state: 'MO',
              postal,
              geom: sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)`,
              precision: 'exact',
              source: 'reviewer',
              created_by: ACTOR,
              updated_by: ACTOR,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      // Already in the registry: never proposed again.
      await trx
        .insertInto('cg.facility')
        .values({
          tenant_id: county,
          name: 'Exercise Union Hall',
          kind: 'community_center',
          location_id: await place(-90.8, 38.81, '7 Union St', '63005'),
          source: 'county',
          approved_by: ACTOR,
          approved_at: new Date(),
          created_by: ACTOR,
          updated_by: ACTOR,
        } as never)
        .execute();
      const site = async (name: string, confidential: boolean, locationId: string) =>
        (
          await trx
            .insertInto('cg.site')
            .values({
              tenant_id: county,
              event_id: null,
              kind: 'feeding',
              name,
              slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${run}`,
              location_id: locationId,
              status: 'open',
              capacity: null,
              occupancy: null,
              hours: JSON.stringify({}),
              pets: 'service_animals',
              accessibility: JSON.stringify({ ada: true }),
              medical_power: null,
              transit: null,
              directions: null,
              notes: null,
              confidential,
              lead_contact_id: null,
              last_confirmed_at: null,
              last_confirmed_by: null,
              published_version: null,
              published_at: null,
              unpublished_at: null,
              usng: null,
              operator_tenant_id: partner,
              posted_by_tenant_id: partner,
              created_by: ACTOR,
              updated_by: ACTOR,
            } as never)
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      postedSite = await site(
        'Exercise Hope Kitchen',
        false,
        await place(-90.86, 38.8, '3 Kitchen Rd', '63003'),
      );
      await site(
        'Exercise Safe Harbor House',
        true,
        await place(-90.9, 38.7, '99 Hidden Ln', '63009'),
      );
      // REC-14: an active event with requests for food next to the church.
      const event = (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise discovery storm ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const near = await place(-90.851, 38.791, '20 Exercise Ave', '63003');
      for (let i = 0; i < 3; i++)
        await trx
          .insertInto('cg.need')
          .values({
            tenant_id: county,
            event_id: event,
            category: 'food_water',
            detail: null,
            source: 'staff',
            reference_code: `DSC${run.slice(0, 4).toUpperCase()}${i}`,
            report_id: null,
            subject_party_id: null,
            claimed_by_tenant_id: null,
            claimed_by_account_id: null,
            claimed_at: null,
            assigned_by_account_id: null,
            released_at: null,
            done_at: null,
            done_note: null,
            location_id: near,
            contact_party_id: null,
            execution_id: null,
          })
          .execute();
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
    subjects['admin'] = as('tenant_admin');
    subjects['em'] = as('county_em_director');
    subjects['planning'] = as('planning_gis_lead');
    subjects['pio'] = as('public_information_officer');
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
      fieldCrypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
      subjects: loader,
      routes: routesWith(),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', 'in', [county, partner])
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('REC-13, ADM-05: the administrator names the county directory; an inside address is refused', async () => {
    const bad = await call('admin', 'POST', '/discovery/sources', {
      kind: 'hsds',
      name: 'Exercise inside',
      url: 'https://10.0.0.8/locations',
    });
    expect(bad.status).toBe(400);
    const made = await call('admin', 'POST', '/discovery/sources', {
      kind: 'hsds',
      name: 'Exercise 211 directory',
      url: FEED,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ kind: 'hsds', enabled: true, lastRunAt: null });
    // A broken feed is listed too: its failure is said in words, the others still count.
    await call('admin', 'POST', '/discovery/sources', {
      kind: 'csv',
      name: 'Exercise open data',
      url: 'https://data.westwind.example.gov/missing.csv',
    });
    expect((await call('pio', 'GET', '/discovery/sources')).status).toBe(403);
    expect(
      (await call('planning', 'POST', '/discovery/sources', { kind: 'web_search', name: 'Web' }))
        .status,
    ).toBe(403);
  });

  it('REC-13, REC-14: a run drafts the partner post and the new place, never the registered or the confidential one', async () => {
    const asked = await call('em', 'POST', '/discovery/runs');
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ state: 'requested' });
    expect(await discover()).toBe(2);
    const list = await pending();
    expect(list.map((c) => c.name).sort()).toEqual([
      'Exercise Grace Fellowship Church',
      'Exercise Hope Kitchen',
    ]);
    const grace = list.find((c) => c.name === 'Exercise Grace Fellowship Church')!;
    expect(grace).toMatchObject({
      sourceKind: 'hsds',
      sourceName: 'Exercise 211 directory',
      kind: 'place_of_worship',
      attributes: { ada: true },
      sourceLinks: [`${FEED}#grace`],
      nearUnmetNeed: true,
    });
    expect(grace.unknown).toContain('sqft');
    expect(grace.precheck['shelter']!.fit).toBe('needs_information');
    // High-value candidates come first.
    expect(list[0]!.name).toBe('Exercise Grace Fellowship Church');
    const kitchen = list.find((c) => c.name === 'Exercise Hope Kitchen')!;
    expect(kitchen).toMatchObject({ sourceKind: 'partner_post', sourceName: 'Partner posts' });
    expect(kitchen.note).toContain(`Posted by Exercise Hope Relief ${run} as a feeding site`);
    const runs = (await call('em', 'GET', '/discovery/runs')).body as {
      state: string;
      summary: { alreadyRegistered: number; sources: { name: string; outcome: string }[] };
    }[];
    expect(runs[0]).toMatchObject({ state: 'done', summary: { alreadyRegistered: 1 } });
    expect(runs[0]!.summary.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Exercise 211 directory', outcome: 'Read 2 places.' }),
        expect.objectContaining({ name: 'Exercise open data', outcome: 'The feed answered 404.' }),
      ]),
    );
    expect(await audits('discovery.run')).toHaveLength(1);
  });

  it('REC-14: the place near unmet need is raised at once; a digest of what is new goes once per period', async () => {
    const notify = () =>
      notifyDiscovery(
        {
          db: dbWorker,
          log: { info() {}, warn() {}, error() {}, debug() {} },
          crypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
        } as unknown as JobContext,
        { tenantIds: [county] },
      );
    // Both places are within 3 km of the food requests: two alerts and one digest. No reviewer
    // accounts in this county, so the security contact hears (one email each).
    expect(await notify()).toBe(3);
    const notices = await dbWorker
      .selectFrom('cg.notice_log')
      .select(['kind', 'subject_kind', 'cycle_key', 'recipient_count'])
      .where('tenant_id', '=', county)
      .where('kind', 'in', ['discovery_alert', 'discovery_digest'])
      .orderBy('kind')
      .execute();
    const alert = {
      kind: 'discovery_alert',
      subject_kind: 'discovery_candidate',
      cycle_key: 'once',
      recipient_count: 1,
    };
    expect(notices).toEqual([
      alert,
      alert,
      {
        kind: 'discovery_digest',
        subject_kind: 'tenant',
        // An event is active: daily.
        cycle_key: new Date().toISOString().slice(0, 10),
        recipient_count: 1,
      },
    ]);
    // Nothing new: no second alert, no second digest.
    expect(await notify()).toBe(0);
    expect(await audits('discovery.alerted')).toHaveLength(2);
    expect(await audits('discovery.digest')).toHaveLength(1);
  });

  it('REC-13: planning may set a place aside but not qualify one in; county EM qualifies it into the registry', async () => {
    const list = await pending();
    const grace = list.find((c) => c.name === 'Exercise Grace Fellowship Church')!;
    const kitchen = list.find((c) => c.name === 'Exercise Hope Kitchen')!;
    const decide = (who: string, c: Candidate, body: unknown) =>
      call(who, 'POST', `/discovery/candidates/${c.id}/decision`, body, {
        'if-match': `"${c.version}"`,
      });
    expect(
      (await decide('planning', grace, { decision: 'accept', reason: 'Exercise: looks good' }))
        .status,
    ).toBe(403);
    const accepted = await decide('em', grace, {
      decision: 'accept',
      reason: 'Exercise: called the church office',
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const facilityId = (accepted.body as Candidate).facilityId!;
    const f = await dbWorker
      .selectFrom('cg.facility')
      .select(['name', 'source', 'approved_by', 'ada', 'sqft', 'notes'])
      .where('id', '=', facilityId)
      .executeTakeFirstOrThrow();
    expect(f).toMatchObject({
      name: 'Exercise Grace Fellowship Church',
      source: 'discovery',
      approved_by: subjects['em']!.accountId,
      ada: true,
      sqft: null,
    });
    expect(f.notes).toContain(`${FEED}#grace`);
    const rejected = await decide('planning', kitchen, {
      decision: 'reject',
      reason: 'Exercise: a feeding site, not a building we can use',
    });
    expect(rejected.body).toMatchObject({ state: 'rejected' });
    expect(await audits('discovery.accept')).toHaveLength(1);
    expect(await audits('discovery.reject')).toHaveLength(1);
    expect(await audits('facility.create')).toHaveLength(1);
  });

  it('REC-13: the next run proposes neither again; a change to the rejected place brings it back', async () => {
    await call('em', 'POST', '/discovery/runs');
    expect(await discover()).toBe(0);
    expect(await pending()).toEqual([]);
    const summary = (
      (await call('em', 'GET', '/discovery/runs')).body as {
        summary: { rememberedRejected: number; alreadyRegistered: number };
      }[]
    )[0]!.summary;
    expect(summary).toMatchObject({ rememberedRejected: 1, alreadyRegistered: 2 });

    // The partner adds pet care at the kitchen: something about it changed.
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx.updateTable('cg.site').set({ pets: 'no' }).where('id', '=', postedSite).execute(),
    );
    await call('em', 'POST', '/discovery/runs');
    expect(await discover()).toBe(1);
    const back = await pending();
    expect(back).toHaveLength(1);
    expect(back[0]!.note).toMatch(/^Set aside on \d{4}-\d{2}-\d{2}; found again with changes\./);
  });

  it('REC-13, AIG-01, AIG-06: web search runs only once listed and switched on; a reported closure is a change for a person to decide', async () => {
    const lodge = await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: county,
          key: 'discovery.area',
          value: JSON.stringify('Westwind County, Missouri'),
          created_by: ACTOR,
          updated_by: ACTOR,
        })
        .execute();
      return (
        await trx
          .insertInto('cg.facility')
          .values({
            tenant_id: county,
            name: 'Exercise Closed Lodge',
            kind: 'other',
            source: 'county',
            approved_by: ACTOR,
            approved_at: new Date(),
            created_by: ACTOR,
            updated_by: ACTOR,
          } as never)
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    const listed = await call('admin', 'POST', '/discovery/sources', {
      kind: 'web_search',
      name: 'Web search',
    });
    expect(listed.status, JSON.stringify(listed.body)).toBe(201);
    expect(
      (await call('admin', 'POST', '/discovery/sources', { kind: 'web_search', name: 'Again' }))
        .status,
    ).toBe(409);
    // Listed, but off in the AI use register: it says so and finds nothing.
    await call('em', 'POST', '/discovery/runs');
    expect(await discover()).toBe(0);
    const off = (
      (await call('em', 'GET', '/discovery/runs')).body as {
        summary: { sources: { name: string; outcome: string }[] };
      }[]
    )[0]!.summary.sources;
    expect(off).toContainEqual(
      expect.objectContaining({
        name: 'Web search',
        outcome: 'Web search is switched off in the AI use register.',
      }),
    );
    // The administrator switches it on once the provider passed the evaluation (AIG-08).
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.ai_use_register')
        .values({
          tenant_id: county,
          feature: 'discovery.web_search',
          provider: 'fake',
          model: 'keyword-rules',
          model_version: null,
          data_sent: 'The area, the kinds of place and registered public places',
          decision_informed: 'Candidates for the review queue',
          human_checkpoint: 'County EM decides',
          owner: 'Planning',
          evaluation: JSON.stringify({}),
          enabled: true,
          created_by: ACTOR,
          updated_by: ACTOR,
        })
        .execute(),
    );
    await call('em', 'POST', '/discovery/runs');
    expect(await discover()).toBe(2);
    const found = (await pending()).filter((c) => c.sourceKind === 'web_search');
    const hall = found.find((c) => c.change === 'new')!;
    expect(hall).toMatchObject({
      name: 'Exercise Westwind County Community Hall',
      kind: 'community_center',
      sourceName: 'Web search',
      sourceLinks: ['https://example.org/exercise-community-hall'],
      attributes: { kitchen: true },
    });
    const closure = found.find((c) => c.change === 'closed')!;
    expect(closure).toMatchObject({ facilityId: lodge, facilityName: 'Exercise Closed Lodge' });
    // AIG-01: the search's record, with the provider and model that answered.
    const records = await dbWorker
      .selectFrom('cg.ai_output')
      .select(['outcome', 'provider', 'model', 'target_type'])
      .where('tenant_id', '=', county)
      .where('feature', '=', 'discovery.web_search')
      .execute();
    expect(records).toEqual([
      { outcome: 'ok', provider: 'fake', model: 'keyword-rules', target_type: 'discovery_run' },
    ]);
    // The closure retires the place only on county EM's decision.
    const decided = await call(
      'em',
      'POST',
      `/discovery/candidates/${closure.id}/decision`,
      { decision: 'accept', reason: 'Exercise: confirmed with the lodge secretary' },
      { 'if-match': `"${closure.version}"` },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const after = await dbWorker
      .selectFrom('cg.facility')
      .select('status')
      .where('id', '=', lodge)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('retired');
    expect(await audits('facility.retire')).toHaveLength(1);
  });

  it('a role without the actions sees nothing', async () => {
    expect((await call('pio', 'GET', '/discovery/candidates')).status).toBe(403);
    expect((await call('pio', 'POST', '/discovery/runs')).status).toBe(403);
  });
});

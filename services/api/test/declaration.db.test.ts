/**
 * The declaration view and its records against a real PostgreSQL (layer-6
 * task D; DCL:DEC-05–DEC-11, DEC-14, DEC-16, DEC-17, FL-17, FR-00.05/06,
 * RULE-02): verified damage from the counting rule, the area profile, the
 * outage log with 72-hour flags and confirmed suggestions, official casualty
 * counts (append-only, explicit grant, official source), public damage sites
 * rolled up against per-capita indicators, donated volunteer hours, and the
 * 30-day clock from the incident end date; every write audited. Runs in its
 * own exercise county; only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { connectorFor, createRecordedHttp, recordingsDir, runPull } from '@cg/refdata';
import { countDamage, loadDamageRecords } from '@cg/reporting';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { assignBatch } from '../../worker/src/jobs/geography.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';
import { filingClock } from '../src/routes/declaration.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const HOUR = 3_600_000;

/** The parts of the declaration view these tests read. */
interface Partners {
  rollup: { all: boolean; partners: { id: string }[]; categories: string[]; statement: string };
  organizations: { id: string; organization: string }[];
  byOrganization: {
    id: string;
    organization: string;
    needsMet: number | null;
    services: Record<string, number> | null;
    teams: number | null;
  }[];
  totals: Record<string, number | null>;
}
interface DeclarationView {
  partners: Partners;
  damage: {
    counted: { units: number; byDegree: Record<string, number> };
    shownSeparately: unknown;
  };
  profile: { basis: string };
  declaration: unknown;
  clock: { incidentEnd: string; daysLeft: number; overdue: boolean } | null;
  outages: { open: number; over72Hours: number; unconfirmed: number };
  casualties: Record<string, unknown>;
  publicAssistance: {
    sites: number;
    totalCost: number;
    verifiedCost: number;
    byCategory: Record<string, { sites: number; cost: number }>;
    indicators: {
      countyPopulation: number;
      countyThreshold: number;
      stateThreshold: number;
      meetsCounty: boolean;
      meetsState: boolean;
    };
  };
  donated: {
    volunteerHours: number;
    includesOpenShifts: boolean;
    byOrganization: { organization: string }[];
    equipment: { organization: string; team: string; item: string; hours: number }[];
  };
}
/** A created or changed record: its id and version, and whatever else it carries. */
type Saved = Record<string, unknown> & { id: string; version: number };

describe.skipIf(!appUrl || !workerUrl)('the declaration view (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let partner = '';
  let eventId = '';
  const run = randomUUID().slice(0, 8);
  const tx = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(dbWorker, { tenantId }, fn);
  let countyPath = '';
  /** As the API runs: the application role, in a tenant's context. */
  const asApp = <T>(
    tenantId: string,
    fn: Parameters<typeof withTenant<T>>[2],
    tenantPath?: string,
  ) => withTenant(dbApp, { tenantId, ...(tenantPath ? { tenantPath } : {}) }, fn);

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const newTenant = (kind: 'county' | 'partner_org', parent: string, slug: string) =>
      dbWorker
        .insertInto('cg.tenant')
        .values({
          kind,
          parent_id: parent,
          slug: `exercise-decl-${slug}-${run}`,
          name: `Exercise ${slug} ${run}`,
          status: 'provisioning',
        })
        .returning(['id', 'path', 'kind'])
        .executeTakeFirstOrThrow();
    const c = await newTenant('county', seeded.tenants['region']!, 'county');
    county = c.id;
    countyPath = c.path;
    partner = (await newTenant('partner_org', county, 'partner')).id;
    eventId = await tx(county, async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values([
          { tenant_id: county, key: 'refdata.enabled', value: JSON.stringify(false) },
          {
            tenant_id: county,
            key: 'declaration.pa_indicators',
            value: JSON.stringify({
              statewidePerCapita: 1.89,
              countywidePerCapita: 4.72,
              statePopulation: 6_200_000,
              fiscalYear: 'FY2026 (exercise)',
            }),
          },
        ])
        .execute();
      return (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise declaration event ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    for (const dataset of ['tract', 'tract_profile'] as const) {
      const conn = connectorFor(dataset);
      if (!conn || conn === 'import') throw new Error(`no ${dataset} connector`);
      await runPull(dbWorker, conn, {
        tenantId: county,
        mode: 'recorded',
        http: createRecordedHttp(recordingsDir),
        scope: { stateFips: '29', countyFips: ['29999'] },
        secrets: {},
        now: () => new Date(),
      });
    }
    await loadDamageReports(dbWorker, {
      tenantId: county,
      eventId,
      reviewerId: randomUUID(),
      count: 60,
      tag: run,
    });
    while ((await assignBatch({ db: dbWorker } as JobContext, county)) > 0);

    // FL-17: a partner organization's crew, a registered walk-up volunteer, county staff.
    const shift = async (tenantId: string, name: string, hours: number, volunteer = false) =>
      tx(tenantId, async (trx) => {
        const p = await trx
          .insertInto('cg.personnel')
          .values({ tenant_id: tenantId, name: `${name} ${run}` })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (volunteer)
          await trx
            .insertInto('cg.volunteer_registration')
            .values({ tenant_id: tenantId, event_id: eventId, personnel_id: p.id })
            .execute();
        await trx
          .insertInto('cg.check_in')
          .values({
            tenant_id: tenantId,
            personnel_id: p.id,
            event_id: eventId,
            agency_tenant_id: tenantId,
            method: 'console',
            started_at: new Date(Date.now() - hours * HOUR),
            ended_at: new Date(),
            end_reason: 'checked_out',
          })
          .execute();
      });
    await shift(partner, 'Exercise chainsaw crew member', 6);
    await shift(county, 'Exercise walk-up volunteer', 4, true);
    await shift(county, 'Exercise county staff member', 10);

    const subject = (template: string): AccountSubject => {
      const r = roleTemplates.find((x) => x.key === template)!;
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
      director: subject('county_em_director'),
      coordinator: subject('damage_assessment_coordinator'),
      admin: subject('tenant_admin'),
      assessor: subject('damage_assessor'),
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
      .where('slug', 'like', `exercise-decl-%-${run}`)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const call = async <T = Record<string, unknown>>(
    who: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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
    return { status: res.statusCode, body: res.json() as T };
  };
  const view = () => call<DeclarationView>('director', 'GET', `/events/${eventId}/declaration`);
  const audited = (action: string) =>
    tx(county, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select('target_id')
        .where('tenant_id', '=', county)
        .where('action', '=', action)
        .execute(),
    );

  it('shows verified damage exactly as the counting rule gives it, with the area profile (DEC-05, DEC-06)', async () => {
    const v = await view();
    expect(v.status).toBe(200);
    const direct = countDamage(
      await withTenant(dbApp, { tenantId: county }, (trx) => loadDamageRecords(trx, eventId)),
    );
    expect(v.body.damage.counted.units).toBe(direct.counted.units);
    expect(v.body.damage.counted.byDegree).toEqual(direct.counted.byDegree);
    expect(v.body.damage.shownSeparately).toEqual(direct.shownSeparately);
    expect(v.body.profile).toMatchObject({ basis: 'reports' });
    expect(v.body.declaration).toBeNull();
    expect(v.body.clock).toBeNull();
    // A role without the grant gets nothing.
    expect((await call('assessor', 'GET', `/events/${eventId}/declaration`)).status).toBe(403);
  });

  it('keeps the incident period and drafts staff enter, with versions and limits (DEC-14, DEC-16, FR-00.05)', async () => {
    const end = new Date(Date.now() - 10 * 24 * HOUR).toISOString().slice(0, 10);
    const start = new Date(Date.now() - 12 * 24 * HOUR).toISOString().slice(0, 10);
    const created = await call<Saved>('director', 'PUT', `/events/${eventId}/declaration`, {
      incidentType: 'Severe Storm',
      incidentStart: start,
      incidentEnd: end,
      requestedAreas: [{ name: 'Exercise county', programs: ['IA', 'PA'] }],
      box8Draft: 'Exercise draft: tornado damage across the county (synthetic).',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ incidentEnd: end, reviewLabel: 'Draft for state review' });
    const noVersion = await call('director', 'PUT', `/events/${eventId}/declaration`, {
      box9Draft: 'x',
    });
    expect(noVersion.status).toBe(428);
    const tooLong = await call(
      'director',
      'PUT',
      `/events/${eventId}/declaration`,
      { box9Draft: 'x'.repeat(3001) },
      { 'if-match': `"${created.body.version}"` },
    );
    expect(tooLong.status).toBe(400);
    const backwards = await call(
      'director',
      'PUT',
      `/events/${eventId}/declaration`,
      { incidentStart: end, incidentEnd: start },
      { 'if-match': `"${created.body.version}"` },
    );
    expect(backwards.status).toBe(400);
    const updated = await call<Saved>(
      'director',
      'PUT',
      `/events/${eventId}/declaration`,
      { box9Draft: 'Exercise draft: partners committed shelters and meals.' },
      { 'if-match': `"${created.body.version}"` },
    );
    expect(updated.status).toBe(200);
    const v = await view();
    expect(v.body.clock).toMatchObject({ incidentEnd: end, daysLeft: 20, overdue: false });
    expect(
      (await call('coordinator', 'PUT', `/events/${eventId}/declaration`, { box8Draft: 'y' }))
        .status,
    ).toBe(403);
    expect(await audited('declaration.write')).toHaveLength(2);
  });

  it('logs outages, flags those over 72 hours, and counts a feed suggestion only once a person confirms it (DEC-07)', async () => {
    const clientUuid = randomUUID();
    const water = {
      clientUuid,
      kind: 'water',
      facilityName: 'Exercise water plant',
      startedAt: new Date(Date.now() - 80 * HOUR).toISOString(),
    };
    const first = await call<Saved>('director', 'POST', `/events/${eventId}/outages`, water);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ over72Hours: true, confirmed: true });
    const again = await call<Saved>('director', 'POST', `/events/${eventId}/outages`, water);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const power = await call<Saved>('director', 'POST', `/events/${eventId}/outages`, {
      clientUuid: randomUUID(),
      kind: 'power',
      area: 'Exercise north feeder',
      customersOut: 1200,
      startedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
      source: 'feed_suggestion',
    });
    expect(power.body).toMatchObject({ confirmed: false, over72Hours: false });
    let v = await view();
    expect(v.body.outages).toMatchObject({ open: 2, over72Hours: 1, unconfirmed: 1 });
    const confirmed = await call<Saved>(
      'director',
      'POST',
      `/outages/${power.body.id}/confirm`,
      {},
      { 'if-match': `"${power.body.version}"` },
    );
    expect(confirmed.body['confirmed']).toBe(true);
    const bad = await call(
      'director',
      'PATCH',
      `/outages/${first.body.id}`,
      { restoredAt: new Date(Date.now() - 90 * HOUR).toISOString() },
      { 'if-match': `"${first.body.version}"` },
    );
    expect(bad.status).toBe(400);
    const restored = await call<Saved>(
      'director',
      'PATCH',
      `/outages/${first.body.id}`,
      { restoredAt: new Date().toISOString() },
      { 'if-match': `"${first.body.version}"` },
    );
    expect(restored.body).toMatchObject({ over72Hours: true });
    v = await view();
    expect(v.body.outages).toMatchObject({ open: 1, unconfirmed: 0 });
  });

  it('takes casualty counts only from roles that name the grant, with an official source, append-only (DEC-08)', async () => {
    const asOf = new Date(Date.now() - 2 * HOUR).toISOString();
    const first = await call('director', 'POST', `/events/${eventId}/casualties`, {
      kind: 'injured',
      count: 3,
      officialSource: 'Exercise county coroner and hospital report',
      asOf,
    });
    expect(first.status).toBe(201);
    const corrected = await call('director', 'POST', `/events/${eventId}/casualties`, {
      kind: 'injured',
      count: 4,
      officialSource: 'Exercise hospital update',
      asOf: new Date().toISOString(),
    });
    expect(corrected.status).toBe(201);
    expect(
      (
        await call('director', 'POST', `/events/${eventId}/casualties`, {
          kind: 'injured',
          count: 1,
          officialSource: 'x',
          asOf,
        })
      ).status,
    ).toBe(400);
    // A tenant administrator's wildcard does not reach it; neither does a coordinator's role.
    expect(
      (
        await call('admin', 'POST', `/events/${eventId}/casualties`, {
          kind: 'missing',
          count: 1,
          officialSource: 'Exercise sheriff',
          asOf,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('coordinator', 'POST', `/events/${eventId}/casualties`, {
          kind: 'missing',
          count: 1,
          officialSource: 'Exercise sheriff',
          asOf,
        })
      ).status,
    ).toBe(403);
    const v = await view();
    expect(v.body.casualties).toMatchObject({
      injured: { count: 4, officialSource: 'Exercise hospital update', entries: 2 },
      missing: null,
      deceased: null,
    });
    // Corrections are new entries; staff sessions cannot change the earlier one.
    const changed = await withTenant(dbApp, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.casualty_count')
        .set({ count: 99 })
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
    );
    expect(Number(changed.numUpdatedRows)).toBe(0);
  });

  it('rolls public damage up by category against the per-capita indicators (DEC-10, DEC-17)', async () => {
    const site = (category: string, cost: number, extra: Record<string, unknown> = {}) =>
      call<Saved>('coordinator', 'POST', `/events/${eventId}/pa-sites`, {
        clientUuid: randomUUID(),
        applicant: 'Exercise county',
        name: `Exercise site ${category}`,
        category,
        estimatedCost: cost,
        position: { lat: 38.79, lon: -90.86 },
        ...extra,
      });
    const debris = await site('A', 250_000, {
      percentComplete: 40,
      insured: 'no',
      debrisCubicYards: 12_000,
    });
    expect(debris.status).toBe(201);
    expect(debris.body).toMatchObject({
      costBasis: 'estimate',
      insured: 'no',
      otherFederalAgency: 'unknown',
      percentComplete: 40,
    });
    await site('C', 90_000, { costBasis: 'verified' });
    const gone = await site('G', 5_000_000);
    await call(
      'coordinator',
      'PATCH',
      `/pa-sites/${gone.body.id}`,
      { status: 'withdrawn' },
      { 'if-match': `"${gone.body.version}"` },
    );
    expect(
      (
        await call('coordinator', 'POST', `/events/${eventId}/pa-sites`, {
          clientUuid: randomUUID(),
          applicant: 'x',
          name: 'y',
          category: 'H',
        })
      ).status,
    ).toBe(400);
    const pa = (await view()).body.publicAssistance;
    expect(pa).toMatchObject({ sites: 2, totalCost: 340_000, verifiedCost: 90_000 });
    expect(pa.byCategory.A).toEqual({ sites: 1, cost: 250_000 });
    expect(pa.indicators.countyPopulation).toBeGreaterThan(0);
    expect(pa.indicators.countyThreshold).toBeCloseTo(4.72 * pa.indicators.countyPopulation, 2);
    expect(pa.indicators.stateThreshold).toBeCloseTo(1.89 * 6_200_000, 2);
    expect(pa.indicators.meetsCounty).toBe(340_000 >= pa.indicators.countyThreshold);
    expect(pa.indicators.meetsState).toBe(false);
  });

  it('counts donated volunteer hours from check-ins: partners and registered volunteers, not county staff (FL-17)', async () => {
    const d = (await view()).body.donated;
    expect(d.volunteerHours).toBeCloseTo(10, 0);
    expect(d.byOrganization.map((o: { organization: string }) => o.organization).sort()).toEqual(
      [`Exercise partner ${run}`, 'Registered volunteers'].sort(),
    );
    expect(d.includesOpenShifts).toBe(false);
  });

  it('summarizes what partner organizations committed from their own records, counts only (DCL:DEC-09)', async () => {
    await tx(partner, async (trx) => {
      const team = await trx
        .insertInto('cg.team')
        .values({
          tenant_id: partner,
          event_id: eventId,
          key: `pc-${run}`,
          name: `Exercise canteen team ${run}`,
          agency_tenant_id: partner,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const crew = await trx
        .insertInto('cg.personnel')
        .values({ tenant_id: partner, name: `Exercise canteen cook ${run}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('cg.check_in')
        .values({
          tenant_id: partner,
          personnel_id: crew.id,
          event_id: eventId,
          agency_tenant_id: partner,
          team_id: team.id,
          method: 'console',
          started_at: new Date(Date.now() - 2 * HOUR),
          ended_at: new Date(),
          end_reason: 'checked_out',
        })
        .execute();
    });
    const team = await tx(partner, (trx) =>
      trx
        .selectFrom('cg.team')
        .select('id')
        .where('key', '=', `pc-${run}`)
        .executeTakeFirstOrThrow(),
    );
    await tx(county, async (trx) => {
      // The county's distribution point logs what the partner's team handed out.
      for (const [kind, count] of [
        ['meal', 40],
        ['water_case', 10],
        ['person_served', 25],
      ] as const)
        await trx
          .insertInto('cg.service_log')
          .values({
            tenant_id: county,
            event_id: eventId,
            client_uuid: randomUUID(),
            kind,
            count,
            team_id: team.id,
          })
          .execute();
      await trx
        .insertInto('cg.need')
        .values({
          tenant_id: county,
          event_id: eventId,
          category: 'food',
          status: 'met',
          claimed_by_tenant_id: partner,
          done_at: new Date(),
        })
        .execute();
      const site = await trx
        .insertInto('cg.site')
        .values({
          tenant_id: county,
          event_id: eventId,
          kind: 'shelter',
          name: `Exercise partner shelter ${run}`,
          slug: `pshelter-${run}`,
          operator_tenant_id: partner,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const size of [3, 2])
        await trx
          .insertInto('cg.shelter_stay')
          .values({ tenant_id: county, site_id: site.id, event_id: eventId, household_size: size })
          .execute();
    });
    const p = (await view()).body.partners;
    expect(p.byOrganization.map((o) => o.organization)).toEqual([`Exercise partner ${run}`]);
    expect(p.totals).toMatchObject({
      needsMet: 1,
      meals: 40,
      waterCases: 10,
      peopleServed: 25,
      shelteredHouseholds: 2,
      shelteredPeople: 5,
      teams: 1,
    });
    // 2026-10-15: a log the partner keeps under its own accounts counts too, through the
    // counting function (numbers only); before, the county saw only what it could read.
    await tx(partner, (trx) =>
      trx
        .insertInto('cg.service_log')
        .values({
          tenant_id: partner,
          event_id: eventId,
          client_uuid: randomUUID(),
          kind: 'meal',
          count: 999,
          team_id: team.id,
        })
        .execute(),
    );
    expect((await view()).body.partners.totals['meals']).toBe(1039);
    // Counts and organizations only: no household detail.
    expect(JSON.stringify(p)).not.toMatch(/household_party|wristband|access_needs/);
  });

  it('lists donated equipment with its team’s hours on duty, overlaps counted once (FL-17)', async () => {
    await tx(partner, async (trx) => {
      const team = await trx
        .updateTable('cg.team')
        .set({ equipment: ['2 chainsaws', 'pickup with trailer'] })
        .where('key', '=', `pc-${run}`)
        .returning('id')
        .executeTakeFirstOrThrow();
      // A second member on duty from three hours ago to an hour ago: with the first
      // member's two hours (to now), the team was on duty for three hours.
      const p = await trx
        .insertInto('cg.personnel')
        .values({ tenant_id: partner, name: `Exercise canteen driver ${run}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('cg.check_in')
        .values({
          tenant_id: partner,
          personnel_id: p.id,
          event_id: eventId,
          agency_tenant_id: partner,
          team_id: team.id,
          method: 'console',
          started_at: new Date(Date.now() - 3 * HOUR),
          ended_at: new Date(Date.now() - HOUR),
          end_reason: 'checked_out',
        })
        .execute();
    });
    const e = (await view()).body.donated.equipment;
    expect(e.map((x) => x.item).sort()).toEqual(['2 chainsaws', 'pickup with trailer']);
    for (const x of e) {
      expect(x.organization).toBe(`Exercise partner ${run}`);
      expect(x.hours).toBeCloseTo(3, 0);
    }
  });

  it('partner counts (2026-10-15; DCL:DEC-09): the county rolls up all, or chooses organizations and categories; the view states what it includes', async () => {
    const before = (await view()).body;
    expect(before.partners.rollup.all).toBe(true);
    expect(before.partners.organizations.map((o) => o.id)).toContain(partner);
    const partnerHours = before.donated.byOrganization.length;
    const current = await call<Saved>('director', 'GET', `/events/${eventId}/declaration`);
    const decl = (current.body as unknown as { declaration: Saved | null }).declaration;
    const put = (partnerRollup: unknown, version?: number) =>
      call<Saved>(
        'director',
        'PUT',
        `/events/${eventId}/declaration`,
        { partnerRollup },
        version !== undefined ? { 'if-match': String(version) } : {},
      );
    // Another county's organization cannot be chosen.
    expect(
      (await put({ all: false, partners: [randomUUID()], categories: ['services'] }, decl?.version))
        .status,
    ).toBe(400);
    // Only this partner's services: needs, shelter and teams read as not included, never zero.
    const chosen = await put(
      { all: false, partners: [partner], categories: ['services'] },
      decl?.version,
    );
    expect([200, 201]).toContain(chosen.status);
    const p = (await view()).body.partners;
    expect(p.rollup).toMatchObject({ all: false, categories: ['services'] });
    expect(p.rollup.statement).toContain(`Exercise partner ${run}`);
    expect(p.totals).toMatchObject({
      meals: 1039,
      needsMet: null,
      shelteredPeople: null,
      teams: null,
    });
    expect(p.byOrganization[0]).toMatchObject({ needsMet: null, teams: null });
    // Donated hours and equipment leave with the category; the walk-up volunteers stay.
    const d = (await view()).body.donated;
    expect(d.byOrganization.length).toBe(partnerHours - 1);
    expect(d.equipment).toEqual([]);
    // No organization chosen: nothing from any partner, every chosen category at zero.
    const v2 = (await view()).body.declaration as Saved;
    expect(
      (
        await put(
          {
            all: false,
            partners: [],
            categories: ['needs_met', 'services', 'sheltered', 'teams', 'donated'],
          },
          v2.version,
        )
      ).status,
    ).toBe(200);
    const none = (await view()).body.partners;
    expect(none.byOrganization).toEqual([]);
    expect(none.totals).toMatchObject({ meals: 0, needsMet: 0, teams: 0 });
    // Back to all.
    const v3 = (await view()).body.declaration as Saved;
    expect((await put({ all: true }, v3.version)).status).toBe(200);
    expect((await view()).body.partners.totals['meals']).toBe(1039);
  });

  it('partner counts (2026-10-15): the counting function returns numbers only, and only for the county itself', async () => {
    const rows = await asApp(
      county,
      (trx) =>
        sql<
          Record<string, unknown>
        >`select * from cg.partner_counts(${county}, ${eventId})`.execute(trx),
      countyPath,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(Object.keys(r).sort()).toEqual([
        'category',
        'item',
        'n',
        'organization',
        'partner_id',
      ]);
      expect(Number.isFinite(Number(r['n']))).toBe(true);
    }
    // The visibility the function widens for its one query is put back.
    const after = await asApp(
      county,
      async (trx) => {
        await sql`select * from cg.partner_counts(${county}, ${eventId})`.execute(trx);
        return (
          await sql<{
            v: string | null;
          }>`select current_setting('app.tenant_ids', true) as v`.execute(trx)
        ).rows[0]!.v;
      },
      countyPath,
    );
    expect(after ?? '').not.toContain(partner);
    // A partner, or anyone acting for another tenant, gets nothing.
    await expect(
      asApp(partner, (trx) =>
        sql`select * from cg.partner_counts(${county}, ${eventId})`.execute(trx),
      ),
    ).rejects.toThrow(/only for the county itself/);
  });

  it('starts the 30-day clock at the incident end date (DEC-16)', () => {
    expect(filingClock('2026-10-01', new Date('2026-10-14T12:00:00Z'))).toEqual({
      incidentEnd: '2026-10-01',
      deadline: '2026-10-31',
      daysLeft: 17,
      overdue: false,
    });
    expect(filingClock('2026-09-01', new Date('2026-10-14T12:00:00Z'))?.overdue).toBe(true);
    expect(filingClock(null)).toBeNull();
  });
});

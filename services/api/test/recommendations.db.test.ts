/**
 * Shelter recommendations against a real PostgreSQL (layer-7 task E; REC-02,
 * REC-03, REC-04, REC-10, REC-11, REC-12). The docs/02 WESTWIND scenario:
 * 96 households with nowhere to stay; the community center is in an outage
 * area with no backup power, the fairgrounds lot is not a shelter, the high
 * school gym comes first and the church hall second. The answer is stored
 * with the weights and factors in force (tenant values where sensible), the
 * age of each input is shown, a named person accepts, edits or rejects it
 * with a reason, and every step is audited. A role without the action sees
 * nothing. Then, on a second event (REC-05–REC-09): feeding stops for two
 * canteens with a Spanish note, a chaplain and pet food, edited stop by stop;
 * a Type II POD for 6,200 customers without power; a MARC whose partner mix
 * follows the verified damage and whose interpreters follow the reports.
 * Runs on a county of its own, only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import {
  countDamage,
  loadDamageRecords,
  type FeedingRecommendation,
  type MarcRecommendation,
  type PodRecommendation,
  type ShelterRecommendation,
} from '@cg/reporting';
import { facilities } from '../../../tools/seed/src/county.ts';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const ACTOR = '00000000-0000-4000-8000-0000000000aa';

interface Recommendation {
  id: string;
  version: number;
  kind: string;
  state: string;
  result: ShelterRecommendation;
  decisionChanges: Record<string, unknown>[] | null;
  requestedBy: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  chosenFacilityId: string | null;
}

describe.skipIf(!appUrl || !workerUrl)('shelter recommendations (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const ids: Record<string, string> = {};

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
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const audits = (action: string) =>
    dbWorker
      .selectFrom('cg.audit_event')
      .select(['action', 'reason', 'actor_account_id', 'target_id'])
      .where('tenant_id', '=', county)
      .where('action', '=', action)
      .execute();
  const request = async (who = 'em') => {
    const r = await call(who, 'POST', '/recommendations', { kind: 'shelter', eventId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as Recommendation;
  };

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-recommend-${run}`,
        name: `Exercise recommendations county ${run}`,
        status: 'provisioning',
        timezone: 'America/Chicago',
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
            name: `Exercise WESTWIND storm ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // The WESTWIND registry, as the seed loads it.
      for (const f of facilities) {
        const loc = await trx
          .insertInto('cg.location')
          .values({
            tenant_id: county,
            line1: f.address.line1,
            city: f.address.city,
            state: 'MO',
            postal: f.address.postal,
            geom: sql`ST_SetSRID(ST_MakePoint(${f.location[0]}, ${f.location[1]}), 4326)`,
            precision: 'exact',
            source: 'reviewer',
            created_by: ACTOR,
            updated_by: ACTOR,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        ids[f.key] = (
          await trx
            .insertInto('cg.facility')
            .values({
              tenant_id: county,
              name: f.name,
              kind: f.kind as 'school',
              location_id: loc.id,
              sqft: f.sqft,
              ada: f.ada,
              power_backup: f.powerBackup as 'none',
              kitchen: f.kitchen,
              showers: f.showers,
              pet_policy: f.petPolicy as 'none',
              parking_spaces: f.parkingSpaces,
              truck_access: f.truckAccess,
              floodplain: f.floodplain as 'out' | null,
              mou_status: f.mouStatus as 'none',
              communities: f.communities,
              notes: null,
              contacts_enc: null,
              owner_tenant_id: null,
              mou_expires_on: null,
              source: 'import',
              approved_by: ACTOR,
              approved_at: new Date(),
              created_by: ACTOR,
              updated_by: ACTOR,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      // The outage at the community center (docs/02): the utility names the building.
      await trx
        .insertInto('cg.outage')
        .values({
          tenant_id: county,
          event_id: eventId,
          client_uuid: randomUUID(),
          kind: 'power',
          facility_name: 'Westwind Community Center',
          area: 'Exercise feeder 4',
          customers_out: 900,
          started_at: new Date(Date.now() - 3 * 3_600_000),
          created_by: ACTOR,
          updated_by: ACTOR,
        })
        .execute();
      // 96 households with nowhere to stay tonight, around Harmon City and Westwind.
      const where = await trx
        .insertInto('cg.location')
        .values({
          tenant_id: county,
          line1: null,
          city: 'Westwind',
          state: 'MO',
          postal: '63003',
          geom: sql`ST_SetSRID(ST_MakePoint(-90.82, 38.8), 4326)`,
          precision: 'approximate',
          source: 'reviewer',
          created_by: ACTOR,
          updated_by: ACTOR,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (let i = 1; i <= 96; i++)
        await trx
          .insertInto('cg.need')
          .values({
            tenant_id: county,
            event_id: eventId,
            category: 'shelter_tonight',
            detail: null,
            source: 'staff',
            reference_code: `REC${run.slice(0, 4).toUpperCase()}${i}`,
            report_id: null,
            subject_party_id: null,
            claimed_by_tenant_id: null,
            claimed_by_account_id: null,
            claimed_at: null,
            assigned_by_account_id: null,
            released_at: null,
            done_at: null,
            done_note: null,
            location_id: where.id,
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
    subjects['em'] = as('county_em_director');
    subjects['mc'] = as('mass_care_coordinator');
    subjects['coad'] = as('coad_chair');
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
      .where('id', '=', county)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('REC-02, REC-03, REC-10, REC-11: the docs/02 scenario — gym first, church hall second, the center and the lot set aside with reasons, inputs dated', async () => {
    const rec = await request();
    const r = rec.result;
    expect(rec).toMatchObject({ kind: 'shelter', state: 'open' });
    expect(rec.requestedBy).toBe(subjects['em']!.accountId);
    expect(r.demand).toEqual({ households: 96, people: 240, petHouseholds: 0 });
    expect(r.top.map((t) => t.facilityId).slice(0, 2)).toEqual([ids['hs-gym'], ids['church-hall']]);
    expect(r.top[0]!.capacity).toBe(350);
    const excluded = new Map(r.excluded.map((x) => [x.facilityId, x.reasons.join(' ')]));
    expect(excluded.get(ids['community-center']!)).toContain(
      'in an outage area with no backup power',
    );
    expect(excluded.get(ids['fair-lot']!)).toContain('a parking lot is not a shelter');
    // The unknown floodplain at the church hall is said, never guessed (REC-10).
    expect(r.top[1]!.unknown).toContain('floodplain');
    expect(r.inputs.map((i) => i.input)).toEqual(
      expect.arrayContaining(['Facility registry (oldest re-check)', 'Outages']),
    );
    expect(r.weights).toMatchObject({ capacity: 0.35, proximity: 0.25 });
    expect(await audits('recommendation.request')).toEqual([
      expect.objectContaining({ actor_account_id: subjects['em']!.accountId, target_id: rec.id }),
    ]);
    // The same answer comes back from the list and by id.
    const listed = (await call('em', 'GET', `/recommendations?eventId=${eventId}`))
      .body as Recommendation[];
    expect(listed.map((x) => x.id)).toContain(rec.id);
    const one = (await call('coad', 'GET', `/recommendations/${rec.id}`)).body as Recommendation;
    expect(one.result.top[0]!.facilityId).toBe(ids['hs-gym']);
  });

  it('REC-12: tenant planning factors and weights are used where sensible and recorded with the answer', async () => {
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      for (const [key, value] of [
        ['recommendation.planning_factors', { personsPerHousehold: 3, staleDays: -4 }],
        ['recommendation.weights.shelter', { capacity: 0.5, proximity: 'far' }],
      ] as const)
        await trx
          .insertInto('cg.tenant_config')
          .values({
            tenant_id: county,
            key,
            value: JSON.stringify(value),
            created_by: ACTOR,
            updated_by: ACTOR,
          })
          .execute();
    });
    const r = (await request('mc')).result;
    expect(r.demand.people).toBe(288);
    expect(r.factors.staleDays).toBe(365);
    expect(r.weights).toMatchObject({ capacity: 0.5, proximity: 0.25 });
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .deleteFrom('cg.tenant_config')
        .where('tenant_id', '=', county)
        .where('key', 'like', 'recommendation.%')
        .execute(),
    );
  });

  it('REC-04: a named person accepts, edits or rejects with a reason; once decided it stays decided; the COAD may ask but not decide', async () => {
    const rec = await request();
    const decide = (who: string, body: unknown, version = rec.version) =>
      call(who, 'POST', `/recommendations/${rec.id}/decision`, body, {
        'if-match': `"${version}"`,
      });
    expect(
      (await decide('coad', { decision: 'accept', reason: 'Exercise: looks right' })).status,
    ).toBe(403);
    expect(
      (await decide('em', { decision: 'accept', reason: 'Exercise: stale' }, rec.version + 1))
        .status,
    ).toBe(409);
    // Accept only one of the places recommended; anything else is an edit.
    expect(
      (
        await decide('em', {
          decision: 'accept',
          facilityId: ids['community-center'],
          reason: 'Exercise: center',
        })
      ).status,
    ).toBe(400);
    expect((await decide('em', { decision: 'edit', reason: 'Exercise: no place' })).status).toBe(
      400,
    );
    const accepted = await decide('em', {
      decision: 'accept',
      reason: 'Exercise: gym has generator and showers',
      note: 'Open at 18:00',
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({
      state: 'accepted',
      chosenFacilityId: ids['hs-gym'],
      decidedBy: subjects['em']!.accountId,
      decisionReason: 'Exercise: gym has generator and showers',
    });
    const again = await decide(
      'em',
      { decision: 'reject', reason: 'Exercise: changed my mind' },
      (accepted.body as Recommendation).version,
    );
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('already_decided');
    expect(await audits('recommendation.accept')).toEqual([
      expect.objectContaining({
        reason: 'Exercise: gym has generator and showers',
        target_id: rec.id,
      }),
    ]);

    // Mass care picks another place from the registry (edit), with a reason.
    const second = await request('mc');
    const edited = await call(
      'mc',
      'POST',
      `/recommendations/${second.id}/decision`,
      {
        decision: 'edit',
        facilityId: ids['community-center'],
        reason: 'Exercise: power back on at the center',
      },
      { 'if-match': `"${second.version}"` },
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({
      state: 'edited',
      chosenFacilityId: ids['community-center'],
    });

    // And a rejection names no place.
    const third = await request();
    const rejected = await call(
      'em',
      'POST',
      `/recommendations/${third.id}/decision`,
      { decision: 'reject', reason: 'Exercise: Red Cross opening its own shelter' },
      { 'if-match': `"${third.version}"` },
    );
    expect(rejected.body).toMatchObject({ state: 'rejected', chosenFacilityId: null });
    expect(await audits('recommendation.reject')).toHaveLength(1);
  });

  it('a role without the action sees no recommendations', async () => {
    expect((await call('pio', 'GET', `/recommendations?eventId=${eventId}`)).status).toBe(403);
    expect(
      (await call('pio', 'POST', '/recommendations', { kind: 'shelter', eventId })).status,
    ).toBe(403);
  });

  describe('feeding, POD and MARC on a second event (REC-05–REC-09)', () => {
    let second = '';
    let canteenA = '';
    beforeAll(async () => {
      await withTenant(dbWorker, { tenantId: county }, async (trx) => {
        second = (
          await trx
            .insertInto('cg.event')
            .values({
              tenant_id: county,
              name: `Exercise WESTWIND day two ${run}`,
              hazard_type: 'tornado',
              status: 'active',
              opened_at: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        // REC-06: two canteens a partner declared, one with its serving rate.
        for (const [name, meals] of [
          ['Exercise Canteen A', 200],
          ['Exercise Canteen B', null],
        ] as const) {
          const t = await trx
            .insertInto('cg.team')
            .values({
              tenant_id: county,
              event_id: second,
              key: `${name.toLowerCase().replace(/ /g, '-')}-${run}`,
              name,
              kind: 'canteen',
              agency_tenant_id: county,
              agency: 'Exercise Canteen Services',
              callsign: null,
              lead_personnel_id: null,
              skills: ['food_safety'],
              equipment: ['canteen truck'],
              capacity: 3,
              meals_per_hour: meals,
              notes: null,
              created_by: ACTOR,
              updated_by: ACTOR,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          if (meals) canteenA = t.id;
        }
        const place = async (lon: number, lat: number) =>
          (
            await trx
              .insertInto('cg.location')
              .values({
                tenant_id: county,
                line1: null,
                city: 'Westwind',
                state: 'MO',
                postal: '63003',
                geom: sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)`,
                precision: 'approximate',
                source: 'reviewer',
                created_by: ACTOR,
                updated_by: ACTOR,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        const party = async (language: string) =>
          (
            await trx
              .insertInto('cg.party')
              .values({
                tenant_id: county,
                kind: 'resident',
                display_name_enc: null,
                contact_enc: null,
                phone_bidx: null,
                email_bidx: null,
                language,
                sms_opt_in_evidence: null,
                created_by: ACTOR,
                updated_by: ACTOR,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        const cedar = await place(-90.85, 38.79);
        const harmon = await place(-90.79, 38.812);
        const es = await party('es');
        const en = await party('en');
        let n = 0;
        const need = (category: string, locationId: string, partyId: string | null) =>
          trx
            .insertInto('cg.need')
            .values({
              tenant_id: county,
              event_id: second,
              category,
              detail: null,
              source: 'staff',
              reference_code: `RE2${run.slice(0, 4).toUpperCase()}${++n}`,
              report_id: null,
              subject_party_id: null,
              claimed_by_tenant_id: null,
              claimed_by_account_id: null,
              claimed_at: null,
              assigned_by_account_id: null,
              released_at: null,
              done_at: null,
              done_note: null,
              location_id: locationId,
              contact_party_id: partyId,
              execution_id: null,
            })
            .execute();
        // Cedar Ridge: 40 households, 30 asked in Spanish; 4 with pets; 3 want someone to talk to.
        for (let i = 0; i < 40; i++) await need('food_water', cedar, i < 30 ? es : en);
        for (let i = 0; i < 4; i++) await need('pets', cedar, es);
        for (let i = 0; i < 3; i++) await need('someone_to_talk', cedar, es);
        // Harmon City: 25 households.
        for (let i = 0; i < 25; i++) await need('food_water', harmon, en);
        await trx
          .insertInto('cg.outage')
          .values({
            tenant_id: county,
            event_id: second,
            client_uuid: randomUUID(),
            kind: 'power',
            facility_name: null,
            area: 'Exercise feeder 9',
            customers_out: 6200,
            started_at: new Date(Date.now() - 24 * 3_600_000),
            created_by: ACTOR,
            updated_by: ACTOR,
          })
          .execute();
      });
    });

    const ask = async (kind: string, extra: Record<string, unknown> = {}) => {
      const r = await call('mc', 'POST', '/recommendations', { kind, eventId: second, ...extra });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as Omit<Recommendation, 'result'> & { result: unknown };
    };

    it('REC-05, REC-06: stops for the declared canteens, with windows, meals and setup notes; edited stop by stop', async () => {
      const rec = await ask('feeding');
      const r = rec.result as FeedingRecommendation;
      expect(r.demand).toMatchObject({ households: 65, petHouseholds: 4, talkHouseholds: 3 });
      expect(r.canteens.map((c) => [c.name, c.mealsPerHour])).toEqual([
        ['Exercise Canteen A', 200],
        ['Exercise Canteen B', null],
      ]);
      expect(
        r.stops.map((x) => [x.stop, x.canteen?.name, x.window.start, x.households, x.meals]),
      ).toEqual([
        [1, 'Exercise Canteen A', '11:00', 40, 100],
        [2, 'Exercise Canteen B', '11:00', 25, 63],
      ]);
      expect(r.stops[0]!.notes).toEqual([
        'Most requests here came in Spanish: bring a Spanish-speaking volunteer',
        '4 households here asked for help with pets: bring pet food',
        '3 households here asked for someone to talk to: suggest a chaplain or crisis counselor at this stop',
      ]);
      expect(r.stops[1]!.unknown).toContain('meals an hour for Exercise Canteen B');
      expect(r.inputs.map((i) => i.input)).toContain('Canteens on the roster');
      // Only one canteen when asked for it.
      const one = (await ask('feeding', { teamIds: [canteenA] })).result as FeedingRecommendation;
      expect(one.canteens.map((c) => c.name)).toEqual(['Exercise Canteen A']);

      const decide = (body: unknown) =>
        call('mc', 'POST', `/recommendations/${rec.id}/decision`, body, {
          'if-match': `"${rec.version}"`,
        });
      expect(
        (await decide({ decision: 'accept', facilityId: ids['hs-gym'], reason: 'Exercise: gym' }))
          .status,
      ).toBe(400);
      expect(
        (
          await decide({
            decision: 'edit',
            swaps: [{ stop: 9, place: 'Exercise lot' }],
            reason: 'Exercise: no such stop',
          })
        ).status,
      ).toBe(400);
      const edited = await decide({
        decision: 'edit',
        swaps: [{ stop: 2, place: 'Exercise Grace church lot our team knows' }],
        reason: 'Exercise: the team knows the church lot and its pastor',
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body).toMatchObject({
        state: 'edited',
        chosenFacilityId: null,
        decisionChanges: [
          {
            stop: 2,
            from: r.stops[1]!.place,
            to: 'Exercise Grace church lot our team knows',
            facilityId: null,
          },
        ],
      });
      expect(await audits('recommendation.edit')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: 'Exercise: the team knows the church lot and its pastor',
            target_id: rec.id,
          }),
        ]),
      );
    });

    it('REC-07, REC-08: a Type II POD for 6,200 customers without power, its 72-hour supplies, sited on the fairgrounds lot', async () => {
      const rec = await ask('pod');
      const r = rec.result as PodRecommendation;
      expect(r.demand).toMatchObject({
        powerCustomersOut: 6200,
        people: 15500,
        peoplePerDay: 7750,
      });
      expect(r.pod).toEqual({ type: 'II', count: 1, peoplePerDay: 7750 });
      expect(r.supplies).toMatchObject({ waterGallons: 23250, meals: 46500 });
      expect(r.top[0]!.facilityId).toBe(ids['fair-lot']);
      const why = new Map(r.excluded.map((x) => [x.facilityId, x.reasons.join(' ')]));
      expect(why.get(ids['church-hall']!)).toContain('no semi-truck access');
      // No Census profile in this county: walk-up points cannot be suggested, and it says so.
      expect(r.checks).toContain(
        'Census vehicle data is not loaded, so walk-up points cannot be suggested.',
      );
      const accepted = await call(
        'em',
        'POST',
        `/recommendations/${rec.id}/decision`,
        { decision: 'accept', reason: 'Exercise: submit the resource request to the state' },
        { 'if-match': `"${rec.version}"` },
      );
      expect(accepted.body).toMatchObject({ state: 'accepted', chosenFacilityId: ids['fair-lot'] });
    });

    it('REC-09: the MARC partner mix follows the verified damage; interpreters follow the reports', async () => {
      const { reportIds } = await loadDamageReports(dbWorker, {
        tenantId: county,
        eventId: second,
        reviewerId: ACTOR,
        count: 60,
        tag: `rec${run}`,
      });
      const es = await withTenant(dbWorker, { tenantId: county }, async (trx) => {
        const p = await trx
          .insertInto('cg.party')
          .values({
            tenant_id: county,
            kind: 'resident',
            display_name_enc: null,
            contact_enc: null,
            phone_bidx: null,
            email_bidx: null,
            language: 'es',
            sms_opt_in_evidence: null,
            created_by: ACTOR,
            updated_by: ACTOR,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('cg.report')
          .set({ reporter_party_id: p.id })
          .where('id', 'in', reportIds.slice(0, 7))
          .execute();
        const totals = countDamage(await loadDamageRecords(trx, second));
        return totals.counted.cells
          .filter((c) => c.degree === 'major' || c.degree === 'destroyed')
          .reduce((n, c) => n + c.units, 0);
      });
      const r = (await ask('marc')).result as MarcRecommendation;
      expect(r.demand.majorDestroyed).toBe(es);
      expect(r.services.length).toBeGreaterThan(0);
      if (es > 0) expect(r.services[0]!.service).toBe('Housing');
      expect(r.services.find((x) => x.service === 'Crisis counseling')).toMatchObject({
        households: 3,
        tables: 1,
      });
      expect(r.interpreters[0]).toMatchObject({ language: 'es', name: 'Spanish', reports: 7 });
      expect(r.sqftNeeded).toBe(1000 + r.tables * 100);
      for (const t of r.top) expect(t.reasons).toContain('Accessible to wheelchair users (ADA)');
      expect(r.checks[0]).toContain('Bus line');
    });
  });
});

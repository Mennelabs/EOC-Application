/**
 * CON-05: review queue plus field-team routing. A reviewer sends a report to
 * the field with a review decision of its own (with a reason and
 * confirmation); the report stays in review and waits for a visit. The
 * reports waiting are grouped by the route area of their parcel (named on the
 * location, or found under its point), else by ZIP; a verification route
 * opens for the ones not yet on a route, its stops their parcels, through the
 * mission step and the caller's own permission to open missions; the same
 * reports are not routed twice, and a verified report no longer waits. A
 * verified report cannot be sent. Roles without review are refused. Runs on a
 * county of its own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, randomCode, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Groups {
  groups: {
    areaKey: string | null;
    postal: string | null;
    reports: {
      id: string;
      referenceCode: string;
      parcelId: string | null;
      routeMissionId: string | null;
    }[];
    waiting: number;
    routes: { missionId: string; reference: string; state: string }[];
  }[];
}

describe.skipIf(!appUrl || !workerUrl)(
  'reports sent to the field and routed (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let county = '';
    let eventId = '';
    const run = randomUUID().slice(0, 8);
    const area = `elm-${run}`;
    const subjects: Record<string, AccountSubject> = {};
    const reports: Record<string, string> = {};

    const call = async (
      who: string,
      method: 'GET' | 'POST',
      url: string,
      payload?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const res = await app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...extra },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
      return { status: res.statusCode, body: res.body, json: <T>() => res.json() as T };
    };
    const version = async (id: string) =>
      (
        await dbWorker
          .selectFrom('cg.report')
          .select('version')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).version;
    const sendToField = async (who: string, id: string) =>
      call(
        who,
        'POST',
        `/reports/${id}/decisions`,
        { decision: 'field_visit', reason: 'Exercise: photos do not show the roof' },
        {
          'if-match': `"${await version(id)}"`,
          'x-confirm': 'true',
          'x-reason': 'Exercise: photos do not show the roof',
        },
      );

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 3);
      dbWorker = createDb(workerUrl!, 2);
      const seeded = await loadSeed(dbWorker);
      const c = await dbWorker
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-visits-${run}`,
          name: `Exercise visits county ${run}`,
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
              name: `Exercise visits storm ${run}`,
              hazard_type: 'tornado',
              status: 'active',
              opened_at: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        // Three parcels on one route area, each about 20 m across.
        for (const [n, lon] of [
          [1, -90.87],
          [2, -90.8696],
          [3, -90.8692],
        ] as const)
          await trx
            .insertInto('cg.parcel')
            .values({
              tenant_id: county,
              parcel_id: `EL-${run}-${n}`,
              geom: sql`ST_Multi(ST_MakeEnvelope(${lon}, 38.79, ${lon + 0.0002}, 38.7902, 4326))`,
              line1: `${n} Exercise Elm St`,
              area_key: area,
            } as never)
            .execute();
        // r1 names its parcel; r2 is a point inside parcel 2; r3 lies on no parcel; r4 is on
        // parcel 3; r5 is only the address a resident typed, which is parcel 1's.
        const places: Record<
          string,
          { parcel?: string; point?: [number, number]; line1?: string; postal: string }
        > = {
          r1: { parcel: `EL-${run}-1`, point: [38.7901, -90.8699], postal: '63002' },
          r2: { point: [38.7901, -90.8695], postal: '63002' },
          r3: { point: [38.7, -90.7], postal: '63009' },
          r4: { parcel: `EL-${run}-3`, postal: '63002' },
          r5: { line1: ' 1  exercise ELM St ', postal: '63002' },
        };
        for (const [key, p] of Object.entries(places)) {
          const loc = await trx
            .insertInto('cg.location')
            .values({
              tenant_id: county,
              postal: p.postal,
              line1: p.line1 ?? null,
              parcel_id: p.parcel ?? null,
              ...(p.point
                ? { geom: sql`ST_SetSRID(ST_MakePoint(${p.point[1]}, ${p.point[0]}), 4326)` }
                : {}),
            } as never)
            .returning('id')
            .executeTakeFirstOrThrow();
          reports[key] = (
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
                location_id: loc.id,
              } as never)
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
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
      subjects['coordinator'] = as('damage_assessment_coordinator');
      subjects['reviewer'] = as('assessment_reviewer');
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

    it('CON-05: a reviewer sends reports to the field; they stay in review, recorded as a decision; a verified report cannot be sent', async () => {
      expect((await sendToField('volunteer', reports['r1']!)).status).toBe(404);
      for (const key of ['r1', 'r2', 'r3', 'r5']) {
        const sent = await sendToField('reviewer', reports[key]!);
        expect(sent.status, sent.body).toBe(200);
        expect(sent.json()).toMatchObject({ reviewState: 'under_review' });
        expect(
          sent.json<{ fieldVisitRequestedAt: string | null }>().fieldVisitRequestedAt,
        ).not.toBe(null);
      }
      const decision = await dbWorker
        .selectFrom('cg.review_decision')
        .select(['decision', 'reason'])
        .where('report_id', '=', reports['r1']!)
        .executeTakeFirstOrThrow();
      expect(decision).toEqual({
        decision: 'field_visit',
        reason: 'Exercise: photos do not show the roof',
      });
      await dbWorker
        .updateTable('cg.report')
        .set({ verification_level: 'field_verified' })
        .where('id', '=', reports['r4']!)
        .execute();
      expect((await sendToField('reviewer', reports['r4']!)).status).toBe(409);
    });

    it('CON-05, FLD-13: the waiting reports are grouped by route area, else by ZIP; a route opens for them with their parcels as stops, once; a verified report stops waiting', async () => {
      expect(
        (await call('volunteer', 'GET', `/reports/field-visits?eventId=${eventId}`)).status,
      ).toBe(403);
      const before = await call('reviewer', 'GET', `/reports/field-visits?eventId=${eventId}`);
      expect(before.status, before.body).toBe(200);
      const groups = before.json<Groups>().groups;
      expect(groups.map((g) => [g.areaKey, g.postal, g.waiting])).toEqual([
        [area, null, 3],
        [null, '63009', 1],
      ]);
      expect(groups[0]!.reports.map((r) => r.parcelId).sort()).toEqual([
        `EL-${run}-1`,
        `EL-${run}-1`,
        `EL-${run}-2`,
      ]);
      // The reviewer may not open missions: the route is refused and says why.
      const refused = await call('reviewer', 'POST', '/reports/field-visits/routes', {
        eventId,
        areaKey: area,
      });
      expect(refused.status).toBe(403);
      expect(refused.body).toContain('opens missions');

      const opened = await call('coordinator', 'POST', '/reports/field-visits/routes', {
        eventId,
        areaKey: area,
      });
      expect(opened.status, opened.body).toBe(201);
      expect(opened.json()).toMatchObject({ reports: 3, stops: 2 });
      const mission = await dbWorker
        .selectFrom('cg.mission')
        .select(['kind', 'state', 'route', 'required_credentials'])
        .where('id', '=', opened.json<{ missionId: string }>().missionId)
        .executeTakeFirstOrThrow();
      expect(mission.kind).toBe('verification_route');
      expect(mission.state).toBe('open');
      expect(mission.required_credentials).toEqual(['damage_assessor']);
      const route = mission.route as { area: string; stops: string[]; reports: string[] };
      expect(route.area).toBe(area);
      expect([...route.stops].sort()).toEqual([`EL-${run}-1`, `EL-${run}-2`]);
      expect([...route.reports].sort()).toEqual(
        [reports['r1'], reports['r2'], reports['r5']].sort(),
      );
      // The locations found by point or address now name their parcel, so the visit links back.
      const named = await dbWorker
        .selectFrom('cg.report as r')
        .innerJoin('cg.location as l', 'l.id', 'r.location_id')
        .select(['r.id', 'l.parcel_id'])
        .where('r.id', 'in', [reports['r2']!, reports['r5']!])
        .execute();
      expect(Object.fromEntries(named.map((n) => [n.id, n.parcel_id]))).toEqual({
        [reports['r2']!]: `EL-${run}-2`,
        [reports['r5']!]: `EL-${run}-1`,
      });
      // The same reports are not routed twice.
      const again = await call('coordinator', 'POST', '/reports/field-visits/routes', {
        eventId,
        areaKey: area,
      });
      expect(again.status).toBe(409);
      const after = (
        await call('reviewer', 'GET', `/reports/field-visits?eventId=${eventId}`)
      ).json<Groups>().groups;
      expect(after[0]).toMatchObject({ areaKey: area, waiting: 0 });
      expect(after[0]!.routes.map((r) => r.missionId)).toEqual([
        opened.json<{ missionId: string }>().missionId,
      ]);
      // A visit verified r1: it no longer waits.
      await dbWorker
        .updateTable('cg.report')
        .set({ verification_level: 'field_verified' })
        .where('id', '=', reports['r1']!)
        .execute();
      const verified = (
        await call('reviewer', 'GET', `/reports/field-visits?eventId=${eventId}`)
      ).json<Groups>().groups;
      expect(verified[0]!.reports.map((r) => r.id)).toEqual([reports['r2'], reports['r5']]);
    });
  },
);

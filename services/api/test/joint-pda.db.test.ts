/**
 * The joint damage assessment and the state liaison's view against the
 * database (layer-6 task F; FL:FR-10, DCL:DEC-13, Form 010-0-13 Box 10,
 * ADM-05 G4, SCL-01): the county schedules it and draws a proportional
 * sample from a seed it can redraw exactly; stops carry no name, contact or
 * address; a FEMA validator marks stops but nobody marks a home whose degree
 * they set; a marked sample is not redrawn; Box 10 comes from the schedule;
 * the FEMA validator role is only assigned with an end date within 30 days;
 * a state liaison sees a county's figures only under a signed agreement,
 * de-identified, the same totals as the county's own screen, and each read
 * is in the county's audit chain. Runs only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import {
  allocate,
  classifyHomes,
  loadDamageRecords,
  loadPackageData,
  type Degree,
} from '@cg/reporting';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Stop {
  id: string;
  seq: number;
  stratum: Degree;
  home: { ref: string | null; usng: string | null; point: [number, number] | null } | null;
  mark: { result: string; degreeSeen: string | null; markedBy: string | null } | null;
}
interface Joint {
  schedule: { id: string; version: number; sampleVersion: number; sampleSeed: number };
  stops: Stop[];
  summary: {
    stops: number;
    validated: number;
    different: number;
    notSeen: number;
    pending: number;
  };
  candidates: number;
  code?: string;
}

describe.skipIf(!appUrl || !workerUrl)(
  'joint assessment and liaison view (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let county = '';
    let state = '';
    let eventId = '';
    const run = randomUUID().slice(0, 8);
    const people: Record<string, string> = {};
    const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      withTenant(dbWorker, { tenantId: county }, fn);

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 3);
      dbWorker = createDb(workerUrl!, 2);
      const seeded = await loadSeed(dbWorker);
      state = seeded.tenants['state']!;
      const stateRow = await dbWorker
        .selectFrom('cg.tenant')
        .select(['path', 'kind'])
        .where('id', '=', state)
        .executeTakeFirstOrThrow();
      const c = await dbWorker
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-jpda-${run}`,
          name: `Exercise joint county ${run}`,
          status: 'provisioning',
        })
        .returning(['id', 'path', 'kind'])
        .executeTakeFirstOrThrow();
      county = c.id;
      eventId = await tx(async (trx) => {
        await trx
          .insertInto('cg.tenant_config')
          .values({ tenant_id: county, key: 'refdata.enabled', value: JSON.stringify(false) })
          .execute();
        for (const [who, name] of [
          ['director', 'Exercise EM Director'],
          ['coordinator', 'Exercise DA Coordinator'],
          ['validator', 'Exercise FEMA Validator'],
          ['admin', 'Exercise Administrator'],
        ] as const)
          people[who] = (
            await trx
              .insertInto('cg.account')
              .values({
                tenant_id: county,
                email: `${who}-${run}@example.org`,
                display_name: name,
                status: 'active',
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        return (
          await trx
            .insertInto('cg.event')
            .values({
              tenant_id: county,
              name: `Exercise joint flood ${run}`,
              hazard_type: 'flood',
              status: 'active',
              opened_at: new Date(Date.now() - 86_400_000),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      });
      // The coordinator reviewed these reports and set their degrees (G4 below).
      await loadDamageReports(dbWorker, {
        tenantId: county,
        eventId,
        reviewerId: people['coordinator']!,
        count: 60,
        tag: `jp${run}`,
      });

      const subject = (
        template: string,
        accountId: string,
        at: { id: string; path: string; kind: string } = c,
      ): AccountSubject => {
        const r = roleTemplates.find((x) => x.key === template)!;
        return {
          kind: 'account',
          accountId,
          tenantId: at.id,
          tenantPath: at.path,
          tenantKind: at.kind,
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
        director: subject('county_em_director', people['director']!),
        coordinator: subject('damage_assessment_coordinator', people['coordinator']!),
        validator: subject('fema_validator', people['validator']!),
        reporting: subject('reporting_planning', randomUUID()),
        admin: subject('tenant_admin', people['admin']!),
        liaison: subject('state_liaison', randomUUID(), {
          id: state,
          path: stateRow.path as string,
          kind: stateRow.kind,
        }),
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
        routes: routesWith({}),
      });
    });

    afterAll(async () => {
      await app?.close();
      await dbWorker
        ?.updateTable('cg.tenant')
        .set({ status: 'closed' })
        .where('slug', '=', `exercise-jpda-${run}`)
        .execute();
      await dbApp?.destroy();
      await dbWorker?.destroy();
    });

    const call = async <T = Joint>(
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
      return { status: res.statusCode, body: res.json() as T };
    };

    let joint: Joint;

    it('FL:FR-10: the county schedules the joint assessment; Box 10 follows it', async () => {
      const schedule = {
        startsOn: '2026-10-20',
        endsOn: '2026-10-22',
        areas: ['North river district', 'Harmon City'],
      };
      expect(
        (await call('validator', 'PUT', `/events/${eventId}/joint-pda`, schedule)).status,
      ).toBe(403);
      expect(
        (
          await call('director', 'PUT', `/events/${eventId}/joint-pda`, {
            startsOn: '2026-10-22',
            endsOn: '2026-10-20',
          })
        ).status,
      ).toBe(400);
      const made = await call<{ version: number }>(
        'director',
        'PUT',
        `/events/${eventId}/joint-pda`,
        schedule,
      );
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(
        (await call('director', 'PUT', `/events/${eventId}/joint-pda`, { status: 'in_progress' }))
          .status,
      ).toBe(428);
      const teams = [
        { name: 'Team 1', members: 'FEMA IA validator; SEMA liaison; county assessor' },
      ];
      const updated = await call<{ teams: unknown[]; status: string }>(
        'director',
        'PUT',
        `/events/${eventId}/joint-pda`,
        { teams, status: 'in_progress' },
        { 'if-match': `"${made.body.version}"` },
      );
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      expect(updated.body).toMatchObject({ teams, status: 'in_progress' });
      const pkg = await tx((trx) => loadPackageData(trx, county, eventId));
      expect(pkg!.jointPda).toEqual({
        dates: '2026-10-20 to 2026-10-22',
        areas: 'North river district; Harmon City',
      });
    });

    it('FL:FR-10: the sample is proportional, redrawn exactly from its seed, and carries no address', async () => {
      const records = await tx((trx) => loadDamageRecords(trx, eventId));
      const counted = classifyHomes(records).homes.filter(
        (h) =>
          h.status === 'counted' &&
          ['affected', 'minor', 'major', 'destroyed'].includes(h.record.degree ?? ''),
      );
      const counts = Object.fromEntries(
        (['affected', 'minor', 'major', 'destroyed'] as const).map((d) => [
          d,
          counted.filter((h) => h.record.degree === d).length,
        ]),
      ) as Record<Degree, number>;
      expect(counted.length).toBeGreaterThan(12);

      const first = await call('director', 'POST', `/events/${eventId}/joint-pda/sample`, {
        size: 12,
        seed: 7,
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.candidates).toBe(counted.length);
      expect(first.body.stops).toHaveLength(12);
      const want = allocate(counts, 12);
      for (const d of ['affected', 'minor', 'major', 'destroyed'] as const)
        expect(first.body.stops.filter((s) => s.stratum === d)).toHaveLength(want[d]);
      const again = await call('director', 'POST', `/events/${eventId}/joint-pda/sample`, {
        size: 12,
        seed: 7,
      });
      expect(again.body.schedule.sampleVersion).toBe(first.body.schedule.sampleVersion + 1);
      expect(again.body.stops.map((s) => s.home?.ref)).toEqual(
        first.body.stops.map((s) => s.home?.ref),
      );
      joint = again.body;
      expect(joint.stops.every((s) => s.home?.usng && s.home.point && !s.mark)).toBe(true);

      // DEC-13: nothing personal or address-like in what validators see.
      const lines = await tx((trx) =>
        trx
          .selectFrom('cg.report as r')
          .innerJoin('cg.location as l', 'l.id', 'r.location_id')
          .select('l.line1')
          .where('r.event_id', '=', eventId)
          .execute(),
      );
      const asValidator = await call('validator', 'GET', `/events/${eventId}/joint-pda`);
      expect(asValidator.status).toBe(200);
      expect(asValidator.body.stops).toHaveLength(12);
      const seen = JSON.stringify(asValidator.body);
      for (const l of lines) expect(seen).not.toContain(l.line1!);
      expect(seen).not.toContain('@example');
      expect(seen).not.toMatch(/SYN-/);
    });

    it('G4: a validator marks stops; who set a degree does not validate it; a marked sample stands', async () => {
      const [a, b, c] = joint.stops;
      expect(
        (
          await call('coordinator', 'POST', `/joint-pda/stops/${a!.id}/marks`, {
            result: 'validated',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('reporting', 'POST', `/joint-pda/stops/${a!.id}/marks`, {
            result: 'validated',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call('validator', 'POST', `/joint-pda/stops/${a!.id}/marks`, {
            result: 'different',
          })
        ).status,
      ).toBe(400);
      const marked = await call<Stop>('validator', 'POST', `/joint-pda/stops/${a!.id}/marks`, {
        result: 'validated',
      });
      expect(marked.status, JSON.stringify(marked.body)).toBe(201);
      expect(marked.body.mark).toMatchObject({
        result: 'validated',
        markedBy: 'Exercise FEMA Validator',
      });
      await call('validator', 'POST', `/joint-pda/stops/${b!.id}/marks`, {
        result: 'different',
        degreeSeen: 'major',
        note: 'Exercise: water line higher than reported.',
      });
      await call('validator', 'POST', `/joint-pda/stops/${c!.id}/marks`, { result: 'not_seen' });
      const now = (await call('reporting', 'GET', `/events/${eventId}/joint-pda`)).body;
      expect(now.summary).toEqual({
        stops: 12,
        validated: 1,
        different: 1,
        notSeen: 1,
        pending: 9,
      });
      expect(
        (await call('director', 'POST', `/events/${eventId}/joint-pda/sample`, { size: 12 })).body
          .code,
      ).toBe('sample_marked');
      const audit = await tx((trx) =>
        trx
          .selectFrom('cg.audit_event')
          .select(['action', 'actor_account_id'])
          .where('target_id', 'in', [a!.id, b!.id, c!.id])
          .execute(),
      );
      expect(audit.filter((x) => x.action === 'joint_assessment.validate')).toHaveLength(3);
      expect(
        audit.some(
          (x) => x.action === 'authz.deny' && x.actor_account_id === people['coordinator'],
        ),
      ).toBe(true);
    });

    it('the FEMA validator role is assigned only with an end date within 30 days', async () => {
      const role = await tx((trx) =>
        trx
          .insertInto('cg.role')
          .values({
            tenant_id: county,
            key: 'fema_validator',
            name: 'FEMA validator',
            template_key: 'fema_validator',
            created_by: people['admin']!,
            updated_by: people['admin']!,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      const ask = (validTo?: string) =>
        call<{ fields?: { name: string }[] }>('admin', 'POST', '/permission-changes', {
          kind: 'assign_role',
          accountId: people['validator'],
          roleId: role.id,
          ...(validTo ? { validTo } : {}),
        });
      const none = await ask();
      expect(none.status).toBe(400);
      expect(JSON.stringify(none.body)).toContain('validTo');
      expect((await ask(new Date(Date.now() + 60 * 86_400_000).toISOString())).status).toBe(400);
      expect((await ask(new Date(Date.now() - 86_400_000).toISOString())).status).toBe(400);
      const ok = await ask(new Date(Date.now() + 14 * 86_400_000).toISOString());
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });

    it('DEC-13, SCL-01: a state liaison sees de-identified figures only under a signed agreement', async () => {
      const listed = async () =>
        (
          await call<{ tenantId: string; events: { id: string }[] }[]>(
            'liaison',
            'GET',
            '/shared-declarations',
          )
        ).body.find((x) => x.tenantId === county);
      expect(await listed()).toBeUndefined();
      expect((await call('liaison', 'GET', `/shared-declarations/${eventId}`)).status).toBe(404);
      expect((await call('director', 'GET', '/shared-declarations')).status).toBe(403);

      const agreement = await tx((trx) =>
        trx
          .insertInto('cg.data_sharing_agreement')
          .values({
            from_tenant_id: county,
            to_tenant_id: state,
            scope: 'deidentified_counts',
            status: 'signed',
            signed_at: new Date(),
            signed_by: people['director']!,
            created_by: people['director']!,
            updated_by: people['director']!,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      expect((await listed())!.events.map((e) => e.id)).toContain(eventId);
      const shared = await call<{
        county: { id: string };
        damage: { counted: { units: number } };
        outages: { unconfirmed: number };
        jointAssessment: { summary: { validated: number }; startsOn: string };
      }>('liaison', 'GET', `/shared-declarations/${eventId}`);
      expect(shared.status, JSON.stringify(shared.body)).toBe(200);
      const own = await call<{ damage: { counted: { units: number } } }>(
        'director',
        'GET',
        `/events/${eventId}/declaration`,
      );
      expect(shared.body.damage.counted.units).toBe(own.body.damage.counted.units);
      expect(shared.body.jointAssessment).toMatchObject({
        startsOn: '2026-10-20',
        summary: { validated: 1 },
      });
      expect(shared.body.outages.unconfirmed).toBe(0);
      const text = JSON.stringify(shared.body);
      const lines = await tx((trx) =>
        trx
          .selectFrom('cg.report as r')
          .innerJoin('cg.location as l', 'l.id', 'r.location_id')
          .select('l.line1')
          .where('r.event_id', '=', eventId)
          .execute(),
      );
      for (const l of lines) expect(text).not.toContain(l.line1!);
      expect(text).not.toContain('@example');
      // The agreement opens the figures, not the county's records.
      expect((await call('liaison', 'GET', `/events/${eventId}/declaration`)).status).not.toBe(200);
      expect((await call('liaison', 'GET', `/events/${eventId}/joint-pda`)).status).not.toBe(200);
      const read = await tx((trx) =>
        trx
          .selectFrom('cg.audit_event')
          .select(['tenant_id', 'changes'])
          .where('action', '=', 'shared_declaration.read')
          .where('target_id', '=', eventId)
          .execute(),
      );
      expect(read).toHaveLength(1);
      expect(read[0]!.tenant_id).toBe(county);

      await tx((trx) =>
        trx
          .updateTable('cg.data_sharing_agreement')
          .set({ status: 'revoked', revoked_at: new Date(), revoked_by: people['director']! })
          .where('id', '=', agreement.id)
          .execute(),
      );
      expect((await call('liaison', 'GET', `/shared-declarations/${eventId}`)).status).toBe(404);
    });
  },
);

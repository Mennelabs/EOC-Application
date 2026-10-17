/**
 * The wall briefing (CON-11; layer-8 plan §5 and §14), against the
 * database: the display account, holding `briefing.read` and nothing else,
 * reads one event's aggregate; the payload carries counts, place names,
 * objectives and the event log and no personal field; the display account
 * reads nothing else; the refresh interval is the county's. Runs only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Briefing {
  asOf: string;
  refreshSeconds: number;
  event: { name: string };
  damage: { verified: number; awaitingReview: number };
  shelters: { name: string; occupancy: number | null; capacity: number | null }[];
  needs: { open: number };
  missions: { byState: Record<string, number> };
  objectives: { position: number; objective: string }[];
  significantEvents: { summary: string }[];
  liveConditions: unknown[];
}

/** Keys that would mean a person slipped into the wall's payload. */
const PERSONAL = /email|phone|address|contact|display_?name|resident|caller|personnel/i;
const allKeys = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  return out;
};

describe.skipIf(!appUrl || !workerUrl)('wall briefing (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-wall-${run}`;
  const subjects: Record<string, AccountSubject> = {};

  const call = async <T>(who: string, url: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}` },
    });
    return { status: res.statusCode, body: res.json() as T };
  };

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise wall county ${run}`,
        status: 'active',
        locales: ['en', 'es'],
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const people: Record<string, string> = {};
    const cast = [
      ['wall', 'briefing_display', 'EOC wall (exercise)'],
      ['pio', 'public_information_officer', 'Exercise PIO'],
    ] as const;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      for (const [who, , name] of cast)
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
      eventId = (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise wall event ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await trx
        .insertInto('cg.site')
        .values({
          tenant_id: county,
          event_id: eventId,
          kind: 'shelter',
          name: `Exercise shelter ${run}`,
          slug: `wall-shelter-${run}`,
          status: 'open',
          capacity: 220,
          occupancy: 180,
          created_by: null,
          updated_by: null,
        })
        .execute();
      await trx
        .insertInto('cg.incident_objective')
        .values({
          tenant_id: county,
          event_id: eventId,
          period_from: new Date(Date.now() - 3_600_000),
          period_to: new Date(Date.now() + 3_600_000),
          position: 1,
          objective: 'Shelter everyone displaced (exercise)',
          owner_position: 'Mass Care Coordinator',
          note: null,
          created_by: null,
          updated_by: null,
        })
        .execute();
      await trx
        .insertInto('cg.significant_event')
        .values({
          tenant_id: county,
          event_id: eventId,
          kind: 'site',
          summary: 'Exercise shelter opened with 220 cots',
          mission_id: null,
          team_id: null,
          ref_kind: null,
          ref_id: null,
          actor_account_id: null,
        })
        .execute();
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: 'briefing.refresh_seconds', value: JSON.stringify(30) })
        .execute();
    });
    for (const [who, template] of cast) {
      const r = roleTemplates.find((x) => x.key === template)!;
      subjects[who] = {
        kind: 'account',
        accountId: people[who]!,
        tenantId: county,
        tenantPath: c.path as string,
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
    }
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
      .where('slug', '=', slug)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('CON-11: the display account reads the briefing: counts, the shelter, the objectives, the log, the county interval', async () => {
    const res = await call<Briefing>('wall', `/briefing?eventId=${eventId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = res.body;
    expect(b.event.name).toBe(`Exercise wall event ${run}`);
    expect(b.refreshSeconds).toBe(30);
    expect(b.shelters).toEqual([
      { name: `Exercise shelter ${run}`, status: 'open', capacity: 220, occupancy: 180 },
    ]);
    expect(b.objectives).toEqual([
      {
        position: 1,
        objective: 'Shelter everyone displaced (exercise)',
        owner: 'Mass Care Coordinator',
        status: 'open',
      },
    ]);
    expect(b.significantEvents.map((e) => e.summary)).toEqual([
      'Exercise shelter opened with 220 cots',
    ]);
    expect(b.damage).toMatchObject({ verified: 0, awaitingReview: 0 });
    expect(b.liveConditions).toEqual([]);
  });

  it('plan §5: the payload has no personal field, by key and by content', async () => {
    const res = await call<Briefing>('wall', `/briefing?eventId=${eventId}`);
    const keys = allKeys(res.body);
    expect(keys.filter((k) => PERSONAL.test(k))).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.org|\(\d{3}\) \d{3}-\d{4}/);
  });

  it('the display account reads nothing else; a role without briefing.read does not see the wall', async () => {
    expect((await call('wall', `/reports?limit=1`)).status).toBe(403);
    expect((await call('wall', `/needs?eventId=${eventId}`)).status).toBe(403);
    expect((await call('wall', `/accounts`)).status).toBe(403);
    expect((await call('wall', `/events`)).status).toBe(200);
    expect((await call('pio', `/briefing?eventId=${eventId}`)).status).toBe(404);
    expect((await call('wall', `/briefing?eventId=${randomUUID()}`)).status).toBe(404);
  });
});

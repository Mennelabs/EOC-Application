/**
 * FL:FR-05, Q-04: the Waze for Cities closure feed. It is not found until the
 * county switches it on; then it lists, for the county's open events only, the
 * roads whose latest report is closed, impassable or one lane and not
 * cleared, each as a line; a road reopened or cleared since is not in it, and
 * a road drawn as a point is left out and named to staff. Staff see whether it
 * is on, its address and what is in it; other roles are refused. Runs on a
 * county of its own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Feed {
  incidents: { id: string; type: string; street: string; polyline: string }[];
}

describe.skipIf(!appUrl || !workerUrl)('Waze closure feed (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let slug = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const roads: Record<string, string> = {};

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    slug = `exercise-waze-${run}`;
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug,
        name: `Exercise Waze county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      const event = async (status: 'active' | 'closed') =>
        (
          await trx
            .insertInto('cg.event')
            .values({
              tenant_id: county,
              name: `Exercise Waze ${status} ${run}`,
              hazard_type: 'flood',
              status,
              opened_at: new Date(),
              ...(status === 'closed' ? { closed_at: new Date() } : {}),
            } as never)
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const open = await event('active');
      const closed = await event('closed');
      const line = sql`ST_SetSRID(ST_MakeLine(ST_MakePoint(-90.87, 38.79), ST_MakePoint(-90.869, 38.791)), 4326)`;
      const pt = sql`ST_SetSRID(ST_MakePoint(-90.86, 38.78), 4326)`;
      const add = async (
        key: string,
        eventId: string,
        name: string,
        status: string,
        geom: unknown,
        minutesAgo: number,
      ) => {
        roads[key] = (
          await trx
            .insertInto('cg.road_status')
            .values({
              tenant_id: county,
              event_id: eventId,
              name,
              status,
              geom,
              reason: key === 'closed' ? 'Water over the road' : null,
              reported_at: new Date(Date.now() - minutesAgo * 60_000),
            } as never)
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      };
      await add('closed', open, 'Exercise River Rd', 'closed', line, 30);
      await add('lane', open, 'Exercise Main St', 'one_lane', line, 30);
      await add('point', open, 'Exercise Low Rd', 'impassable', pt, 30);
      // Closed, then reopened: the latest report says open.
      await add('was', open, 'Exercise Bridge Rd', 'closed', line, 60);
      await add('reopened', open, 'Exercise Bridge Rd', 'open', line, 10);
      // A closure in an event already closed is not current.
      await add('old', closed, 'Exercise Old Rd', 'closed', line, 30);
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
      publicRoutes: [
        publicRoutes({
          resolver: new TenantResolver(dbApp),
          codes: new ReferenceCodeLeaser(dbApp, 'test'),
          risk: new RiskScorer(),
          getQueue: () => undefined,
          residentTokenSecret: 'test-secret-'.repeat(4),
          defaultGraph: westwindGraph,
        }),
      ],
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

  const feed = () => app.inject({ method: 'GET', url: `/api/public/waze/${slug}/cifs.json` });
  const staff = (who: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/integrations/waze',
      headers: { authorization: `Bearer ${who}` },
    });

  it('FL:FR-05: the feed is not found until the county switches it on; staff see it off', async () => {
    expect((await feed()).statusCode).toBe(404);
    expect((await staff('volunteer')).statusCode).toBe(403);
    const view = await staff('admin');
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({
      enabled: false,
      feedPath: `/api/public/waze/${slug}/cifs.json`,
    });
  });

  it('FL:FR-05: switched on, it lists the roads closed or down to one lane now, as lines; a point-only road is named to staff', async () => {
    await dbWorker
      .insertInto('cg.tenant_config')
      .values({ tenant_id: county, key: 'waze.feed_enabled', value: JSON.stringify(true) } as never)
      .execute();
    const res = await feed();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=60');
    const incidents = res.json<Feed>().incidents;
    // Both sides sorted: the ids are random, so their order is too.
    expect(incidents.map((i) => [i.id, i.type, i.street]).sort()).toEqual(
      [
        [`cg-${roads['closed']}`, 'ROAD_CLOSED', 'Exercise River Rd'],
        [`cg-${roads['lane']}`, 'HAZARD', 'Exercise Main St'],
      ].sort(),
    );
    expect(incidents[0]!.polyline.split(' ')).toHaveLength(4);
    const view = (await staff('admin')).json<{
      enabled: boolean;
      included: { street: string }[];
      leftOut: { name: string; reason: string }[];
    }>();
    expect(view.enabled).toBe(true);
    expect(view.included.map((i) => i.street).sort()).toEqual([
      'Exercise Main St',
      'Exercise River Rd',
    ]);
    expect(view.leftOut).toEqual([
      { name: 'Exercise Low Rd', reason: 'drawn as a point; Waze needs a line' },
    ]);
  });
});

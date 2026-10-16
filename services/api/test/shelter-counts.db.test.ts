/**
 * CON-16: shelter counts imported from the Red Cross system without personal
 * details. Mass care maps the file's columns; only the shelter id, name,
 * status, people staying, capacity and when it was counted are read, and a
 * file whose columns name people is refused whole. A bad row is named back
 * while the rest load; the same count is not loaded twice; a county site
 * carrying the shelter's id takes the newest count as its occupancy, and its
 * status stays with its confirmer. Importing needs a reason and is audited;
 * the EM director reads the counts, other roles are refused. Runs on a county
 * of its own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
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

const mapping = {
  externalRef: 'Shelter ID',
  name: 'Shelter Name',
  status: 'Status',
  population: 'Overnight Population',
  capacity: 'Evacuation Capacity',
  asOf: 'Report Time',
};
const HEADER =
  'Shelter ID,Shelter Name,Status,Overnight Population,Evacuation Capacity,Report Time,Shelter Phone,Notes';

describe.skipIf(!appUrl || !workerUrl)('Red Cross shelter counts (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let siteId = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};

  const call = async (
    who: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    reason = true,
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${who}`,
        'idempotency-key': randomUUID(),
        ...(reason
          ? { 'x-confirm': 'true', 'x-reason': 'Exercise: morning Red Cross report' }
          : {}),
      },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.body, json: <T>() => res.json() as T };
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
        slug: `exercise-shelters-${run}`,
        name: `Exercise shelters county ${run}`,
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
            name: `Exercise shelters storm ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      siteId = (
        await trx
          .insertInto('cg.site')
          .values({
            tenant_id: county,
            event_id: eventId,
            kind: 'shelter',
            name: 'Exercise Westwind High School',
            slug: `whs-${run}`,
            status: 'open',
            capacity: 200,
            occupancy: 10,
            external_ref: 'RC-1001',
          } as never)
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
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
    subjects['masscare'] = as('mass_care_coordinator');
    subjects['director'] = as('county_em_director');
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

  const morning = [
    HEADER,
    'RC-1001,Exercise Westwind High School,Open,85,200,2026-10-16T08:00:00Z,555-0100,quiet night',
    'RC-1002,"Exercise Harmon Church, Hall B",At Capacity,60,60,2026-10-16T08:00:00Z,,',
    'RC-1003,Exercise Bad Row,Open,eighty,100,2026-10-16T08:00:00Z,,',
    ',No id,Open,1,1,2026-10-16T08:00:00Z,,',
  ].join('\n');

  it('CON-16: a list of people is refused whole; the file loads counts only, names bad rows, never loads a count twice; a linked site takes the count as occupancy', async () => {
    const body = { eventId, csv: morning, mapping };
    expect((await call('volunteer', 'POST', '/shelter-counts/import', body)).status).toBe(403);
    expect((await call('director', 'POST', '/shelter-counts/import', body)).status).toBe(403);
    expect((await call('masscare', 'POST', '/shelter-counts/import', body, false)).status).toBe(
      428,
    );
    const roster = await call('masscare', 'POST', '/shelter-counts/import', {
      eventId,
      csv: 'Shelter ID,Shelter Name,First Name,Last Name,DOB\nRC-1001,Exercise Westwind High School,Ana,Ruiz,1980-01-01',
      mapping: { externalRef: 'Shelter ID', name: 'Shelter Name' },
    });
    expect(roster.status).toBe(400);
    expect(roster.body).toContain('personal_details');
    expect(roster.body).toContain('First Name');
    expect(roster.body).not.toContain('Ruiz');
    const wrongColumn = await call('masscare', 'POST', '/shelter-counts/import', {
      ...body,
      mapping: { ...mapping, population: 'People' },
    });
    expect(wrongColumn.status).toBe(400);

    const first = await call('masscare', 'POST', '/shelter-counts/import', body);
    expect(first.status, first.body).toBe(200);
    expect(first.json()).toEqual({
      imported: 2,
      duplicates: 0,
      sitesUpdated: 1,
      rejected: 2,
      problems: [
        { row: 4, reason: 'a count is not a whole number' },
        { row: 5, reason: 'no shelter id or name' },
      ],
    });
    const stored = await dbWorker
      .selectFrom('cg.shelter_count')
      .select(['external_ref', 'shelter_name', 'status', 'population', 'capacity', 'site_id'])
      .where('tenant_id', '=', county)
      .orderBy('external_ref')
      .execute();
    expect(stored).toEqual([
      {
        external_ref: 'RC-1001',
        shelter_name: 'Exercise Westwind High School',
        status: 'open',
        population: 85,
        capacity: 200,
        site_id: siteId,
      },
      {
        external_ref: 'RC-1002',
        shelter_name: 'Exercise Harmon Church, Hall B',
        status: 'full',
        population: 60,
        capacity: 60,
        site_id: null,
      },
    ]);
    const site = await dbWorker
      .selectFrom('cg.site')
      .select(['occupancy', 'status'])
      .where('id', '=', siteId)
      .executeTakeFirstOrThrow();
    expect(site).toEqual({ occupancy: 85, status: 'open' });

    const again = await call('masscare', 'POST', '/shelter-counts/import', body);
    expect(again.json()).toMatchObject({ imported: 0, duplicates: 2, sitesUpdated: 0 });
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('reason')
      .where('tenant_id', '=', county)
      .where('action', '=', 'shelter_count.import')
      .execute();
    expect(audited.length).toBeGreaterThanOrEqual(2);
    expect(audited[0]!.reason).toBe('Exercise: morning Red Cross report');
  });

  it('CON-16: the newest count per shelter, with its site when linked, and the totals; the EM director reads them, a volunteer does not', async () => {
    const noon = [
      HEADER,
      'RC-1001,Exercise Westwind High School,Full,90,200,2026-10-16T12:00:00Z,,',
    ].join('\n');
    const later = await call('masscare', 'POST', '/shelter-counts/import', {
      eventId,
      csv: noon,
      mapping,
    });
    expect(later.json()).toMatchObject({ imported: 1, sitesUpdated: 1 });
    const site = await dbWorker
      .selectFrom('cg.site')
      .select(['occupancy', 'status'])
      .where('id', '=', siteId)
      .executeTakeFirstOrThrow();
    // The count reaches the site; whether it is full is for its confirmer to say.
    expect(site).toEqual({ occupancy: 90, status: 'open' });
    expect(
      (await call('volunteer', 'GET', `/shelter-counts?eventId=${eventId}`, undefined, false))
        .status,
    ).toBe(403);
    const read = await call(
      'director',
      'GET',
      `/shelter-counts?eventId=${eventId}`,
      undefined,
      false,
    );
    expect(read.status, read.body).toBe(200);
    expect(read.json()).toEqual({
      shelters: [
        {
          externalRef: 'RC-1002',
          name: 'Exercise Harmon Church, Hall B',
          status: 'full',
          population: 60,
          capacity: 60,
          asOf: '2026-10-16T08:00:00.000Z',
          site: null,
        },
        {
          externalRef: 'RC-1001',
          name: 'Exercise Westwind High School',
          status: 'full',
          population: 90,
          capacity: 200,
          asOf: '2026-10-16T12:00:00.000Z',
          site: { id: siteId, name: 'Exercise Westwind High School' },
        },
      ],
      totals: { shelters: 2, population: 150, capacity: 260 },
    });
  });
});

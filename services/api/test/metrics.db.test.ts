/**
 * Metrics against the database (layer-6 task G; BRD:FR-14.01–14.07,
 * AC-14A/B/C, MET-05, MET-10): damage equals the Declaration screen's
 * counting rule and a degree filter narrows it; the CSV and the PDF carry
 * the same totals as the screen (AC-14C); a mission closed without a
 * disposition or only cleared is not a closed mission and is disclosed
 * (AC-14A, FR-14.07); a county version of a definition changes the figure
 * and is named; the period is bounded; reading and exporting are separate
 * permissions, exports are audited and refusals are counted (MET-10). Runs
 * only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import type { MetricsResult } from '@cg/reporting';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const HOUR = 3_600_000;

/** Parses this platform's CSV (quoted fields, doubled quotes, CRLF rows). */
function csvRows(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, '');
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && t[i + 1] === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return out;
}

describe.skipIf(!appUrl || !workerUrl)('metrics (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  const run = randomUUID().slice(0, 8);
  const people: Record<string, string> = {};
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(dbWorker, { tenantId: county }, fn);
  const from = new Date(Date.now() - 48 * HOUR).toISOString();

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-met-${run}`,
        name: `Exercise metrics county ${run}`,
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
        ['reviewer', 'Exercise Reviewer'],
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
            name: `Exercise metrics flood ${run}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(Date.now() - 72 * HOUR),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    await loadDamageReports(dbWorker, {
      tenantId: county,
      eventId,
      reviewerId: people['reviewer']!,
      count: 40,
      tag: `mt${run}`,
    });
    // AC-14A: closed with a disposition counts; cleared (the field's "done") does not.
    await tx(async (trx) => {
      const at = new Date(Date.now() - 2 * HOUR);
      const mission = (
        state: 'closed' | 'cleared' | 'open',
        disposition: 'completed' | null,
        n: number,
      ) => ({
        tenant_id: county,
        event_id: eventId,
        reference: `SYN-M-${run}-${n}`,
        kind: 'welfare_check' as const,
        source: 'staff' as const,
        state,
        disposition,
        created_at: new Date(at.getTime() - 5 * HOUR),
        ...(state === 'closed' ? { closed_at: at } : {}),
        ...(state === 'cleared' ? { cleared_at: at } : {}),
      });
      await trx
        .insertInto('cg.mission')
        .values([
          mission('closed', 'completed', 1),
          mission('cleared', null, 2),
          mission('open', null, 3),
        ])
        .execute();
    });

    const subject = (template: string, accountId: string = randomUUID()): AccountSubject => {
      const r = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId,
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
    };
    const subjects: Record<string, AccountSubject> = {
      director: subject('county_em_director', people['director']!),
      coordinator: subject('damage_assessment_coordinator'),
      admin: subject('tenant_admin', people['director']!),
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
      routes: routesWith({ metrics: { productName: 'Test Product' } }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', '=', `exercise-met-${run}`)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const get = async (who: string, url: string, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, ...headers },
    });
    return {
      status: res.statusCode,
      text: res.body,
      raw: res.rawPayload,
      json: <T = MetricsResult>() => res.json() as T,
    };
  };
  const metric = (r: MetricsResult, key: string) => r.metrics.find((m) => m.key === key)!;
  const q = `from=${encodeURIComponent(from)}`;

  it('AC-14B, BRD:FR-14.03: damage is the counting rule, verified apart from unverified; a degree filter narrows it', async () => {
    const res = await get('director', `/events/${eventId}/metrics?${q}`);
    expect(res.status, res.text).toBe(200);
    const r = res.json();
    const decl = (await get('director', `/events/${eventId}/declaration`)).json<{
      damage: { counted: { units: number; byDegree: Record<string, number> } };
    }>();
    const damage = metric(r, 'damage.units');
    expect(damage.value).toBe(decl.damage.counted.units);
    expect(damage.parts.find((p) => p.key === 'affected')!.value).toBe(
      decl.damage.counted.byDegree['affected'],
    );
    expect(damage.parts.some((p) => p.key === 'shown_apart_self_reported')).toBe(true);
    expect(damage.definition).toMatchObject({ source: 'shipped', version: 1 });
    const major = (await get('director', `/events/${eventId}/metrics?${q}&degree=major`)).json();
    expect(metric(major, 'damage.units').value).toBe(decl.damage.counted.byDegree['major']);
    expect(major.exclusions).toContain('Damage is limited to the degree shown.');
    expect(metric(r, 'reports.received').value).toBe(40);
  });

  it('AC-14A, BRD:FR-14.07: closed means the active definition; reviews not yet made are disclosed', async () => {
    const r = (await get('director', `/events/${eventId}/metrics?${q}`)).json();
    const closed = metric(r, 'missions.closed');
    expect(closed.value).toBe(1);
    expect(closed.parts).toEqual([{ key: 'completed', label: 'Completed', value: 1 }]);
    expect(
      metric(r, 'missions.by_state')
        .parts.map((p) => p.key)
        .sort(),
    ).toEqual(['cleared', 'closed', 'open']);
    expect(metric(r, 'missions.time_to_close').value).toBe(5);
    const review = metric(r, 'reports.time_to_review');
    const decided = review.parts.find((p) => p.key === 'reviewed')!.value!;
    expect(decided + (review.incomplete?.count ?? 0)).toBe(40);
    expect(
      r.trends.series.find((s) => s.key === 'missions.closed')!.values.reduce((a, b) => a + b, 0),
    ).toBe(1);
  });

  it('a county version of a definition changes the figure and names itself', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/definitions/metric.missions.closed',
      headers: {
        authorization: 'Bearer admin',
        'x-confirm': 'true',
        'x-reason': 'Exercise: count cleared missions as closed',
      },
      payload: {
        value: {
          text: 'Missions closed or cleared in the period (exercise county rule).',
          params: { closedStates: ['closed', 'cleared'], requireDisposition: false },
        },
      },
    });
    expect(put.statusCode, put.body).toBe(201);
    const r = (await get('director', `/events/${eventId}/metrics?${q}`)).json();
    const closed = metric(r, 'missions.closed');
    expect(closed.value).toBe(2);
    expect(closed.incomplete).toBeNull();
    expect(closed.definition).toMatchObject({ source: 'county', version: 1 });
    expect(closed.definition.text).toContain('exercise county rule');
  });

  it('AC-14C, BRD:FR-14.05/06: the CSV and the PDF carry the screen’s totals, definitions and time', async () => {
    const r = (await get('director', `/events/${eventId}/metrics?${q}`)).json();
    const csv = await get('director', `/events/${eventId}/metrics.csv?${q}`);
    expect(csv.status).toBe(200);
    const rows = csvRows(csv.text);
    const header = rows[0]!;
    const col = (name: string) => header.indexOf(name);
    for (const m of r.metrics) {
      const total = rows.find((x) => x[col('metric')] === m.title && x[col('part')] === 'Total')!;
      expect(total[col('value')]).toBe(m.value === null ? 'Unknown' : String(m.value));
      expect(total[col('definition')]).toBe(m.definition.key);
      expect(total[col('period_from')]).toBe(r.scope.from);
    }
    const pdf = await get('director', `/events/${eventId}/metrics.pdf?${q}`);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.subarray(0, 8).toString()).toBe('%PDF-1.7');
    // Nothing personal leaves.
    expect(csv.text).not.toMatch(/@example\.org/);
    expect(csv.text).not.toMatch(/SYN-mt/);
  });

  it('BRD:FR-14.02: the period is bounded and starts before it ends', async () => {
    const long = new Date(Date.now() - 100 * 24 * HOUR).toISOString();
    expect(
      (await get('director', `/events/${eventId}/metrics?from=${encodeURIComponent(long)}`)).status,
    ).toBe(400);
    const later = new Date(Date.now() + HOUR).toISOString();
    expect(
      (
        await get(
          'director',
          `/events/${eventId}/metrics?from=${encodeURIComponent(later)}&to=${encodeURIComponent(from)}`,
        )
      ).status,
    ).toBe(400);
  });

  it('MET-10: reading and exporting are separate; exports are audited; refusals are counted', async () => {
    expect((await get('coordinator', `/events/${eventId}/metrics?${q}`)).status).toBe(200);
    expect((await get('coordinator', `/events/${eventId}/metrics.csv?${q}`)).status).toBe(403);
    const exports = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['changes'])
        .where('action', '=', 'metric.export')
        .where('target_id', '=', eventId)
        .execute(),
    );
    expect(exports.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(exports[0]!.changes)).toContain(eventId);
    const r = (await get('director', `/events/${eventId}/metrics?${q}`)).json();
    expect(metric(r, 'accountability.denied').value).toBeGreaterThanOrEqual(1);
  });
});

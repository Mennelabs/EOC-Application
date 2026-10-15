/**
 * The equity dashboard and its alerts against the database (layer-6 task G;
 * EQ-11, EQ-12, EQ-13, CON-07): every tract of the county is in view, with
 * or without reports; each tract has an income band and rates against
 * households and residential structures; counts from 1 to 10 are hidden
 * and so is anything worked out from them; the worker raises a coverage
 * alert for each under-reported tract and band, once, and clears it when it
 * no longer holds; Spanish speakers made to wait longer for review raise a
 * review-gap alert with outreach in their language; an alert is
 * acknowledged with the outreach taken, under If-Match and audited; roles
 * without equity access are refused. Runs only with API_DB_TEST_APP_URL
 * and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { connectorFor, createRecordedHttp, recordingsDir, runPull } from '@cg/refdata';
import type { EquityData } from '@cg/reporting';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { evaluateEquityAlerts } from '../../worker/src/jobs/equity.ts';
import { assignBatch } from '../../worker/src/jobs/geography.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const HOUR = 3_600_000;

interface Alert {
  id: string;
  version: number;
  kind: string;
  subjectKind: string;
  subject: string;
  value: number | null;
  outreach: string;
  clearedAt: string | null;
  acknowledgedBy: string | null;
  actionTaken: string | null;
}
type Equity = Omit<EquityData, 'alerts'> & { alerts: Alert[] };

describe.skipIf(!appUrl || !workerUrl)('equity (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  const run = randomUUID().slice(0, 8);
  const people: Record<string, string> = {};
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(dbWorker, { tenantId: county }, fn);
  const worker = () =>
    ({
      db: dbWorker,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    }) as unknown as JobContext;
  const setRatio = (key: string, value: number) =>
    tx(async (trx) => {
      await trx.deleteFrom('cg.tenant_config').where('key', '=', key).execute();
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key, value: JSON.stringify(value) })
        .execute();
    });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-eq-${run}`,
        name: `Exercise equity county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    for (const dataset of ['tract', 'tract_profile', 'structure'] as const) {
      const connector = connectorFor(dataset);
      if (!connector || connector === 'import') throw new Error(`no ${dataset} connector`);
      await runPull(dbWorker, connector, {
        tenantId: county,
        mode: 'recorded',
        http: createRecordedHttp(recordingsDir),
        scope: { stateFips: '29', countyFips: ['29999'] },
        secrets: {},
        now: () => new Date(),
      });
    }
    eventId = await tx(async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: 'refdata.enabled', value: JSON.stringify(false) })
        .execute();
      for (const [who, name] of [
        ['director', 'Exercise EM Director'],
        ['afn', 'Exercise AFN Coordinator'],
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
            name: `Exercise equity flood ${run}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(Date.now() - 96 * HOUR),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    await loadDamageReports(dbWorker, {
      tenantId: county,
      eventId,
      reviewerId: people['director']!,
      count: 80,
      tag: `eq${run}`,
    });
    while ((await assignBatch(worker(), county)) > 0);
    // EQ-12: each reviewed report gets a synthetic reporter; Spanish speakers waited three days longer.
    await tx(async (trx) => {
      const reviewed = await trx
        .selectFrom('cg.report as r')
        .select('r.id')
        .where('r.event_id', '=', eventId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('cg.review_decision as d')
              .select('d.id')
              .whereRef('d.report_id', '=', 'r.id'),
          ),
        )
        .orderBy('r.reference_code')
        .execute();
      for (const [i, r] of reviewed.entries()) {
        const spanish = i % 3 === 0;
        const party = await trx
          .insertInto('cg.party')
          .values({ tenant_id: county, kind: 'resident', language: spanish ? 'es' : 'en' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('cg.report')
          .set({
            reporter_party_id: party.id,
            ...(spanish ? { submitted_at: new Date(Date.now() - 80 * HOUR) } : {}),
          })
          .where('id', '=', r.id)
          .execute();
      }
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
      afn: subject('afn_coordinator', people['afn']!),
      coordinator: subject('damage_assessment_coordinator'),
      pio: subject('public_information_officer'),
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
      .where('slug', '=', `exercise-eq-${run}`)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const call = async <T = Equity>(
    who: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as T, text: res.body };
  };

  it('EQ-11: every tract of the county is in view with its income band and rates', async () => {
    const r = await call('director', 'GET', `/events/${eventId}/equity`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.basis).toBe('county');
    expect(r.body.tracts.length).toBe(5);
    expect(r.body.tracts.every((t) => t.incomeBand !== null && t.households !== null)).toBe(true);
    expect(new Set(r.body.tracts.map((t) => t.incomeBand))).toEqual(new Set([1, 2, 3, 4, 5]));
    // Band 1 has the highest poverty share.
    const byBand = [...r.body.tracts].sort((a, b) => a.incomeBand! - b.incomeBand!);
    expect(byBand[0]!.povertyPct!).toBeGreaterThanOrEqual(byBand[4]!.povertyPct!);
    expect(r.body.tracts.some((t) => t.structures !== null && t.structures > 0)).toBe(true);
    const shown = r.body.tracts.find((t) => t.reports !== null && t.reports >= 11);
    expect(shown?.reportsPer100Structures).not.toBeNull();
  });

  it('EQ-13: counts from 1 to 10, and anything worked out from them, are hidden', async () => {
    const r = (await call('director', 'GET', `/events/${eventId}/equity`)).body;
    const small = (n: number | null) => n !== null && n > 0 && n < 11;
    for (const t of r.tracts) {
      expect(small(t.reports)).toBe(false);
      expect(small(t.needs)).toBe(false);
      if (t.reports === null) {
        expect(t.reportsPer100Structures).toBeNull();
        expect(t.reportsPer1000Households).toBeNull();
      }
    }
    for (const b of r.bands) if (b.reports === null) expect(b.rate).toBeNull();
    for (const g of r.groups) {
      expect(small(g.reports)).toBe(false);
      expect(small(g.needs)).toBe(false);
    }
    const text = JSON.stringify(r);
    expect(text).not.toContain('@example.org');
    expect(text).not.toMatch(/SYN-eq/);
  });

  it('CON-07: the worker raises a coverage alert for each under-reported tract and band, once, and clears it', async () => {
    // Every area below the best-covered band is flagged at a ratio of 1.
    await setRatio('equity.coverage_ratio', 1);
    await evaluateEquityAlerts(worker());
    const r = (await call('director', 'GET', `/events/${eventId}/equity`)).body;
    const coverage = r.alerts.filter((a) => a.kind === 'coverage' && !a.clearedAt);
    expect(coverage.length).toBeGreaterThan(0);
    const flagged = r.tracts.filter((t) => t.underReported).map((t) => t.geoid);
    expect(
      coverage
        .filter((a) => a.subjectKind === 'tract')
        .map((a) => a.subject)
        .sort(),
    ).toEqual(flagged.sort());
    for (const a of coverage) expect(a.outreach.length).toBeGreaterThan(20);
    await evaluateEquityAlerts(worker());
    const again = (await call('director', 'GET', `/events/${eventId}/equity`)).body;
    expect(again.alerts.filter((a) => a.kind === 'coverage' && !a.clearedAt)).toHaveLength(
      coverage.length,
    );
    const raised = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select('target_id')
        .where('action', '=', 'equity.alert_raised')
        .where(
          'target_id',
          'in',
          coverage.map((a) => a.id),
        )
        .execute(),
    );
    expect(raised).toHaveLength(coverage.length);
    // A lower bar: the condition no longer holds and the alerts clear.
    await setRatio('equity.coverage_ratio', 0.1);
    await evaluateEquityAlerts(worker());
    const later = (await call('director', 'GET', `/events/${eventId}/equity`)).body;
    expect(later.alerts.filter((a) => a.kind === 'coverage' && !a.clearedAt)).toHaveLength(0);
    expect(later.alerts.filter((a) => a.kind === 'coverage' && a.clearedAt).length).toBe(
      coverage.length,
    );
  });

  it('EQ-12: Spanish speakers waiting longer for review raise a gap alert with outreach in Spanish', async () => {
    await evaluateEquityAlerts(worker());
    const r = (await call('afn', 'GET', `/events/${eventId}/equity`)).body;
    const es = r.groups.find((g) => g.dimension === 'language' && g.group === 'es')!;
    expect(es.reviewGap).toBe(true);
    // Reviewed at once otherwise, so the event's median is near zero: the gap still shows.
    expect(es.reviewMedianHours!).toBeGreaterThan(r.eventMedians.reviewHours! * 1.5 + 1);
    expect(r.groups.find((g) => g.dimension === 'language' && g.group === 'en')!.reviewGap).toBe(
      false,
    );
    const alert = r.alerts.find(
      (a) => a.kind === 'review_gap' && a.subjectKind === 'language' && a.subject === 'es',
    )!;
    expect(alert.outreach).toContain('Spanish');
  });

  it('an alert is acknowledged with the outreach taken, under If-Match; others are refused', async () => {
    const r = (await call('afn', 'GET', `/events/${eventId}/equity`)).body;
    const alert = r.alerts.find((a) => a.kind === 'review_gap' && !a.clearedAt)!;
    const url = `/equity-alerts/${alert.id}/acknowledge`;
    const action = {
      actionTaken: 'Exercise: two Spanish-speaking reviewers assigned to the queue.',
    };
    expect((await call('afn', 'POST', url, action)).status).toBe(428);
    expect(
      (await call('afn', 'POST', url, { actionTaken: 'ok' }, { 'if-match': `"${alert.version}"` }))
        .status,
    ).toBe(400);
    expect(
      (await call('coordinator', 'POST', url, action, { 'if-match': `"${alert.version}"` })).status,
    ).toBe(404);
    const done = await call<Alert>('afn', 'POST', url, action, {
      'if-match': `"${alert.version}"`,
    });
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({
      acknowledgedBy: 'Exercise AFN Coordinator',
      actionTaken: action.actionTaken,
    });
    expect(
      (await call('afn', 'POST', url, action, { 'if-match': `"${alert.version}"` })).status,
    ).toBe(409);
    const audit = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select('action')
        .where('target_id', '=', alert.id)
        .where('action', '=', 'equity.act')
        .execute(),
    );
    expect(audit).toHaveLength(1);
    expect((await call('pio', 'GET', `/events/${eventId}/equity`)).status).toBe(403);
  });
});

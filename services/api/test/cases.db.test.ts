/**
 * Case management on the shared record against the database (FL-13, FL-03,
 * FL:FR-07, FL:FR-18, SEC-05, SEC-11, SEC-18, RULE-10, RULE-14). The county's
 * caseworker opens a case on a report; a partner holding a share grant for
 * that report reaches the same case and logs help it gave; the duplication
 * check totals every standing dollar by source and type; a role without the
 * financial category sees that help was given and never how much; an entry
 * is voided with a reason and stays visible; a partner without a grant, or
 * whose grant was revoked, finds nothing; the plan is kept with versions;
 * closing takes a version and a reason and stops further entries. Runs only
 * with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
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

interface Help {
  id: string;
  sourceKind: string;
  sourceName: string;
  helpType: string;
  description: string | null;
  amount: number | null;
  recordedBy: string | null;
  recordedByTenant: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}
interface PlanItem {
  id: string;
  version: number;
  unmet: string;
  status: string;
  dueOn: string | null;
  ownerLabel: string | null;
  note: string | null;
}
interface Case {
  id: string;
  version: number;
  reportId: string;
  referenceCode: string | null;
  status: string;
  leadTenantId: string;
  leadIsYou: boolean;
  openedBy: string | null;
  closedBy: string | null;
  closeReason: string | null;
  financialVisible: boolean;
  openPlanItems: number;
  helpEntries: number;
  helpReceived: Help[];
  recoveryPlan: PlanItem[];
  code?: string;
}
interface Duplication {
  entries: number;
  entriesWithoutAmount: number;
  total: number;
  bySource: { sourceKind: string; entries: number; total: number }[];
  byType: { helpType: string; entries: number; total: number }[];
}

describe.skipIf(!appUrl || !workerUrl)('case management (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let partner = '';
  let eventId = '';
  let reportId = '';
  let withdrawnReportId = '';
  let grantId = '';
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-cases-${run}`;
  const people: Record<string, string> = {};
  const subjects: Record<string, AccountSubject> = {};

  const call = async <T>(
    who: string,
    method: 'GET' | 'POST' | 'PATCH',
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
    return { status: res.statusCode, body: res.json() as T };
  };
  const confirmed = (reason: string, version?: number) => ({
    'x-confirm': 'true',
    'x-reason': reason,
    ...(version !== undefined ? { 'if-match': `"${version}"` } : {}),
  });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const tenant = (kind: 'county' | 'partner_org', parent: string, key: string) =>
      dbWorker
        .insertInto('cg.tenant')
        .values({
          kind,
          parent_id: parent,
          slug: `${slug}-${key}`,
          name: `Exercise ${key} ${run}`,
          status: 'active',
          locales: ['en', 'es'],
          timezone: 'America/Chicago',
        })
        .returning(['id', 'path', 'kind'])
        .executeTakeFirstOrThrow();
    const c = await tenant('county', seeded.tenants['region']!, 'county');
    county = c.id;
    const p = await tenant('partner_org', county, 'partner');
    partner = p.id;
    const x = await tenant('partner_org', county, 'stranger');
    const cast = [
      ['caseworker', 'county_caseworker', 'Exercise County Caseworker', c],
      ['director', 'county_em_director', 'Exercise EM Director', c],
      ['pio', 'public_information_officer', 'Exercise PIO', c],
      ['casemgr', 'case_manager', 'Exercise Partner Case Manager', p],
      ['sba', 'sba_representative', 'Exercise SBA Representative', p],
      ['outsider', 'case_manager', 'Exercise Stranger Case Manager', x],
    ] as const;
    for (const [who, , name, t] of cast)
      await withTenant(dbWorker, { tenantId: t.id }, async (trx) => {
        people[who] = (
          await trx
            .insertInto('cg.account')
            .values({
              tenant_id: t.id,
              email: `${who}-${run}@example.org`,
              display_name: name,
              status: 'active',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      });
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      eventId = (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise case event ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            intake_slug: `caseex${run}`,
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const report = (withdrawn: boolean) =>
        trx
          .insertInto('cg.report')
          .values({
            tenant_id: county,
            event_id: eventId,
            reference_code: `SYN-${run}-${withdrawn ? 'W' : 'A'}`,
            execution_id: randomUUID(),
            graph_key: 'damage',
            graph_version: 1,
            channel_of_origin: 'web',
            relationship: 'own_home',
            ...(withdrawn ? { withdrawn_at: new Date() } : {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      reportId = (await report(false)).id;
      withdrawnReportId = (await report(true)).id;
      // The survivor consented to the partner: the worker's grant stands in for that consent.
      grantId = (
        await trx
          .insertInto('cg.share_grant')
          .values({
            tenant_id: county,
            to_tenant_id: partner,
            org_type: 'case_management',
            report_id: reportId,
            sections: ['name', 'contact', 'need', 'recovery_plan', 'help_received', 'appointments'],
            projection: JSON.stringify({ referenceCode: `SYN-${run}-A` }),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    for (const [who, template, , t] of cast) {
      const r = roleTemplates.find((x) => x.key === template)!;
      subjects[who] = {
        kind: 'account',
        accountId: people[who]!,
        tenantId: t.id,
        tenantPath: t.path as string,
        tenantKind: t.kind,
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
      .where('slug', 'like', `${slug}-%`)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  let kase: Case;

  it('FL:FR-07: the county caseworker opens one case per report; opening again returns it; a withdrawn report has none; the PIO may not', async () => {
    const res = await call<Case>('caseworker', 'POST', '/cases', { reportId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    kase = res.body;
    expect(kase).toMatchObject({
      reportId,
      referenceCode: `SYN-${run}-A`,
      status: 'open',
      leadTenantId: county,
      leadIsYou: true,
      openedBy: 'Exercise County Caseworker',
      financialVisible: true,
      helpEntries: 0,
      openPlanItems: 0,
    });
    const again = await call<Case>('caseworker', 'POST', '/cases', { reportId });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(kase.id);
    expect(
      (await call('caseworker', 'POST', '/cases', { reportId: withdrawnReportId })).status,
    ).toBe(404);
    expect((await call('pio', 'POST', '/cases', { reportId })).status).toBe(403);
    expect((await call('pio', 'GET', `/cases/${kase.id}`)).status).toBe(404);
  });

  it('FL-13: help received is logged with source, type and dollar value by the county and by partners holding the grant', async () => {
    const fema = await call<Case>('caseworker', 'POST', `/cases/${kase.id}/help`, {
      sourceKind: 'fema_ia',
      sourceName: 'FEMA Individual Assistance (exercise)',
      helpType: 'Rental assistance',
      description: 'Two months, initial award',
      amount: 2950,
      givenOn: '2026-10-10',
    });
    expect(fema.status, JSON.stringify(fema.body)).toBe(201);
    expect(fema.body.helpReceived[0]).toMatchObject({
      sourceKind: 'fema_ia',
      amount: 2950,
      description: 'Two months, initial award',
      recordedBy: 'Exercise County Caseworker',
    });
    const insurance = await call<Case>('caseworker', 'POST', `/cases/${kase.id}/help`, {
      sourceKind: 'insurance',
      sourceName: 'Exercise Mutual Insurance',
      helpType: 'Structure claim advance',
      amount: 10000,
      givenOn: '2026-10-12',
    });
    expect(insurance.status).toBe(201);
    // The partner's case manager reaches the county's case through its grant and logs its grant.
    const ngo = await call<Case>('casemgr', 'POST', `/cases/${kase.id}/help`, {
      sourceKind: 'ngo_grant',
      sourceName: `Exercise partner ${run}`,
      sourceTenantId: partner,
      helpType: 'Appliance replacement grant',
      amount: 1200,
      givenOn: '2026-10-14',
    });
    expect(ngo.status, JSON.stringify(ngo.body)).toBe(201);
    expect(ngo.body.leadIsYou).toBe(false);
    expect(ngo.body.helpReceived.find((h) => h.sourceKind === 'ngo_grant')).toMatchObject({
      recordedBy: 'Exercise Partner Case Manager',
      recordedByTenant: `Exercise partner ${run}`,
      amount: 1200,
    });
    // The SBA representative logs the loan; goods without a dollar value are allowed.
    const sba = await call<Case>('sba', 'POST', `/cases/${kase.id}/help`, {
      sourceKind: 'sba_loan',
      sourceName: 'SBA disaster loan (exercise)',
      helpType: 'Home repair loan',
      amount: 20000,
      givenOn: '2026-10-15',
    });
    expect(sba.status, JSON.stringify(sba.body)).toBe(201);
    const goods = await call<Case>('caseworker', 'POST', `/cases/${kase.id}/help`, {
      sourceKind: 'goods',
      sourceName: 'Hope Canteen Services',
      helpType: 'Clean-up kit',
      amount: null,
      givenOn: '2026-10-09',
    });
    expect(goods.status).toBe(201);
    expect(goods.body.helpEntries).toBe(5);
    // A negative dollar value is refused.
    expect(
      (
        await call('caseworker', 'POST', `/cases/${kase.id}/help`, {
          sourceKind: 'other',
          sourceName: 'x',
          helpType: 'y',
          amount: -1,
          givenOn: '2026-10-09',
        })
      ).status,
    ).toBe(400);
  });

  it('FL-13: the duplication check totals every standing dollar by source and type', async () => {
    const res = await call<Duplication>('caseworker', 'GET', `/cases/${kase.id}/duplication`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entries: 5, entriesWithoutAmount: 1, total: 34150 });
    expect(res.body.bySource.map((s) => [s.sourceKind, s.total])).toEqual([
      ['sba_loan', 20000],
      ['insurance', 10000],
      ['fema_ia', 2950],
      ['ngo_grant', 1200],
      ['goods', 0],
    ]);
    expect(res.body.byType.find((t) => t.helpType === 'Home repair loan')).toEqual({
      helpType: 'Home repair loan',
      entries: 1,
      total: 20000,
    });
    // The partner's case manager holds the financial category and sees the same totals.
    const viaGrant = await call<Duplication>('casemgr', 'GET', `/cases/${kase.id}/duplication`);
    expect(viaGrant.status).toBe(200);
    expect(viaGrant.body.total).toBe(34150);
  });

  it('SEC-11: a role without the financial category sees that help was given, never how much; the duplication check is refused', async () => {
    const res = await call<Case>('director', 'GET', `/cases/${kase.id}`);
    expect(res.status).toBe(200);
    expect(res.body.financialVisible).toBe(false);
    expect(res.body.helpEntries).toBe(5);
    expect(res.body.helpReceived.map((h) => h.amount)).toEqual([null, null, null, null, null]);
    // Free text is not in the director's categories either.
    expect(res.body.helpReceived.find((h) => h.sourceKind === 'fema_ia')!.description).toBeNull();
    expect((await call('director', 'GET', `/cases/${kase.id}/duplication`)).status).toBe(403);
    expect(
      (
        await call('director', 'POST', `/cases/${kase.id}/help`, {
          sourceKind: 'other',
          sourceName: 'x',
          helpType: 'y',
          givenOn: '2026-10-09',
        })
      ).status,
    ).toBe(403);
  });

  it('SEC-05: a partner without a grant for the report finds nothing; the list shows each organization its own view', async () => {
    expect((await call('outsider', 'GET', `/cases/${kase.id}`)).status).toBe(404);
    expect((await call('outsider', 'POST', '/cases', { reportId })).status).toBe(404);
    expect((await call('outsider', 'GET', '/cases')).body).toEqual({ items: [] });
    const mine = await call<{ items: Case[] }>('casemgr', 'GET', '/cases');
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((c) => c.id)).toEqual([kase.id]);
    const countyList = await call<{ items: Case[] }>(
      'caseworker',
      'GET',
      `/cases?eventId=${eventId}`,
    );
    expect(countyList.body.items.map((c) => [c.id, c.status])).toEqual([[kase.id, 'open']]);
    expect(
      (await call<{ items: Case[] }>('caseworker', 'GET', '/cases?status=closed')).body.items,
    ).toEqual([]);
  });

  it('RULE-10, RULE-14: an entry is voided with a reason, never deleted; an organization voids its own, the county any; totals drop', async () => {
    const view = await call<Case>('caseworker', 'GET', `/cases/${kase.id}`);
    const ngo = view.body.helpReceived.find((h) => h.sourceKind === 'ngo_grant')!;
    const sba = view.body.helpReceived.find((h) => h.sourceKind === 'sba_loan')!;
    const fema = view.body.helpReceived.find((h) => h.sourceKind === 'fema_ia')!;
    // No confirmation and reason: 428.
    expect((await call('casemgr', 'POST', `/cases/${kase.id}/help/${ngo.id}/void`)).status).toBe(
      428,
    );
    // The SBA representative may not void the county's entry.
    expect(
      (
        await call(
          'sba',
          'POST',
          `/cases/${kase.id}/help/${fema.id}/void`,
          undefined,
          confirmed('Not ours'),
        )
      ).status,
    ).toBe(403);
    const voided = await call<Case>(
      'casemgr',
      'POST',
      `/cases/${kase.id}/help/${ngo.id}/void`,
      undefined,
      confirmed('Entered on the wrong household (exercise)'),
    );
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.helpReceived.find((h) => h.id === ngo.id)).toMatchObject({
      voidReason: 'Entered on the wrong household (exercise)',
      amount: 1200,
    });
    expect(voided.body.helpReceived.find((h) => h.id === ngo.id)!.voidedAt).not.toBeNull();
    // The county voids the SBA entry; voiding twice is a conflict.
    const county2 = await call<Case>(
      'caseworker',
      'POST',
      `/cases/${kase.id}/help/${sba.id}/void`,
      undefined,
      confirmed('Loan declined after the entry (exercise)'),
    );
    expect(county2.status).toBe(200);
    expect(
      (
        await call(
          'caseworker',
          'POST',
          `/cases/${kase.id}/help/${sba.id}/void`,
          undefined,
          confirmed('Again'),
        )
      ).status,
    ).toBe(409);
    const dup = await call<Duplication>('caseworker', 'GET', `/cases/${kase.id}/duplication`);
    expect(dup.body).toMatchObject({ entries: 3, total: 12950 });
    expect(county2.body.helpEntries).toBe(3);
    // Voided rows stay in the record.
    expect(county2.body.helpReceived).toHaveLength(5);
  });

  it('FL:FR-18: the recovery plan lists what is unmet, who owns it and by when; changes take the version', async () => {
    const added = await call<Case>('caseworker', 'POST', `/cases/${kase.id}/plan`, {
      unmet: 'Roof repair before the first frost',
      ownerTenantId: partner,
      dueOn: '2026-11-15',
      note: 'Two estimates still needed',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const item = added.body.recoveryPlan[0]!;
    expect(item).toMatchObject({
      status: 'open',
      dueOn: '2026-11-15',
      note: 'Two estimates still needed',
    });
    expect(added.body.openPlanItems).toBe(1);
    // The partner updates the item it owns, with the version.
    const stale = await call<Case>(
      'casemgr',
      'PATCH',
      `/cases/${kase.id}/plan/${item.id}`,
      { status: 'in_progress' },
      { 'if-match': `"${item.version + 5}"` },
    );
    expect(stale.status).toBe(409);
    const moved = await call<Case>(
      'casemgr',
      'PATCH',
      `/cases/${kase.id}/plan/${item.id}`,
      { status: 'in_progress', ownerLabel: 'Repair crew B' },
      { 'if-match': `"${item.version}"` },
    );
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.recoveryPlan[0]).toMatchObject({
      status: 'in_progress',
      ownerLabel: 'Repair crew B',
      version: item.version + 1,
    });
    // The SBA representative keeps no plan.
    expect((await call('sba', 'POST', `/cases/${kase.id}/plan`, { unmet: 'x' })).status).toBe(403);
  });

  it('SEC-18: every read is audited with the categories read and whether it came through a grant', async () => {
    const rows = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['actor_account_id', 'changes'])
      .where('tenant_id', '=', county)
      .where('action', '=', 'case.read')
      .where('target_id', '=', kase.id)
      .execute();
    const byPartner = rows.filter((r) => r.actor_account_id === people['casemgr']);
    expect(byPartner.length).toBeGreaterThan(0);
    expect(JSON.stringify(byPartner[0]!.changes)).toContain('"via_grant"');
    expect(JSON.stringify(byPartner[0]!.changes)).toContain('"true"');
    const dupReads = rows.filter((r) => JSON.stringify(r.changes).includes('duplication'));
    expect(dupReads.length).toBeGreaterThan(0);
    expect(JSON.stringify(dupReads[0]!.changes)).toContain('financial');
  });

  it('SEC-05: when the grant is revoked the partner finds nothing; the county still does', async () => {
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.share_grant')
        .set({ revoked_at: new Date(), revoke_reason: 'consent withdrawn (exercise)' })
        .where('id', '=', grantId)
        .execute(),
    );
    expect((await call('casemgr', 'GET', `/cases/${kase.id}`)).status).toBe(404);
    expect((await call('casemgr', 'GET', '/cases')).body).toEqual({ items: [] });
    expect((await call('caseworker', 'GET', `/cases/${kase.id}`)).status).toBe(200);
  });

  it('RULE-14: closing takes the version and a reason; a closed case takes no more entries', async () => {
    const current = (await call<Case>('caseworker', 'GET', `/cases/${kase.id}`)).body;
    expect(
      (await call('caseworker', 'POST', `/cases/${kase.id}/close`, undefined, confirmed('Done')))
        .status,
    ).toBe(428);
    expect(
      (
        await call('caseworker', 'POST', `/cases/${kase.id}/close`, undefined, {
          'if-match': `"${current.version}"`,
        })
      ).status,
    ).toBe(428);
    const closed = await call<Case>(
      'caseworker',
      'POST',
      `/cases/${kase.id}/close`,
      undefined,
      confirmed('Recovery plan met; household rehoused (exercise)', current.version),
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({
      status: 'closed',
      closedBy: 'Exercise County Caseworker',
      closeReason: 'Recovery plan met; household rehoused (exercise)',
    });
    expect(
      (
        await call('caseworker', 'POST', `/cases/${kase.id}/help`, {
          sourceKind: 'other',
          sourceName: 'x',
          helpType: 'y',
          givenOn: '2026-10-09',
        })
      ).status,
    ).toBe(409);
    expect(
      (await call<{ items: Case[] }>('caseworker', 'GET', '/cases?status=closed')).body.items.map(
        (c) => c.id,
      ),
    ).toEqual([kase.id]);
  });
});

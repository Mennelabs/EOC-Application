/**
 * Resource requests to the state (CON-13, the ICS 213 RR blocks; ADM-05 G4;
 * RULE-14), against the database. A section drafts a request, submits it with
 * a reason, a second person approves it as section chief (never the
 * submitter), logistics places it with the state and records the state's
 * number, then marks it en route and received. Finance's reply is required
 * before placing only when the county sets a threshold. A site's supply
 * request can be raised to one. Every step is in the history. Runs only with
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
import { FINANCE_THRESHOLD_KEY } from '../src/routes/resource-requests.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface RR {
  id: string;
  version: number;
  requestNumber: string;
  status: string;
  priority: string;
  supplyRequestId: string | null;
  deliveryLocation: string | null;
  requestedByName: string;
  requestedByPosition: string | null;
  costEstimate: number | null;
  financeReply: string | null;
  financeReplyNeeded: boolean;
  submittedBy: string | null;
  submittedByYou: boolean;
  approvedBy: string | null;
  placedWith: string | null;
  stateTrackingNumber: string | null;
  receivedAt: string | null;
  lines: { lineNo: number; quantity: number; unit: string | null; kind: string }[];
  steps: {
    step: string;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string | null;
    actorName: string | null;
  }[];
  code?: string;
}

describe.skipIf(!appUrl || !workerUrl)('resource requests to the state (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let supplyRequestId = '';
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-rr-${run}`;
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
  const step = (who: string, r: RR, op: string, reason?: string, body?: unknown) =>
    call<RR>(who, 'POST', `/resource-requests/${r.id}/${op}`, body, {
      'if-match': `"${r.version}"`,
      ...(reason ? { 'x-confirm': 'true', 'x-reason': reason } : {}),
    });
  const stepNames = (r: RR) => r.steps.map((s) => s.step);

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
        name: `Exercise resource request county ${run}`,
        status: 'active',
        locales: ['en', 'es'],
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const cast = [
      ['masscare', 'mass_care_coordinator', 'Exercise Mass Care Coordinator'],
      ['director', 'county_em_director', 'Exercise EM Director'],
      ['logistics', 'field_coordinator', 'Exercise Field Operations Coordinator'],
      ['reporter', 'reporting_planning', 'Exercise Reporting Staff'],
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
            name: `Exercise resource request event ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            intake_slug: `rrex${run}`,
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // FL:FR-21: a shelter's supply request, sent and waiting to be filled.
      const site = await trx
        .insertInto('cg.site')
        .values({
          tenant_id: county,
          event_id: eventId,
          kind: 'shelter',
          name: `Exercise shelter ${run}`,
          slug: `shelter-${run}`,
          created_by: null,
          updated_by: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      supplyRequestId = (
        await trx
          .insertInto('cg.supply_request')
          .values({
            tenant_id: county,
            site_id: site.id,
            client_uuid: null,
            status: 'sent',
            lines: JSON.stringify([
              { stockItemId: randomUUID(), name: 'Cots', unit: 'each', quantity: 60 },
              { stockItemId: randomUUID(), name: 'Blankets', unit: 'each', quantity: 120 },
            ]),
            note: null,
            sent_at: new Date(),
            sent_by: null,
            filled_at: null,
            filled_by: null,
            mission_id: null,
            canceled_at: null,
            canceled_by: null,
            created_by: null,
            updated_by: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
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

  let rr: RR;

  it('CON-13: mass care drafts a request in the 213 RR blocks; it is numbered per event and the draft is a step', async () => {
    const res = await call<RR>('masscare', 'POST', '/resource-requests', {
      eventId,
      priority: 'urgent',
      deliveryLocation: 'Exercise shelter, loading dock',
      requestedByPosition: 'Mass Care Coordinator',
      lines: [
        { quantity: 200, unit: 'each', kind: 'Cots', type: 'Standard shelter cot' },
        { quantity: 400, unit: 'each', kind: 'Blankets' },
      ],
      costEstimate: 18400,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    rr = res.body;
    expect(rr).toMatchObject({
      requestNumber: `RREX${run.toUpperCase()}-RR-0001`,
      status: 'draft',
      priority: 'urgent',
      requestedByName: 'Exercise Mass Care Coordinator',
      requestedByPosition: 'Mass Care Coordinator',
      costEstimate: 18400,
      financeReplyNeeded: false,
      submittedBy: null,
    });
    expect(rr.lines.map((l) => [l.lineNo, l.kind, l.quantity])).toEqual([
      [1, 'Cots', 200],
      [2, 'Blankets', 400],
    ]);
    expect(stepNames(rr)).toEqual(['drafted']);
    // Lines are things, never a resident: a line needs a kind and a positive count.
    expect(
      (
        await call('masscare', 'POST', '/resource-requests', {
          eventId,
          lines: [{ quantity: 0, kind: 'Cots' }],
        })
      ).status,
    ).toBe(400);
    // The PIO has no part in resource requests; reporting staff read only.
    expect((await call('pio', 'GET', '/resource-requests')).status).toBe(403);
    expect((await call('pio', 'GET', `/resource-requests/${rr.id}`)).status).toBe(404);
    expect((await call('reporter', 'GET', `/resource-requests/${rr.id}`)).status).toBe(200);
    expect(
      (await call('reporter', 'POST', '/resource-requests', { eventId, lines: [] })).status,
    ).toBe(403);
  });

  it('a draft is changed with its version; changing replaces the lines and is a step', async () => {
    const stale = await call<RR>(
      'masscare',
      'PATCH',
      `/resource-requests/${rr.id}`,
      { notes: 'Stale' },
      { 'if-match': `"${rr.version + 5}"` },
    );
    expect(stale.status).toBe(409);
    const changed = await call<RR>(
      'masscare',
      'PATCH',
      `/resource-requests/${rr.id}`,
      {
        notes: 'Shelter at 180 of 220 after the second night.',
        lines: [
          { quantity: 220, unit: 'each', kind: 'Cots' },
          { quantity: 440, unit: 'each', kind: 'Blankets' },
          { quantity: 2, unit: 'pallets', kind: 'Hygiene kits', type: 'Adult' },
        ],
      },
      { 'if-match': `"${rr.version}"` },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    rr = changed.body;
    expect(rr.lines).toHaveLength(3);
    expect(rr.lines[0]).toMatchObject({ lineNo: 1, quantity: 220 });
    expect(stepNames(rr)).toEqual(['drafted', 'changed']);
  });

  it('RULE-14, ADM-05 G4: submitting takes a reason; the submitter cannot approve; the director approves as section chief', async () => {
    // No confirmation and reason: asked for, not done.
    expect((await step('masscare', rr, 'submit')).status).toBe(428);
    const submitted = await step('masscare', rr, 'submit', 'Exercise: shelter near capacity');
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    rr = submitted.body;
    expect(rr).toMatchObject({
      status: 'submitted',
      submittedBy: 'Exercise Mass Care Coordinator',
      submittedByYou: true,
    });
    // A submitted request is no longer edited.
    expect(
      (
        await call(
          'masscare',
          'PATCH',
          `/resource-requests/${rr.id}`,
          { notes: 'x' },
          {
            'if-match': `"${rr.version}"`,
          },
        )
      ).status,
    ).toBe(409);
    // The submitter holds no approve grant; logistics neither.
    expect((await step('masscare', rr, 'approve', 'Exercise: mine')).status).toBe(403);
    expect((await step('logistics', rr, 'approve', 'Exercise: ok')).status).toBe(403);
    // Not yet approved: cannot be placed.
    expect(
      (await step('logistics', rr, 'place', 'Exercise: too soon', { with: 'state' })).status,
    ).toBe(409);
    const approved = await step(
      'director',
      rr,
      'approve',
      'Exercise: confirmed with the shelter manager',
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    rr = approved.body;
    expect(rr).toMatchObject({ status: 'approved', approvedBy: 'Exercise EM Director' });
    expect(stepNames(rr)).toEqual(['drafted', 'changed', 'submitted', 'approved']);
    expect(rr.steps.at(-1)).toMatchObject({
      fromStatus: 'submitted',
      toStatus: 'approved',
      reason: 'Exercise: confirmed with the shelter manager',
      actorName: 'Exercise EM Director',
    });
  });

  it('G4 at the engine: a director who submitted a request cannot approve it', async () => {
    const own = await call<RR>('director', 'POST', '/resource-requests', {
      eventId,
      lines: [{ quantity: 4, unit: 'each', kind: 'Generators', type: 'Towable, 20 kW' }],
    });
    expect(own.status).toBe(201);
    expect(own.body.requestNumber).toBe(`RREX${run.toUpperCase()}-RR-0002`);
    const sent = await step(
      'director',
      own.body,
      'submit',
      'Exercise: power out on Commercial Row',
    );
    expect(sent.status).toBe(200);
    const self = await step('director', sent.body, 'approve', 'Exercise: approving my own');
    expect(self.status).toBe(403);
    // It stays submitted and can be cancelled with a reason.
    const cancelled = await step(
      'director',
      sent.body,
      'cancel',
      'Exercise: generators found locally',
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await step('director', cancelled.body, 'submit', 'Exercise: again')).status).toBe(409);
  });

  it("plan §13: finance's reply is required before placing only when the county sets a threshold", async () => {
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: FINANCE_THRESHOLD_KEY, value: JSON.stringify(10000) })
        .execute(),
    );
    const now = await call<RR>('logistics', 'GET', `/resource-requests/${rr.id}`);
    expect(now.body.financeReplyNeeded).toBe(true);
    const blocked = await step('logistics', rr, 'place', 'Exercise: placing', {
      with: 'state',
      stateTrackingNumber: 'SEMA-EX-4471',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('finance_reply_required');
    const replied = await step('director', rr, 'finance', undefined, {
      reply: 'Exercise: approved against the shelter operations line',
    });
    expect(replied.status, JSON.stringify(replied.body)).toBe(200);
    rr = replied.body;
    expect(rr.financeReplyNeeded).toBe(false);
    expect(stepNames(rr)).toContain('finance_replied');
  });

  it('logistics places it with the state and records the state number; en route, then received; the history is complete', async () => {
    // The reader may not place.
    expect((await step('reporter', rr, 'place', 'Exercise', { with: 'state' })).status).toBe(403);
    const placed = await step('logistics', rr, 'place', 'Exercise: placed with state logistics', {
      with: 'state',
      stateTrackingNumber: 'SEMA-EX-4471',
      eta: new Date(Date.now() + 36e5).toISOString(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    rr = placed.body;
    expect(rr).toMatchObject({
      status: 'placed',
      placedWith: 'state',
      stateTrackingNumber: 'SEMA-EX-4471',
    });
    // Received cannot come before placing is recorded twice; en route then received.
    expect((await step('logistics', rr, 'place', 'Exercise', { with: 'state' })).status).toBe(409);
    const moving = await step('logistics', rr, 'status', undefined, { status: 'en_route' });
    expect(moving.status, JSON.stringify(moving.body)).toBe(200);
    rr = moving.body;
    const received = await step('masscare', rr, 'status', undefined, { status: 'received' });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    rr = received.body;
    expect(rr.status).toBe('received');
    expect(rr.receivedAt).not.toBeNull();
    expect(stepNames(rr)).toEqual([
      'drafted',
      'changed',
      'submitted',
      'approved',
      'finance_replied',
      'placed',
      'en_route',
      'received',
    ]);
    // Nothing follows received.
    expect((await step('director', rr, 'cancel', 'Exercise: late')).status).toBe(409);
    // The list filters by event and status, urgent first.
    const list = await call<RR[]>(
      'reporter',
      'GET',
      `/resource-requests?eventId=${eventId}&status=received`,
    );
    expect(list.status).toBe(200);
    expect(list.body.map((r) => r.id)).toEqual([rr.id]);
    // Audit holds every step (FR-00.*, SEC-11).
    const audit = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select('action')
        .where('target_id', '=', rr.id)
        .orderBy('occurred_at')
        .execute(),
    );
    expect(audit.map((a) => a.action)).toEqual([
      'resource_request.drafted',
      'resource_request.changed',
      'resource_request.submitted',
      'resource_request.approved',
      'resource_request.finance_replied',
      'resource_request.placed',
      'resource_request.en_route',
      'resource_request.received',
    ]);
  });

  it("FL:FR-21: a shelter's supply request is raised to a state request, keeping the link and the lines", async () => {
    const raised = await call<RR>('masscare', 'POST', '/resource-requests', {
      eventId,
      supplyRequestId,
      lines: [{ quantity: 1, unit: 'pallet', kind: 'Water', type: 'Bottled' }],
    });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    expect(raised.body).toMatchObject({
      supplyRequestId,
      deliveryLocation: `Exercise shelter ${run}`,
      requestNumber: `RREX${run.toUpperCase()}-RR-0003`,
    });
    expect(raised.body.lines.map((l) => [l.kind, l.quantity])).toEqual([
      ['Cots', 60],
      ['Blankets', 120],
      ['Water', 1],
    ]);
    // Another organization's or an unknown supply request is refused.
    expect(
      (
        await call('masscare', 'POST', '/resource-requests', {
          eventId,
          supplyRequestId: randomUUID(),
        })
      ).status,
    ).toBe(400);
  });
});

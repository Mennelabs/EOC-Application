/**
 * The state's read API and callbacks (CON-13, SCL-09; layer-8 plan §7),
 * against the database: a key with scope eoc.read reads an event's resource
 * requests (with lines and history), significant events, issued reports and
 * ICS forms, each use audited; a key without the scope, an expired or
 * pending key, or no key is refused without saying which; a key with scope
 * resource_request.update sets the state's tracking number and moves a
 * request along, which is a step by the key and a webhook event; the worker
 * turns the events into signed deliveries that carry no resident. Runs only
 * with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { WebhookPost } from '@cg/adapters';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore, apiKeyHash, newApiKey } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { sampleIcsForm, contentHash } from '@cg/reporting';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { resourceRequestEvent } from '../../worker/src/jobs/eoc-events.ts';
import { claimDeliveries, sendClaimed } from '../../worker/src/jobs/webhooks.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { eocApiRoutes } from '../src/routes/eoc-api.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface RR {
  id: string;
  requestNumber: string;
  status: string;
  stateTrackingNumber: string | null;
  lines: { kind: string; quantity: number }[];
  history: { step: string; actorKind: string; stateTrackingNumber: string | null }[];
  code?: string;
}

describe.skipIf(!appUrl || !workerUrl)('state read API and callbacks (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let requestId = '';
  let readKey = '';
  let updateKey = '';
  let pdaKey = '';
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-eoc-${run}`;

  const get = async <T>(path: string, key?: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/eoc/${slug}${path}`,
      headers: key ? { 'x-api-key': key } : {},
    });
    return {
      status: res.statusCode,
      body: res.json() as T,
      raw: res.rawPayload,
      headers: res.headers,
    };
  };
  const post = async <T>(path: string, key: string | undefined, payload: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/eoc/${slug}${path}`,
      headers: key ? { 'x-api-key': key } : {},
      payload: payload as Record<string, unknown>,
    });
    return { status: res.statusCode, body: res.json() as T };
  };
  const mintKey = async (
    scopes: string[],
    status: 'active' | 'pending' = 'active',
    expiresDays = 30,
  ) => {
    const k = newApiKey();
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.api_key')
        .values({
          tenant_id: county,
          name: `State ${scopes.join(',')} ${run}`,
          prefix: k.prefix,
          secret_hash: apiKeyHash(k.key),
          scopes: scopes as never,
          status,
          expires_at: new Date(Date.now() + expiresDays * 86_400_000),
          created_by: randomUUID(),
          ...(status === 'active'
            ? { decided_by: randomUUID(), decided_at: new Date(), decision_reason: 'Exercise' }
            : {}),
        })
        .execute(),
    );
    return k.key;
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
        name: `Exercise EOC API county ${run}`,
        status: 'active',
        locales: ['en'],
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      const director = (
        await trx
          .insertInto('cg.account')
          .values({
            tenant_id: county,
            email: `director-${run}@example.org`,
            display_name: 'Exercise EM Director',
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
            name: `Exercise EOC API event ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      requestId = (
        await trx
          .insertInto('cg.resource_request')
          .values({
            tenant_id: county,
            event_id: eventId,
            request_number: `EX${run.toUpperCase()}-RR-0001`,
            status: 'approved',
            priority: 'urgent',
            delivery_location: 'Exercise shelter, loading dock',
            requested_by_name: 'Exercise Mass Care',
            requested_by_position: 'Mass Care Coordinator',
            submitted_at: new Date(Date.now() - 7_200_000),
            submitted_by: null,
            approved_at: new Date(Date.now() - 3_600_000),
            approved_by: director,
            created_by: null,
            updated_by: director,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await trx
        .insertInto('cg.resource_request_line')
        .values({
          tenant_id: county,
          request_id: requestId,
          line_no: 1,
          quantity: 200,
          unit: 'each',
          kind: 'Cots',
          created_by: null,
          updated_by: null,
        })
        .execute();
      await trx
        .insertInto('cg.resource_request_step')
        .values({
          tenant_id: county,
          request_id: requestId,
          step: 'approved',
          from_status: 'submitted',
          to_status: 'approved',
          reason: 'Exercise',
          actor_account_id: director,
          created_by: director,
          updated_by: director,
        })
        .execute();
      await trx
        .insertInto('cg.significant_event')
        .values({
          tenant_id: county,
          event_id: eventId,
          kind: 'site',
          summary: 'Exercise shelter opened',
          mission_id: null,
          team_id: null,
          ref_kind: null,
          ref_id: null,
          actor_account_id: director,
        })
        .execute();
      const content = sampleIcsForm('ics_201');
      await trx
        .insertInto('cg.ics_form_issue')
        .values({
          tenant_id: county,
          event_id: eventId,
          form: 'ics_201',
          edition: content.edition,
          sequence: 1,
          title: 'ICS 201 Incident Briefing: exercise',
          scope: JSON.stringify({ eventId }),
          content: JSON.stringify(content),
          content_hash: contentHash(content),
          issued_by: director,
        })
        .execute();
      // A webhook that wants resource request changes, already approved.
      await trx
        .insertInto('cg.webhook')
        .values({
          tenant_id: county,
          name: `State WebEOC bridge ${run}`,
          url: 'https://webeoc.exercise-state.example/hooks/common-ground',
          events: ['resource_request.updated'] as never,
          secret_enc: Buffer.from(
            'whsec_' + Buffer.from('exercise-secret-'.repeat(2)).toString('base64'),
          ),
          status: 'active',
          created_by: director,
          decided_by: randomUUID(),
          decided_at: new Date(),
          decision_reason: 'Exercise',
        })
        .execute();
    });
    readKey = await mintKey(['eoc.read']);
    updateKey = await mintKey(['resource_request.update']);
    pdaKey = await mintKey(['pda.read']);
    const loader: SubjectLoader = {
      async fromBearer() {
        throw new AuthError('invalid_token');
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
      routes: [],
      eocRoutes: [
        eocApiRoutes({
          resolver: new TenantResolver(dbApp),
          db: dbApp,
          productName: 'Test Product',
        }),
      ],
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

  it('eoc.read: resource requests with lines and history, significant events, issued reports and ICS forms; every read audited', async () => {
    const list = await get<{ event: { id: string }; items: RR[] }>(
      `/resource-requests?event=${eventId}`,
      readKey,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.event.id).toBe(eventId);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      requestNumber: `EX${run.toUpperCase()}-RR-0001`,
      status: 'approved',
      lines: [{ kind: 'Cots', quantity: 200 }],
    });
    expect(list.body.items[0]!.history.map((h) => h.step)).toEqual(['approved']);
    const one = await get<RR>(`/resource-requests/${requestId}`, readKey);
    expect(one.status).toBe(200);
    const events = await get<{ items: { summary: string }[] }>(
      `/significant-events?event=${eventId}`,
      readKey,
    );
    expect(events.status).toBe(200);
    expect(events.body.items.map((e) => e.summary)).toEqual(['Exercise shelter opened']);
    expect(
      (
        await get(
          `/significant-events?event=${eventId}&from=2026-10-20T00:00:00Z&to=2026-10-19T00:00:00Z`,
          readKey,
        )
      ).status,
    ).toBe(400);
    const reports = await get<{ items: unknown[] }>(`/official-reports?event=${eventId}`, readKey);
    expect(reports.status).toBe(200);
    expect(reports.body.items).toEqual([]);
    const forms = await get<{ items: { form: string; pdf: string; contentHash: string }[] }>(
      `/ics-forms?event=${eventId}`,
      readKey,
    );
    expect(forms.status).toBe(200);
    expect(forms.body.items[0]).toMatchObject({ form: 'ics_201', number: 'ICS 201' });
    const pdf = await get(forms.body.items[0]!.pdf.replace(`/api/eoc/${slug}`, ''), readKey);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.raw.subarray(0, 5).toString()).toBe('%PDF-');
    // Nothing read names a resident.
    expect(JSON.stringify(list.body)).not.toMatch(/@example\.org|\(\d{3}\) \d{3}-\d{4}/);
    const audits = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select('changes')
        .where('tenant_id', '=', county)
        .where('action', '=', 'api_key.use')
        .execute(),
    );
    expect(audits.length).toBeGreaterThanOrEqual(5);
  });

  it('no key, the wrong scope, a pending key or an expired key is refused the same way; an unknown event is not found', async () => {
    expect((await get(`/resource-requests?event=${eventId}`)).status).toBe(401);
    expect((await get(`/resource-requests?event=${eventId}`, pdaKey)).status).toBe(401);
    expect((await get(`/resource-requests?event=${eventId}`, updateKey)).status).toBe(401);
    expect(
      (await get(`/resource-requests?event=${eventId}`, await mintKey(['eoc.read'], 'pending')))
        .status,
    ).toBe(401);
    expect(
      (await get(`/resource-requests?event=${eventId}`, await mintKey(['eoc.read'], 'active', -1)))
        .status,
    ).toBe(401);
    expect((await get(`/resource-requests?event=${randomUUID()}`, readKey)).status).toBe(404);
    expect((await get(`/resource-requests?event=not-an-id`, readKey)).status).toBe(404);
    expect(
      (await post(`/resource-requests/${requestId}/state`, readKey, { status: 'placed' })).status,
    ).toBe(401);
  });

  it('resource_request.update: the state sets its number and moves the request on; a step by the key, an audit, a webhook delivery without a resident', async () => {
    const bad = await post<RR>(`/resource-requests/${requestId}/state`, updateKey, {});
    expect(bad.status).toBe(400);
    const placed = await post<RR>(`/resource-requests/${requestId}/state`, updateKey, {
      stateTrackingNumber: 'SEMA-EX-9001',
      status: 'placed',
      eta: new Date(Date.now() + 36e5).toISOString(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(placed.body).toMatchObject({ status: 'placed', stateTrackingNumber: 'SEMA-EX-9001' });
    expect(placed.body.history.at(-1)).toMatchObject({
      step: 'state_update',
      actorKind: 'api_key',
      stateTrackingNumber: 'SEMA-EX-9001',
    });
    // Received cannot come before en route from placed? It can: placed or en route may be received. Backwards is refused.
    expect(
      (await post<RR>(`/resource-requests/${requestId}/state`, updateKey, { status: 'placed' }))
        .status,
    ).toBe(200);
    const moving = await post<RR>(`/resource-requests/${requestId}/state`, updateKey, {
      status: 'en_route',
      note: 'Left the warehouse (exercise)',
    });
    expect(moving.status).toBe(200);
    expect(moving.body.status).toBe('en_route');
    expect(
      (await post<RR>(`/resource-requests/${requestId}/state`, updateKey, { status: 'placed' }))
        .status,
    ).toBe(409);
    // The county's queue holds the update event; the worker turns it into a signed delivery.
    const outbox = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.outbox')
        .select(['topic', 'payload'])
        .where('tenant_id', '=', county)
        .where('topic', '=', 'resource_request.updated')
        .execute(),
    );
    expect(outbox.length).toBeGreaterThanOrEqual(2);
    const posts: WebhookPost[] = [];
    const ctx = {
      db: dbWorker,
      log: app.log,
      crypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
      webhookSender: {
        async send(p: WebhookPost) {
          posts.push(p);
          return { ok: true, status: 200 };
        },
      },
    } as unknown as JobContext;
    await resourceRequestEvent(ctx, {
      id: 1,
      tenantId: county,
      topic: 'resource_request.updated',
      payload: { requestId, status: 'en_route', by: 'state' },
      executionId: null,
    });
    const deliveries = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.webhook_delivery')
        .select(['event', 'payload', 'status'])
        .where('tenant_id', '=', county)
        .execute(),
    );
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    const payload = deliveries[0]!.payload as { type: string; data: Record<string, unknown> };
    expect(payload.type).toBe('resource_request.updated');
    expect(payload.data).toMatchObject({
      requestNumber: `EX${run.toUpperCase()}-RR-0001`,
      status: 'en_route',
      stateTrackingNumber: 'SEMA-EX-9001',
      by: 'state',
    });
    expect(JSON.stringify(payload)).not.toMatch(/@example\.org|display_name|requested_by/);
    // What was not sent yet goes out through the claim and send path with a signature.
    const claimed = await dbWorker
      .transaction()
      .execute((trx) => claimDeliveries(trx, { limit: 10 }));
    if (claimed.length) await sendClaimed(ctx, claimed);
    expect(
      posts.length + deliveries.filter((d) => d.status === 'delivered').length,
    ).toBeGreaterThanOrEqual(1);
  });
});

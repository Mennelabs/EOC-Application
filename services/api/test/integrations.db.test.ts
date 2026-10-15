/**
 * Outbound integrations against the database (layer-6 task H; SCL-09,
 * ADM-05, GATE-04, SEC-18): an API key is shown once and stored only as a
 * hash; it works only after a second administrator approves it (never the
 * one who asked); the feature service answers the GeoServices query subset
 * with the PDA layer, generalized and without personal details, and the
 * same refusal for an unknown, pending, revoked, expired or wrongly scoped
 * key; every answer is audited against the key. A webhook takes HTTPS host
 * names only; its secret is shown once and kept encrypted; it sends nothing
 * until a second administrator approves it; an issued report reaches it
 * once, signed so the receiver can check it; failures are retried and then
 * marked failed; a disabled webhook gets nothing more. Runs only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import type { WebhookPost } from '@cg/adapters';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore, apiKeyHash } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadDamageReports, type DamageSpec } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import {
  claimDeliveries,
  publishWebhookEvent,
  sendClaimed,
} from '../../worker/src/jobs/webhooks.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { gisRoutes } from '../src/routes/gis.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const CONFIRM = { 'x-confirm': 'true', 'x-reason': 'Exercise integration setup' };

interface Key {
  id: string;
  version: number;
  prefix: string;
  status: string;
  key?: string;
  askedByYou: boolean;
  decidedBy: string | null;
  lastUsedAt: string | null;
}
interface Hook {
  id: string;
  version: number;
  status: string;
  secret?: string;
  deliveries: { pending: number; delivered: number; failed: number };
}

describe.skipIf(!appUrl || !workerUrl)('integrations (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let specs: DamageSpec[] = [];
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-int-${run}`;
  const people: Record<string, string> = {};
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(dbWorker, { tenantId: county }, fn);
  const worker = (): JobContext =>
    ({
      db: dbWorker,
      crypto,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    }) as unknown as JobContext;

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
        name: `Exercise integrations county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    eventId = await tx(async (trx) => {
      for (const [who, name] of [
        ['admin', 'Exercise Tenant Admin'],
        ['security', 'Exercise Security Admin'],
        ['director', 'Exercise EM Director'],
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
            name: `Exercise integrations flood ${run}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(Date.now() - 48 * 3_600_000),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    specs = (
      await loadDamageReports(dbWorker, {
        tenantId: county,
        eventId,
        reviewerId: people['director']!,
        count: 24,
        tag: `int${run}`,
      })
    ).specs;

    const subject = (template: string, accountId: string): AccountSubject => {
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
      admin: subject('tenant_admin', people['admin']!),
      security: subject('security_admin', people['security']!),
      director: subject('county_em_director', people['director']!),
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
      fieldCrypto: crypto,
      subjects: loader,
      routes: routesWith({}),
      gisRoutes: [gisRoutes({ resolver: new TenantResolver(dbApp, 0), db: dbApp, cacheMs: 0 })],
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

  const call = async <T>(
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
  const gis = async (path: string, key?: string, header = true) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/gis/${slug}/pda/FeatureServer${path}${key && !header ? `${path.includes('?') ? '&' : '?'}token=${key}` : ''}`,
      headers: key && header ? { 'x-api-key': key } : {},
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown>, text: res.body };
  };
  const ask = (who = 'admin', body: Record<string, unknown> = {}) =>
    call<Key>(
      who,
      'POST',
      '/api-keys',
      { name: `GIS desk ${run}`, scopes: ['pda.read'], expiresInDays: 90, ...body },
      CONFIRM,
    );
  const decide = (who: string, k: { id: string; version: number }, op: string) =>
    call<Key>(who, 'POST', `/api-keys/${k.id}/${op}`, undefined, {
      ...CONFIRM,
      'if-match': `"${k.version}"`,
    });

  it('SCL-09: a key is shown once, stored as a hash, and needs a second administrator', async () => {
    const asked = await ask();
    expect(asked.status, asked.text).toBe(201);
    expect(asked.body.key).toMatch(/^cgk_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(asked.body.status).toBe('pending');
    const stored = await tx((trx) =>
      trx
        .selectFrom('cg.api_key')
        .selectAll()
        .where('id', '=', asked.body.id)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.secret_hash).toBe(apiKeyHash(asked.body.key!));
    expect(JSON.stringify(stored)).not.toContain(asked.body.key!.slice(18));
    // Never again: the list has no key and no hash.
    const list = await call<{ keys: Key[] }>('security', 'GET', '/api-keys');
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(asked.body.key!);
    expect(list.text).not.toContain(stored.secret_hash);
    // Asking needs the confirmation; a role without the action is refused.
    expect(
      (
        await call('admin', 'POST', '/api-keys', {
          name: 'x',
          scopes: ['pda.read'],
          expiresInDays: 1,
        })
      ).status,
    ).toBe(428);
    expect((await ask('director')).status).toBe(403);
    expect((await ask('admin', { expiresInDays: 400 })).status).toBe(400);
    // G6: the one who asked cannot approve; a pending key opens nothing.
    expect((await decide('admin', asked.body, 'approve')).status).toBe(403);
    expect((await gis('/0/query?where=1%3D1&f=json', asked.body.key)).status).toBe(401);
    const approved = await decide('security', asked.body, 'approve');
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.status).toBe('active');
    expect(approved.body.decidedBy).toBe('Exercise Security Admin');
    // Audited without the key.
    const audit = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'changes', 'reason'])
        .where('target_id', '=', asked.body.id)
        .orderBy('seq')
        .execute(),
    );
    // The refused self-approval is audited too (SEC-18).
    expect(audit.map((a) => a.action)).toEqual(['api_key.manage', 'authz.deny', 'api_key.manage']);
    expect(JSON.stringify(audit)).not.toContain(asked.body.key!);
  });

  it('SCL-09: the feature service answers the query subset with the PDA layer, nothing personal', async () => {
    const asked = await ask();
    await decide('security', asked.body, 'approve');
    const key = asked.body.key!;
    const service = await gis('?f=json', key);
    expect(service.status, service.text).toBe(200);
    expect(service.body['layers']).toEqual([
      { id: 0, name: 'PDA', geometryType: 'esriGeometryPoint' },
    ]);
    const layer = await gis('/0?f=json', key);
    const fields = (layer.body['fields'] as { name: string }[]).map((f) => f.name);
    expect(fields).toEqual(
      expect.arrayContaining(['OBJECTID', 'RecordID', 'Status', 'USNG', 'DmgLevel']),
    );

    const all = await gis('/0/query?where=1%3D1&outFields=*&f=json', key);
    expect(all.status, all.text).toBe(200);
    const features = all.body['features'] as {
      attributes: Record<string, unknown>;
      geometry?: { x: number; y: number };
    }[];
    expect(features.length).toBeGreaterThan(5);
    expect(all.body['exceededTransferLimit']).toBe(false);
    // DEC-13: no address, and every place is the 100 m cell (three decimals).
    for (const s of specs) expect(all.text).not.toContain(s.line1);
    for (const f of features.filter((x) => x.geometry))
      for (const v of [f.geometry!.x, f.geometry!.y])
        expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-6);

    // The where subset, counts, ids, paging, GeoJSON and the token parameter.
    const degree = String(features.find((f) => f.attributes['DmgLevel'])!.attributes['DmgLevel']);
    const some = await gis(
      `/0/query?where=${encodeURIComponent(`DmgLevel = '${degree}'`)}&returnCountOnly=true&f=json`,
      key,
    );
    expect(some.body['count']).toBe(
      features.filter((f) => f.attributes['DmgLevel'] === degree).length,
    );
    const ids = await gis('/0/query?where=1%3D1&returnIdsOnly=true&f=json', key);
    expect((ids.body['objectIds'] as number[]).length).toBe(features.length);
    const page = await gis('/0/query?where=1%3D1&resultOffset=0&resultRecordCount=2&f=json', key);
    expect((page.body['features'] as unknown[]).length).toBe(2);
    expect(page.body['exceededTransferLimit']).toBe(true);
    const geo = await gis('/0/query?where=1%3D1&outFields=RecordID&f=geojson', key, false);
    expect(geo.status, geo.text).toBe(200);
    expect(geo.body['type']).toBe('FeatureCollection');
    const first = (geo.body['features'] as { properties: Record<string, unknown> }[])[0]!;
    expect(Object.keys(first.properties).sort()).toEqual(['OBJECTID', 'RecordID']);
    // Refused, not ignored: SQL in where, spatial filters, other projections.
    for (const bad of [
      `where=${encodeURIComponent('1=1; drop table cg.report')}`,
      `where=${encodeURIComponent("Status = 'x' OR 1=1")}`,
      'where=1%3D1&geometry=1,2,3,4',
      'where=1%3D1&outSR=3857',
      'where=1%3D1&f=kmz',
    ])
      expect((await gis(`/0/query?${bad}`, key)).status).toBe(400);
    // Each answer is audited against the key; its last use is recorded.
    const used = await tx((trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'actor_kind'])
        .where('target_id', '=', asked.body.id)
        .where('action', '=', 'api_key.use')
        .execute(),
    );
    expect(used.length).toBeGreaterThanOrEqual(5);
    expect(used.every((u) => u.actor_kind === 'public')).toBe(true);
    const list = await call<{ keys: Key[] }>('admin', 'GET', '/api-keys');
    expect(list.body.keys.find((k) => k.id === asked.body.id)!.lastUsedAt).not.toBeNull();
  });

  it('GATE-04: unknown, malformed, revoked and expired keys all get the same refusal', async () => {
    const asked = await ask();
    const live = await decide('security', asked.body, 'approve');
    const key = asked.body.key!;
    expect((await gis('/0/query?where=1%3D1', key)).status).toBe(200);
    const forged = `${key.slice(0, -4)}AAAA`;
    const answers = [
      await gis('/0/query?where=1%3D1'),
      await gis('/0/query?where=1%3D1', 'not-a-key'),
      await gis('/0/query?where=1%3D1', forged),
    ];
    // Another tenant's slug with this key: not this tenant's key.
    const elsewhere = await app.inject({
      method: 'GET',
      url: `/api/gis/exercise-nowhere-${run}/pda/FeatureServer/0/query?where=1%3D1`,
      headers: { 'x-api-key': key },
    });
    expect(elsewhere.statusCode).toBe(404);
    // Revoked by the one who asked (allowed: revoking takes access away).
    const revoked = await decide('admin', live.body, 'revoke');
    expect(revoked.status, revoked.text).toBe(200);
    answers.push(await gis('/0/query?where=1%3D1', key));
    // Expired.
    const other = await ask();
    await decide('security', other.body, 'approve');
    await tx((trx) =>
      trx
        .updateTable('cg.api_key')
        .set({ expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 2000) })
        .where('id', '=', other.body.id)
        .execute(),
    );
    answers.push(await gis('/0/query?where=1%3D1', other.body.key));
    expect(answers.map((a) => a.status)).toEqual([401, 401, 401, 401, 401]);
    const messages = new Set(answers.slice(1).map((a) => JSON.stringify(a.body)));
    expect(messages.size).toBe(1);
    const listed = await call<{ keys: Key[] }>('admin', 'GET', '/api-keys');
    expect(listed.body.keys.find((k) => k.id === other.body.id)!.status).toBe('expired');
    // An expired key is not approved after the fact.
    const late = await ask();
    await tx((trx) =>
      trx
        .updateTable('cg.api_key')
        .set({ expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 2000) })
        .where('id', '=', late.body.id)
        .execute(),
    );
    const v = await tx((trx) =>
      trx
        .selectFrom('cg.api_key')
        .select('version')
        .where('id', '=', late.body.id)
        .executeTakeFirstOrThrow(),
    );
    expect(
      (await decide('security', { id: late.body.id, version: v.version }, 'approve')).status,
    ).toBe(409);
  });

  it('SCL-09: a webhook takes an HTTPS host name; its secret is shown once and kept encrypted', async () => {
    for (const url of [
      'http://hooks.example.org/in',
      'https://10.0.0.5/in',
      'https://localhost/in',
      'https://user:pw@hooks.example.org/in',
      'https://hooks.example.org:8080/in',
    ]) {
      const r = await call(
        'admin',
        'POST',
        '/webhooks',
        { name: 'x', url, events: ['export.ready'] },
        CONFIRM,
      );
      expect(r.status, url).toBe(400);
    }
    const made = await call<Hook>(
      'admin',
      'POST',
      '/webhooks',
      {
        name: `State EOC ${run}`,
        url: 'https://hooks.state-eoc.test/in',
        events: ['official_report.issued'],
      },
      CONFIRM,
    );
    expect(made.status, made.text).toBe(201);
    expect(made.body.secret).toMatch(/^whsec_/);
    const stored = await tx((trx) =>
      trx
        .selectFrom('cg.webhook')
        .selectAll()
        .where('id', '=', made.body.id)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.secret_enc.toString('latin1')).not.toContain(made.body.secret!);
    expect(await crypto.decrypt(county, stored.secret_enc)).toBe(made.body.secret);
    const list = await call<{ webhooks: Hook[] }>('security', 'GET', '/webhooks');
    expect(list.text).not.toContain(made.body.secret!);
    expect(
      (
        await call('admin', 'POST', `/webhooks/${made.body.id}/approve`, undefined, {
          ...CONFIRM,
          'if-match': `"${made.body.version}"`,
        })
      ).status,
    ).toBe(403);
    // Not approved: an event reaches nothing.
    const none = await tx((trx) =>
      publishWebhookEvent(worker(), county, 'official_report.issued', randomUUID(), {}, trx),
    );
    expect(none).toEqual([]);
  });

  it('SCL-09: an approved webhook gets each event once, signed; failures retry, then fail', async () => {
    const made = await call<Hook>(
      'admin',
      'POST',
      '/webhooks',
      {
        name: `Partner GIS ${run}`,
        url: 'https://hooks.partner-gis.test/in',
        events: ['official_report.issued', 'export.ready'],
      },
      CONFIRM,
    );
    const approved = await call<Hook>(
      'security',
      'POST',
      `/webhooks/${made.body.id}/approve`,
      undefined,
      {
        ...CONFIRM,
        'if-match': `"${made.body.version}"`,
      },
    );
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.status).toBe('active');

    const posts: WebhookPost[] = [];
    const ok = async (p: WebhookPost) => {
      posts.push(p);
      return { status: 204, error: null };
    };
    const subjectId = randomUUID();
    const data = { reportId: subjectId, title: 'Situation report 1', kind: 'sitrep' };
    // Queued and claimed in one transaction: nothing else can send it meanwhile.
    const claimed = await tx((trx) =>
      publishWebhookEvent(worker(), county, 'official_report.issued', subjectId, data, trx),
    );
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const mine = claimed.filter((d) => d.webhook_id === made.body.id);
    expect(mine.length).toBe(1);
    await sendClaimed(worker(), mine, ok);
    expect(posts.length).toBe(1);
    const p = posts[0]!;
    expect(p.url).toBe('https://hooks.partner-gis.test/in');
    // Standard Webhooks: the receiver recomputes the signature with the secret it was shown.
    const key = Buffer.from(made.body.secret!.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key)
      .update(`${p.headers['webhook-id']}.${p.headers['webhook-timestamp']}.${p.body}`)
      .digest('base64');
    expect(p.headers['webhook-signature']).toBe(`v1,${expected}`);
    expect(JSON.parse(p.body)).toMatchObject({ type: 'official_report.issued', data });
    // The same event again (a retried job) is not queued twice.
    const again = await tx((trx) =>
      publishWebhookEvent(worker(), county, 'official_report.issued', subjectId, data, trx),
    );
    expect(again.filter((d) => d.webhook_id === made.body.id)).toEqual([]);

    // A failing receiver: retried with backoff, then failed after the last attempt.
    const failing = await tx((trx) =>
      publishWebhookEvent(worker(), county, 'export.ready', randomUUID(), { exportId: 'x' }, trx),
    );
    const f = failing.find((d) => d.webhook_id === made.body.id)!;
    await sendClaimed(worker(), [f], async () => ({
      status: 500,
      error: 'The receiver answered 500.',
    }));
    let row = await tx((trx) =>
      trx
        .selectFrom('cg.webhook_delivery')
        .selectAll()
        .where('id', '=', f.id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_status).toBe(500);
    expect(row.next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    // Fast-forward to the last attempt.
    await tx((trx) =>
      trx.updateTable('cg.webhook_delivery').set({ attempts: 7 }).where('id', '=', f.id).execute(),
    );
    const last = await tx((trx) =>
      claimDeliveries(trx, { ids: [f.id], now: new Date(Date.now() + 3_600_000) }),
    );
    expect(last.length).toBe(1);
    await sendClaimed(worker(), last, async () => ({ status: null, error: 'Could not connect.' }));
    row = await tx((trx) =>
      trx
        .selectFrom('cg.webhook_delivery')
        .selectAll()
        .where('id', '=', f.id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(8);
    expect(row.next_attempt_at).toBeNull();

    // Disabled: what is still pending fails without being sent, and nothing new is queued.
    const pending = await tx((trx) =>
      publishWebhookEvent(worker(), county, 'export.ready', randomUUID(), { exportId: 'y' }, trx),
    );
    const current = await call<{ webhooks: Hook[] }>('admin', 'GET', '/webhooks');
    const hook = current.body.webhooks.find((h) => h.id === made.body.id)!;
    expect(hook.deliveries).toMatchObject({ delivered: 1, failed: 1 });
    const disabled = await call<Hook>(
      'admin',
      'POST',
      `/webhooks/${made.body.id}/disable`,
      undefined,
      {
        ...CONFIRM,
        'if-match': `"${hook.version}"`,
      },
    );
    expect(disabled.status, disabled.text).toBe(200);
    const sent: WebhookPost[] = [];
    await sendClaimed(
      worker(),
      pending.filter((d) => d.webhook_id === made.body.id),
      async (x) => {
        sent.push(x);
        return { status: 204, error: null };
      },
    );
    expect(sent).toEqual([]);
    const after = await tx((trx) =>
      publishWebhookEvent(worker(), county, 'export.ready', randomUUID(), {}, trx),
    );
    expect(after.filter((d) => d.webhook_id === made.body.id)).toEqual([]);
    const deliveries = await call<{ deliveries: { status: string; lastError: string | null }[] }>(
      'security',
      'GET',
      `/webhooks/${made.body.id}/deliveries`,
    );
    expect(deliveries.body.deliveries.map((d) => d.status).sort()).toEqual([
      'delivered',
      'failed',
      'failed',
    ]);
  });
});

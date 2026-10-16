/**
 * FL-16: a private way to ask for peer support. A worker asks from the field
 * (how to be reached and when, no words); only the peer-support role sees who
 * asked and how to reach them. The worker's lead, a coordinator, dispatch and
 * an administrator cannot, and a county role given the action but not the
 * counseling template still sees nothing (ADM-05 guardrail 7). Asking again
 * while a request is open answers with that one; a replay by the phone's id
 * is one request. Every read by the peer-support role is audited as
 * counseling data. Runs on a county of its own, only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { roleTemplates, type AccountSubject, type Grant } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Mine {
  id: string;
  version: number;
  reachBy: string;
  reachWhen: string;
  status: string;
}
interface Seen extends Mine {
  name: string;
  agency: string | null;
  phone: string | null;
}

describe.skipIf(!appUrl || !workerUrl)('asking privately for peer support', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const people: Record<string, string> = {};

  const call = async (
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
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
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
        slug: `exercise-peer-${run}`,
        name: `Exercise peer support county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const as = (template: string, accountId = randomUUID(), extra: Grant[] = []) => {
      const t = roleTemplates.find((x) => x.key === template)!;
      const s: AccountSubject = {
        kind: 'account',
        accountId,
        tenantId: county,
        tenantPath: c.path,
        tenantKind: c.kind,
        status: 'active',
        roles: [
          {
            roleId: randomUUID(),
            key: extra.length ? `${t.key}_plus` : t.key,
            version: 1,
            templateKey: extra.length ? null : t.key,
            grants: [...t.grants, ...extra],
            scope: {},
          },
        ],
        resolvedAt: new Date(),
      };
      return s;
    };
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      await sql`select cg.seed_retention_defaults(${county}::uuid, null)`.execute(trx);
      for (const [key, name, phone] of [
        ['worker', 'Exercise volunteer Dana', '+13145550101'],
        ['other', 'Exercise volunteer Lee', '+13145550102'],
      ] as const) {
        const accountId = randomUUID();
        await trx
          .insertInto('cg.account')
          .values({
            id: accountId,
            tenant_id: county,
            email: `${key}-${run}@example.org`,
            display_name: name,
            status: 'active',
          } as never)
          .execute();
        people[key] = (
          await trx
            .insertInto('cg.personnel')
            .values({
              tenant_id: county,
              account_id: accountId,
              name,
              agency: 'Exercise CERT',
              contact_enc: await crypto.encrypt(county, JSON.stringify({ phone })),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        subjects[key] = as('field_volunteer', accountId);
      }
    });
    subjects['counselor'] = as('crisis_counselor');
    subjects['lead'] = as('team_lead');
    subjects['coordinator'] = as('field_coordinator');
    subjects['admin'] = as('tenant_admin');
    // A county role editor gives the read action to a non-counselor role: the counseling
    // category still comes only with the template key (ADM-05 G7).
    subjects['granted'] = as('field_coordinator', randomUUID(), [
      { action: 'peer_support.read' },
      { action: 'peer_support.update' },
    ]);
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

  it('FL-16: a worker asks with how and when only; asking again or replaying answers with the same request; they see and can withdraw only their own', async () => {
    const clientUuid = randomUUID();
    const ask = { clientUuid, reachBy: 'call', reachWhen: 'after_shift' };
    const first = await call('worker', 'POST', '/peer-support', ask);
    expect(first.status, first.body).toBe(201);
    const mine = first.json<Mine>();
    expect(mine).toMatchObject({ reachBy: 'call', reachWhen: 'after_shift', status: 'open' });
    // Words are not accepted; the request has no place for them.
    const withWords = await call('worker', 'POST', '/peer-support', {
      ...ask,
      clientUuid: randomUUID(),
      reachBy: 'call',
      note: 'rough day',
    });
    expect([200, 400]).toContain(withWords.status);
    expect(withWords.body).not.toContain('rough day');
    // The phone replaying, or asking again while one is open: the same request.
    const replay = await call('worker', 'POST', '/peer-support', ask);
    expect(replay.status).toBe(200);
    expect(replay.json<Mine>().id).toBe(mine.id);
    const again = await call('worker', 'POST', '/peer-support', {
      clientUuid: randomUUID(),
      reachBy: 'text',
      reachWhen: 'now',
    });
    expect(again.json<Mine>().id).toBe(mine.id);
    const stored = await dbWorker
      .selectFrom('cg.peer_support_request')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('personnel_id', '=', people['worker']!)
      .executeTakeFirstOrThrow();
    expect(stored.n).toBe('1');

    // Their own list, and nobody else's: another worker sees none and cannot withdraw it.
    const own = await call('worker', 'GET', '/peer-support/mine');
    expect(own.json<Mine[]>().map((r) => r.id)).toEqual([mine.id]);
    expect((await call('other', 'GET', '/peer-support/mine')).json<Mine[]>()).toEqual([]);
    const notTheirs = await call(
      'other',
      'POST',
      `/peer-support/${mine.id}/withdraw`,
      {},
      { 'if-match': `"${mine.version}"` },
    );
    expect(notTheirs.status).toBe(404);
  });

  it('FL-16, ADM-05: only the peer-support role sees who asked and how to reach them; the lead, a coordinator, an administrator and a role given the action without the template see nothing', async () => {
    for (const who of ['lead', 'coordinator', 'admin', 'granted', 'worker']) {
      const res = await call(who, 'GET', '/peer-support');
      expect(res.status, who).toBe(403);
      expect(res.body, who).not.toContain('Dana');
    }
    const seen = await call('counselor', 'GET', '/peer-support');
    expect(seen.status, seen.body).toBe(200);
    const rows = seen.json<Seen[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Exercise volunteer Dana',
      agency: 'Exercise CERT',
      phone: '+13145550101',
      reachBy: 'call',
      reachWhen: 'after_shift',
      status: 'open',
    });
    // The read is audited as counseling data.
    const reads = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['classification_read', 'actor_account_id'])
      .where('tenant_id', '=', county)
      .where('action', '=', 'peer_support.read')
      .execute();
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads[0]!.classification_read).toContain('counseling');
    expect(reads[0]!.actor_account_id).toBe(subjects['counselor']!.accountId);
    // The request's audit holds no how or when.
    const asked = await dbWorker
      .selectFrom('cg.audit_event')
      .select('changes')
      .where('tenant_id', '=', county)
      .where('action', '=', 'peer_support.request')
      .execute();
    expect(JSON.stringify(asked)).not.toMatch(/after_shift|"call"/);
  });

  it('FL-16: the peer-support role marks a request contacted then closed; the role given the action without the template cannot; a closed request leaves the worker’s list', async () => {
    const [open] = (await call('counselor', 'GET', '/peer-support')).json<Seen[]>();
    const denied = await call(
      'granted',
      'POST',
      `/peer-support/${open!.id}/contacted`,
      {},
      { 'if-match': `"${open!.version}"` },
    );
    expect(denied.status).toBe(403);
    const contacted = await call(
      'counselor',
      'POST',
      `/peer-support/${open!.id}/contacted`,
      {},
      { 'if-match': `"${open!.version}"` },
    );
    expect(contacted.status, contacted.body).toBe(200);
    const c = contacted.json<Mine>();
    expect(c.status).toBe('contacted');
    const stale = await call(
      'counselor',
      'POST',
      `/peer-support/${open!.id}/close`,
      {},
      { 'if-match': `"${open!.version}"` },
    );
    expect(stale.status).toBe(409);
    const closed = await call(
      'counselor',
      'POST',
      `/peer-support/${open!.id}/close`,
      {},
      { 'if-match': `"${c.version}"` },
    );
    expect(closed.status).toBe(200);
    expect((await call('worker', 'GET', '/peer-support/mine')).json<Mine[]>()).toEqual([]);
    expect((await call('counselor', 'GET', '/peer-support')).json<Seen[]>()).toEqual([]);
    const all = await call('counselor', 'GET', '/peer-support?include=all');
    expect(all.json<Seen[]>().map((r) => r.status)).toEqual(['closed']);

    // A new request after the closed one; the worker withdraws it; the person asking in
    // person gives no phone to the peer-support role.
    const next = await call('worker', 'POST', '/peer-support', {
      clientUuid: randomUUID(),
      reachBy: 'in_person',
      reachWhen: 'now',
    });
    expect(next.status).toBe(201);
    const listed = (await call('counselor', 'GET', '/peer-support')).json<Seen[]>();
    expect(listed[0]!.phone).toBeNull();
    const n = next.json<Mine>();
    const withdrawn = await call(
      'worker',
      'POST',
      `/peer-support/${n.id}/withdraw`,
      {},
      { 'if-match': `"${n.version}"` },
    );
    expect(withdrawn.status, withdrawn.body).toBe(200);
    expect(withdrawn.json<Mine>().status).toBe('closed');
    const row = await dbWorker
      .selectFrom('cg.peer_support_request')
      .select(['closed_by_requester'])
      .where('id', '=', n.id)
      .executeTakeFirstOrThrow();
    expect(row.closed_by_requester).toBe(true);
  });

  it('FL-16, SEC-13: a new county keeps closed peer-support requests 30 days by default', async () => {
    const policy = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      sql<{ days: string }>`select (extract(epoch from keep_for) / 86400)::text as days
        from cg.retention_policy where data_category = 'peer_support'`.execute(trx),
    );
    expect(Number(policy.rows[0]?.days)).toBe(30);
  });
});

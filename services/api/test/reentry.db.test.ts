/**
 * FL:FR-03: resident re-entry passes. The EOC issues a pass for a household
 * into a closed zone (a reason is required; the name and address are
 * encrypted; the code is shown once and kept as a hash). At the perimeter the
 * badge check recognises the pass: a valid pass shows the zone and the people,
 * and the holder and home only to a role that checks passes; a revoked or
 * expired pass shows neither. Every scan is logged with its checkpoint, and
 * the log names no one; reading the holders is audited. A closed event issues
 * nothing. Runs on a county of its own, only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
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

interface Check {
  result: string;
  kind?: string;
  zone?: string;
  people?: number;
  holderName?: string;
  address?: string;
}

describe.skipIf(!appUrl || !workerUrl)('resident re-entry passes (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let closedEventId = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};

  const call = async (
    who: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...extra },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.body, json: <T>() => res.json() as T };
  };
  const reason = {
    'x-confirm': 'true',
    'x-reason': 'Exercise: household returns to check the house',
  };
  const scan = (who: string, code: string, checkpoint = 'Route 94 north') =>
    call(who, 'POST', '/badges/verify', { code, checkpoint });

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-reentry-${run}`,
        name: `Exercise re-entry county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      for (const [status, set] of [
        ['active', (id: string) => (eventId = id)],
        ['closed', (id: string) => (closedEventId = id)],
      ] as const)
        set(
          (
            await trx
              .insertInto('cg.event')
              .values({
                tenant_id: county,
                name: `Exercise re-entry ${status} ${run}`,
                hazard_type: 'wildfire',
                status,
                opened_at: new Date(),
                ...(status === 'closed' ? { closed_at: new Date() } : {}),
              } as never)
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id,
        );
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
    subjects['director'] = as('county_em_director');
    subjects['checkpoint'] = as('checkpoint_officer');
    subjects['coordinator'] = as('field_coordinator');
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

  const pass = {
    zone: 'Canyon Road evacuation zone',
    holderName: 'Ana Exercise',
    address: '12 Exercise Canyon Rd, Westwind',
    people: 3,
  };
  let code = '';
  let passId = '';

  it('FL:FR-03: a pass is issued with a reason for an open event; its holder and home are encrypted and its code kept as a hash', async () => {
    const body = { eventId, ...pass };
    expect((await call('volunteer', 'POST', '/reentry-passes', body, reason)).status).toBe(403);
    expect((await call('director', 'POST', '/reentry-passes', body)).status).toBe(428);
    expect(
      (
        await call(
          'director',
          'POST',
          '/reentry-passes',
          { ...body, eventId: closedEventId },
          reason,
        )
      ).status,
    ).toBe(409);
    const issued = await call('director', 'POST', '/reentry-passes', body, reason);
    expect(issued.status, issued.body).toBe(201);
    const out = issued.json<{ id: string; code: string; validTo: string }>();
    code = out.code;
    passId = out.id;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Date(out.validTo).getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000);
    const stored = await dbWorker
      .selectFrom('cg.reentry_pass')
      .select(['holder_name_enc', 'address_enc', 'code_hash'])
      .where('id', '=', passId)
      .executeTakeFirstOrThrow();
    for (const v of [stored.holder_name_enc, stored.address_enc, stored.code_hash])
      expect(Buffer.from(v).toString('utf8')).not.toMatch(/Exercise|Canyon|[A-Z2-9]{4}-/);
  });

  it('FL:FR-03: at the perimeter a valid pass shows its zone and people, and its holder and home only to a role that checks passes; every scan is logged without names', async () => {
    const officer = await scan('checkpoint', code);
    expect(officer.status, officer.body).toBe(200);
    expect(officer.json<Check>()).toMatchObject({
      result: 'valid',
      kind: 'reentry',
      zone: pass.zone,
      people: 3,
      holderName: pass.holderName,
      address: pass.address,
    });
    const coordinator = (await scan('coordinator', code.toLowerCase(), 'Gate B')).json<Check>();
    expect(coordinator).toMatchObject({ result: 'valid', kind: 'reentry', zone: pass.zone });
    expect(coordinator.holderName).toBeUndefined();
    expect(coordinator.address).toBeUndefined();
    expect((await scan('volunteer', code)).status).toBe(403);

    const log = await call('director', 'GET', `/reentry-passes/checks?eventId=${eventId}`);
    expect(log.status, log.body).toBe(200);
    expect(log.json<{ checkpoint: string; result: string }[]>().map((c) => c.checkpoint)).toEqual([
      'Gate B',
      'Route 94 north',
    ]);
    expect(log.body).not.toContain(pass.holderName);
    const list = await call('director', 'GET', `/reentry-passes?eventId=${eventId}`);
    expect(list.json()).toMatchObject([
      {
        id: passId,
        holderName: pass.holderName,
        address: pass.address,
        state: 'active',
        checks: 2,
        lastCheck: { checkpoint: 'Gate B', result: 'valid' },
      },
    ]);
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', county)
      .where('action', 'in', ['reentry_pass.read', 'reentry_pass.issue', 'badge.verify'])
      .execute();
    expect(new Set(audited.map((a) => a.action))).toEqual(
      new Set(['reentry_pass.read', 'reentry_pass.issue', 'badge.verify']),
    );
  });

  it('FL:FR-03: a revoked or expired pass is refused at the perimeter without its holder', async () => {
    const version = (
      await dbWorker
        .selectFrom('cg.reentry_pass')
        .select('version')
        .where('id', '=', passId)
        .executeTakeFirstOrThrow()
    ).version;
    const revoked = await call('director', 'POST', `/reentry-passes/${passId}/revoke`, undefined, {
      ...reason,
      'x-reason': 'Exercise: the house is unsafe',
      'if-match': `"${version}"`,
    });
    expect(revoked.status, revoked.body).toBe(200);
    const refused = (await scan('checkpoint', code)).json<Check>();
    expect(refused).toMatchObject({ result: 'revoked', kind: 'reentry' });
    expect(refused.holderName).toBeUndefined();

    const second = (
      await call('director', 'POST', '/reentry-passes', { eventId, ...pass, people: 1 }, reason)
    ).json<{ id: string; code: string }>();
    await dbWorker
      .updateTable('cg.reentry_pass')
      .set({
        valid_from: new Date(Date.now() - 2 * 3_600_000),
        valid_to: new Date(Date.now() - 3_600_000),
      })
      .where('id', '=', second.id)
      .execute();
    const expired = (await scan('checkpoint', second.code)).json<Check>();
    expect(expired).toMatchObject({ result: 'expired', kind: 'reentry' });
    expect(expired.address).toBeUndefined();
    expect((await scan('checkpoint', 'ZZZZ-ZZZZ-ZZZZ')).json()).toEqual({ result: 'unknown' });
  });
});

/**
 * Finding a survivor's report without their code (FL-02, RULE-17, SEC-18).
 * By phone, the county texts the survivor a code and nothing is shown until
 * it is read back; by address and name, matching reports are offered with
 * only their date and channel, and the reference code is shown once the
 * survivor confirms. The answers never reveal whether a phone is on file,
 * only readers of reports may look, and every step is audited. Runs on a
 * county of its own, only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, randomCode, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';
import { PHONE_LOOKUPS_PER_HOUR } from '../src/routes/survivor-lookup.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!appUrl || !workerUrl)("finding a survivor's report without their code", () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let eventId = '';
  let otherEventId = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const PHONE = '(314) 555-0142';
  const reports: Record<string, { id: string; code: string }> = {};

  const call = async (who: string, url: string, payload: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID() },
      payload: payload as Record<string, unknown>,
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  const otpSent = async () => {
    const rows = await dbWorker
      .selectFrom('cg.outbox')
      .select('payload')
      .where('tenant_id', '=', county)
      .where('topic', '=', 'message.send')
      .execute();
    return rows.map((r) => r.payload as Record<string, unknown>);
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
        slug: `exercise-lookup-${run}`,
        name: `Exercise lookup county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      const ev = async (name: string) =>
        (
          await trx
            .insertInto('cg.event')
            .values({
              tenant_id: county,
              name,
              hazard_type: 'tornado',
              status: 'active',
              opened_at: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      eventId = await ev(`Exercise lookup storm ${run}`);
      otherEventId = await ev(`Exercise lookup flood ${run}`);
      const party = async (name: string, phone: string | null, language = 'en') =>
        (
          await trx
            .insertInto('cg.party')
            .values({
              tenant_id: county,
              kind: 'resident',
              display_name_enc: await crypto.encrypt(county, name),
              phone_bidx: phone ? await crypto.blindIndex(county, 'phone', '+13145550142') : null,
              language,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const place = (
        await trx
          .insertInto('cg.location')
          .values({
            tenant_id: county,
            line1: '140 Cedar Ct.',
            city: 'Harmon City',
            postal: '63002',
            address_key: '140 cedar ct|63002',
            precision: 'exact',
            source: 'resident',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const maria = await party('María López Ruiz', PHONE, 'es');
      const john = await party('John Smith', null);
      for (const [k, who, ev, withdrawn] of [
        ['maria', maria, eventId, false],
        ['mariaOld', maria, eventId, true],
        ['john', john, eventId, false],
        ['mariaFlood', maria, otherEventId, false],
      ] as const) {
        const code = randomCode();
        const id = (
          await trx
            .insertInto('cg.report')
            .values({
              tenant_id: county,
              event_id: ev,
              reference_code: code,
              execution_id: randomUUID(),
              graph_key: 'damage',
              graph_version: 1,
              channel_of_origin: 'sms',
              relationship: 'own_home',
              reporter_party_id: who,
              location_id: place,
              ...(withdrawn ? { withdrawn_at: new Date() } : {}),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        reports[k] = { id, code };
      }
    });
    const as = (template: string, eventIds?: string[]): AccountSubject => {
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
            scope: eventIds ? { eventIds } : {},
          },
        ],
        resolvedAt: new Date(),
      };
    };
    subjects['mc'] = as('mass_care_coordinator');
    subjects['mc2'] = as('mass_care_coordinator');
    subjects['pio'] = as('public_information_officer');
    // A canvasser reads reports only in the events they are assigned to.
    subjects['canvasser'] = as('canvasser', [otherEventId]);
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

  it('FL-02, RULE-17: by phone, the survivor is texted a code (encrypted in the queue) and nothing is shown until they read it back; an unknown number gets the same answer', async () => {
    const unknown = await call('mc', '/survivor-lookup/phone', { phone: '314 555 0199' });
    const sent = await call('mc', '/survivor-lookup/phone', { phone: PHONE });
    expect(sent.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(sent.body);
    expect(Object.keys(sent.body).sort()).toEqual(['message', 'status']);

    const queued = await otpSent();
    expect(queued).toHaveLength(1);
    const p = queued[0]!;
    expect(p['template']).toBe('otp');
    expect(p['language']).toBe('es');
    expect(p['variables']).toEqual({});
    expect(JSON.stringify(p)).not.toMatch(/"code"/);
    const { code } = JSON.parse(
      await crypto.decrypt(county, Buffer.from(p['secretVariablesEnc'] as string, 'base64')),
    ) as { code: string };
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await call('mc', '/survivor-lookup/phone/verify', {
      phone: PHONE,
      code: code === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(401);
    const right = await call('mc', '/survivor-lookup/phone/verify', {
      phone: '+1 314 555 0142',
      code,
    });
    expect(right.status, JSON.stringify(right.body)).toBe(200);
    const found = (right.body['reports'] as { referenceCode: string }[]).map(
      (r) => r.referenceCode,
    );
    // Every report on that phone the worker may read, never a withdrawn one.
    expect(found.sort()).toEqual([reports['maria']!.code, reports['mariaFlood']!.code].sort());
    // A code works once.
    expect((await call('mc', '/survivor-lookup/phone/verify', { phone: PHONE, code })).status).toBe(
      401,
    );
  });

  it('FL-02: a code is locked after five wrong tries', async () => {
    await call('mc2', '/survivor-lookup/phone', { phone: PHONE });
    const payload = (await otpSent()).at(-1)!;
    const { code } = JSON.parse(
      await crypto.decrypt(county, Buffer.from(payload['secretVariablesEnc'] as string, 'base64')),
    ) as { code: string };
    const bad = code === '222222' ? '333333' : '222222';
    for (let i = 0; i < 5; i++)
      expect(
        (await call('mc2', '/survivor-lookup/phone/verify', { phone: PHONE, code: bad })).status,
      ).toBe(401);
    expect(
      (await call('mc2', '/survivor-lookup/phone/verify', { phone: PHONE, code })).status,
    ).toBe(401);
  });

  it('FL-02: by address and name, matches are offered with their date and channel only; the code is shown once the survivor confirms', async () => {
    const res = await call('mc', '/survivor-lookup/address', {
      line1: '140 CEDAR CT',
      name: 'maria lopez',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const candidates = res.body['candidates'] as Record<string, unknown>[];
    expect(candidates.map((c) => c['reportId']).sort()).toEqual(
      [reports['maria']!.id, reports['mariaFlood']!.id].sort(),
    );
    for (const c of candidates)
      expect(Object.keys(c).sort()).toEqual(['channel', 'reportId', 'submittedAt']);
    // Another name at the same address, or another ZIP, finds nothing of hers.
    expect(
      (
        (await call('mc', '/survivor-lookup/address', { line1: '140 Cedar Ct', name: 'Ana Lopez' }))
          .body['candidates'] as unknown[]
      ).length,
    ).toBe(0);
    expect(
      (
        (
          await call('mc', '/survivor-lookup/address', {
            line1: '140 Cedar Ct',
            postal: '63003',
            name: 'Maria Lopez',
          })
        ).body['candidates'] as unknown[]
      ).length,
    ).toBe(0);

    const confirmed = await call('mc', '/survivor-lookup/confirm', {
      reportId: reports['maria']!.id,
      note: 'She recognised the date and the street',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body['referenceCode']).toBe(reports['maria']!.code);

    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select(['action', 'target_id', 'reason'])
      .where('tenant_id', '=', county)
      .where('action', '=', 'survivor.find')
      .execute();
    expect(audited.find((a) => a.target_id === reports['maria']!.id && a.reason)?.reason).toBe(
      'She recognised the date and the street',
    );
  });

  it('FL-02: only readers of reports may look, and only at reports they may read', async () => {
    for (const [url, body] of [
      ['/survivor-lookup/phone', { phone: PHONE }],
      ['/survivor-lookup/address', { line1: '140 Cedar Ct', name: 'Maria' }],
      ['/survivor-lookup/confirm', { reportId: reports['maria']!.id }],
    ] as const)
      expect((await call('pio', url, body)).status, url).toBe(403);
    // The canvasser works the flood only: the storm report is not offered or confirmed.
    const offered = await call('canvasser', '/survivor-lookup/address', {
      line1: '140 Cedar Ct',
      name: 'María',
    });
    expect((offered.body['candidates'] as { reportId: string }[]).map((c) => c.reportId)).toEqual([
      reports['mariaFlood']!.id,
    ]);
    expect(
      (await call('canvasser', '/survivor-lookup/confirm', { reportId: reports['maria']!.id }))
        .status,
    ).toBe(404);
  });

  it('FL-02: each worker may text survivors only so often', async () => {
    subjects['busy'] = { ...subjects['mc']!, accountId: randomUUID() };
    for (let i = 0; i < PHONE_LOOKUPS_PER_HOUR; i++)
      expect((await call('busy', '/survivor-lookup/phone', { phone: '314 555 0100' })).status).toBe(
        202,
      );
    expect((await call('busy', '/survivor-lookup/phone', { phone: '314 555 0100' })).status).toBe(
      429,
    );
  });
});

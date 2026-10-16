/**
 * Job aids, human-reviewed (FL-15, BRD:FR-18.03, ADM-05 G4), against the
 * database. A coordinator writes one in plain text: it is a draft, off the
 * phones, and nothing typed becomes markup. Only an approver may approve it,
 * with a reason, and never the last person to change it; changing an
 * approved aid takes it off the phones until it is approved again; a retired
 * aid cannot be changed. Exercise drafts reach phones only on a synthetic
 * stack. Runs only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
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
import { statusesOnPhones } from '../src/routes/job-aids.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Aid {
  id: string;
  version: number;
  key: string;
  lang: string;
  title: string;
  text: string;
  status: string;
  onPhones: boolean;
  lastChangedBy: string | null;
  lastChangedByYou: boolean;
  approvedBy: string | null;
}

describe.skipIf(!appUrl || !workerUrl)('job aids (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  const run = randomUUID().slice(0, 8);
  const slug = `exercise-aids-${run}`;
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
  const decide = (who: string, aid: Aid, op: 'approve' | 'retire', reason?: string) =>
    call<Aid & { code?: string }>(who, 'POST', `/job-aids/${aid.id}/${op}`, undefined, {
      'if-match': `"${aid.version}"`,
      ...(reason ? { 'x-confirm': 'true', 'x-reason': reason } : {}),
    });
  const change = (who: string, aid: Aid, body: Record<string, unknown>) =>
    call<Aid & { code?: string }>(who, 'PATCH', `/job-aids/${aid.id}`, body, {
      'if-match': `"${aid.version}"`,
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
        slug,
        name: `Exercise job aid county ${run}`,
        status: 'active',
        locales: ['en', 'es'],
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const cast = [
      ['coordinator', 'damage_assessment_coordinator', 'Exercise DA Coordinator'],
      ['director', 'county_em_director', 'Exercise EM Director'],
      ['safety', 'safety_officer', 'Exercise Safety Officer'],
      ['assessor', 'damage_assessor', 'Exercise Assessor'],
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

  let aid: Aid;

  it('FL-15: a coordinator writes a job aid in plain text; it is a draft, off the phones, and nothing typed is markup', async () => {
    const res = await call<Aid>('coordinator', 'POST', '/job-aids', {
      key: 'roof-check',
      roleKey: 'damage_assessor',
      lang: 'en',
      kind: 'checklist',
      title: 'Roof check before you climb',
      text: '## Before you climb\n- Look for sagging <b>rafters</b>\n- Never alone\n\nIf unsure, assess from the ground.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    aid = res.body;
    expect(aid).toMatchObject({
      status: 'draft',
      onPhones: false,
      lastChangedBy: 'Exercise DA Coordinator',
      lastChangedByYou: true,
    });
    expect(aid.text).toContain('- Look for sagging <b>rafters</b>');
    const stored = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.job_aid')
        .select('body_html')
        .where('id', '=', aid.id)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.body_html).toContain('&lt;b&gt;rafters&lt;/b&gt;');
    expect(stored.body_html).not.toContain('<b>');
    // One per key and language; only the county's languages.
    const again = await call<{ code: string }>('coordinator', 'POST', '/job-aids', {
      key: 'roof-check',
      roleKey: null,
      lang: 'en',
      kind: 'checklist',
      title: 'Another roof check',
      text: 'Some other words here.',
    });
    expect(again.status).toBe(409);
    expect(
      (
        await call('coordinator', 'POST', '/job-aids', {
          key: 'roof-check',
          roleKey: null,
          lang: 'vi',
          kind: 'checklist',
          title: 'Roof check',
          text: 'Some words here.',
        })
      ).status,
    ).toBe(400);
    // A field role reads its aids on the phone, not the drafts here.
    expect((await call('assessor', 'GET', '/job-aids')).status).toBe(403);
  });

  it('ADM-05 G4: only an approver approves, with a reason; a change takes it off the phones; the last editor cannot approve it', async () => {
    // The coordinator may write but not approve.
    expect((await decide('coordinator', aid, 'approve', 'Exercise: looks right')).status).toBe(403);
    // A reason is required.
    expect((await decide('director', aid, 'approve')).status).toBe(428);
    const approved = await decide('director', aid, 'approve', 'Exercise: matches the county SOP');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    aid = approved.body;
    expect(aid).toMatchObject({
      status: 'approved',
      onPhones: true,
      approvedBy: 'Exercise EM Director',
    });

    // The director changes the approved aid: it is a draft again, off the phones.
    const changed = await change('director', aid, { text: '## Before you climb\n- Never alone' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    aid = changed.body;
    expect(aid).toMatchObject({
      status: 'draft',
      onPhones: false,
      approvedBy: null,
      lastChangedByYou: true,
    });
    // The director last changed it, so another approver approves it.
    expect((await decide('director', aid, 'approve', 'Exercise: my own change')).status).toBe(403);
    const second = await decide('safety', aid, 'approve', 'Exercise: second pair of eyes');
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    aid = second.body;
    expect(aid).toMatchObject({ status: 'approved', approvedBy: 'Exercise Safety Officer' });

    const audit = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select(['action', 'reason'])
        .where('target_id', '=', aid.id)
        .orderBy('seq')
        .execute(),
    );
    // Each refusal is audited too: the coordinator's try and the director's own change.
    expect(audit.map((a) => a.action)).toEqual([
      'job_aid.drafted',
      'authz.deny',
      'job_aid.approve',
      'job_aid.changed',
      'authz.deny',
      'job_aid.approve',
    ]);
    expect(audit[2]!.reason).toBe('Exercise: matches the county SOP');
  });

  it('a retired aid leaves the phones and cannot be changed; exercise drafts reach phones only on a synthetic stack', async () => {
    const retired = await decide(
      'safety',
      aid,
      'retire',
      'Exercise: replaced by the state checklist',
    );
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ status: 'retired', onPhones: false });
    expect((await change('director', retired.body, { title: 'Back again' })).status).toBe(409);

    // An exercise draft, as the synthetic county ships them (no author), can be approved.
    const seeded = await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.job_aid')
        .values({
          tenant_id: county,
          key: 'shelter-standards',
          lang: 'en',
          kind: 'standard',
          title: 'Shelter standards checklist',
          body_html: '<ul><li>40 square feet per person.</li></ul>',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const list = (await call<Aid[]>('director', 'GET', '/job-aids')).body;
    const draft = list.find((a) => a.id === seeded.id)!;
    expect(draft).toMatchObject({
      status: 'exercise_draft',
      onPhones: true,
      text: '- 40 square feet per person.',
    });
    expect(statusesOnPhones('synthetic')).toContain('exercise_draft');
    expect(statusesOnPhones('production')).toEqual(['approved']);
    const ok = await decide('director', draft, 'approve', 'Exercise: reviewed for the county');
    expect(ok.body).toMatchObject({ status: 'approved', onPhones: true });
  });
});

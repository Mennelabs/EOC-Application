/**
 * FEMA form mappings against the database (layer-6 task F; DCL:DEC-12,
 * DEC-15, RULE-14, SEC-05): every form starts on the shipped version 1; a
 * reporting officer drafts version 2 when FEMA changes a label, and cannot
 * draft a field outside the vocabulary or a second draft at once; only the
 * director activates, with a confirmed reason, which retires the version it
 * replaces; an active version is never edited; another county still uses
 * version 1. Runs only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { SHIPPED } from '@cg/reporting';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { mappingInForce } from '../src/routes/fema-mappings.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Version {
  id: string | null;
  version: number | null;
  mappingVersion: number;
  status: string;
  femaFormVersion: string;
  fields: { code: string; label: string; element: string }[];
  code?: string;
  fieldsErrors?: unknown;
}
interface FormRow {
  form: string;
  inForce: { mappingVersion: number; status: string };
  versions: { mappingVersion: number; status: string }[];
}

describe.skipIf(!appUrl || !workerUrl)('FEMA form mappings (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  const counties: Record<string, string> = {};
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const subjects: Record<string, AccountSubject> = {};
    for (const name of ['a', 'b']) {
      const c = await dbWorker
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-map-${name}-${run}`,
          name: `Exercise mapping county ${name} ${run}`,
          status: 'provisioning',
        })
        .returning(['id', 'path', 'kind'])
        .executeTakeFirstOrThrow();
      counties[name] = c.id;
      const subject = (template: string): AccountSubject => {
        const r = roleTemplates.find((x) => x.key === template)!;
        return {
          kind: 'account',
          accountId: randomUUID(),
          tenantId: c.id,
          tenantPath: c.path,
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
      subjects[`officer-${name}`] = subject('reporting_planning');
      subjects[`director-${name}`] = subject('county_em_director');
      subjects[`assessor-${name}`] = subject('damage_assessor');
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
      routes: routesWith(),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', 'like', `exercise-map-%-${run}`)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  const call = async <T = Version>(
    who: string,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as T };
  };
  const v = (r: { version: number | null }) => ({ 'if-match': `"${r.version}"` });
  const confirm = { 'x-confirm': 'true', 'x-reason': 'Exercise: FEMA renamed a summary field' };
  const inForce = (county: string) =>
    withTenant(dbApp, { tenantId: county }, (trx) =>
      mappingInForce(trx, county, 'ia_summary_sheet'),
    );

  it('starts every form on the shipped version 1', async () => {
    const list = await call<FormRow[]>('officer-a', 'GET', '/fema-mappings');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(10);
    expect(
      list.body.every((f) => f.inForce.mappingVersion === 1 && f.inForce.status === 'shipped'),
    ).toBe(true);
    const one = await call('officer-a', 'GET', '/fema-mappings/ia_summary_sheet/versions/1');
    expect(one.body.fields).toEqual(SHIPPED.ia_summary_sheet.fields);
    expect((await call('assessor-a', 'GET', '/fema-mappings')).status).toBe(403);
  });

  it('DEC-15: a new version is drafted, checked, edited, and activated by the director with a reason', async () => {
    const fields = SHIPPED.ia_summary_sheet.fields.map((f) =>
      f.code === 'UNITS-TOTAL' ? { ...f, label: 'Total damaged housing units' } : f,
    );
    const bad = await call<{ code: string; fields: { name: string; message: string }[] }>(
      'officer-a',
      'POST',
      '/fema-mappings/ia_summary_sheet/versions',
      {
        femaFormVersion: 'Exercise edition',
        fields: [...fields, { code: 'X', label: 'Name', element: 'resident.name' }],
      },
    );
    expect(bad.status).toBe(400);
    expect(bad.body.fields[0]!.message).toMatch(/not a data element/);
    const draft = await call('officer-a', 'POST', '/fema-mappings/ia_summary_sheet/versions', {
      femaFormVersion: 'Exercise edition',
      sourceDocument: 'Exercise: FEMA PDA summary sheet, exercise revision',
      fields,
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({ mappingVersion: 2, status: 'draft' });
    const second = await call('officer-a', 'POST', '/fema-mappings/ia_summary_sheet/versions', {
      femaFormVersion: 'Another',
    });
    expect(second.status).toBe(409);
    const edited = await call(
      'officer-a',
      'PUT',
      '/fema-mappings/ia_summary_sheet/versions/2',
      { note: 'Exercise: label follows the new form' },
      v(draft.body),
    );
    expect(edited.status).toBe(200);
    // The officer drafts; the director puts it in force, with a reason.
    expect(
      (
        await call(
          'officer-a',
          'POST',
          '/fema-mappings/ia_summary_sheet/versions/2/activate',
          undefined,
          { ...v(edited.body), ...confirm },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          'director-a',
          'POST',
          '/fema-mappings/ia_summary_sheet/versions/2/activate',
          undefined,
          v(edited.body),
        )
      ).status,
    ).toBe(428);
    const active = await call(
      'director-a',
      'POST',
      '/fema-mappings/ia_summary_sheet/versions/2/activate',
      undefined,
      {
        ...v(edited.body),
        ...confirm,
      },
    );
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body.status).toBe('active');
    const now = await inForce(counties['a']!);
    expect(now).toMatchObject({
      mappingVersion: 2,
      femaFormVersion: 'Exercise edition',
      status: 'active',
    });
    expect(now.fields.find((f) => f.code === 'UNITS-TOTAL')!.label).toBe(
      'Total damaged housing units',
    );
    // An active version is never edited.
    expect(
      (
        await call(
          'officer-a',
          'PUT',
          '/fema-mappings/ia_summary_sheet/versions/2',
          { note: 'x' },
          v(active.body),
        )
      ).status,
    ).toBe(409);
  });

  it('activating a later version retires the one it replaces; another county keeps version 1', async () => {
    const d3 = (
      await call('officer-a', 'POST', '/fema-mappings/ia_summary_sheet/versions', {
        femaFormVersion: 'Exercise edition 3',
      })
    ).body;
    expect(d3.mappingVersion).toBe(3);
    await call(
      'director-a',
      'POST',
      '/fema-mappings/ia_summary_sheet/versions/3/activate',
      undefined,
      { ...v(d3), ...confirm },
    );
    const list = (await call<FormRow[]>('officer-a', 'GET', '/fema-mappings')).body.find(
      (f) => f.form === 'ia_summary_sheet',
    )!;
    expect(list.inForce.mappingVersion).toBe(3);
    expect(list.versions.map((x) => [x.mappingVersion, x.status])).toEqual([
      [3, 'active'],
      [2, 'retired'],
      [1, 'shipped'],
    ]);
    expect(await inForce(counties['b']!)).toMatchObject({ mappingVersion: 1, status: 'shipped' });
    expect(
      (await call('officer-b', 'GET', '/fema-mappings/ia_summary_sheet/versions/3')).status,
    ).toBe(404);
    const audited = await withTenant(dbWorker, { tenantId: counties['a']! }, (trx) =>
      trx
        .selectFrom('cg.audit_event')
        .select('action')
        .where('target_type', '=', 'fema_form_mapping')
        .execute(),
    );
    expect(new Set(audited.map((a) => a.action))).toEqual(
      // The officer's refused activation is in the chain too.
      new Set(['fema_mapping.write', 'fema_mapping.activate', 'authz.deny']),
    );
  });
});

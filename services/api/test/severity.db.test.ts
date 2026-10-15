/**
 * The damage severity suggestion against a real PostgreSQL (layer-7 task I;
 * PHO-09, PHO-10, PHO-11, PHO-12 and PHO-13 as decided 2026-10-15,
 * DCL:DEC-02, AIG-01). With the register's photo.severity off nothing is
 * suggested; switched on, the worker's classifier looks at the report's
 * blurred review copies (never the original) with its hazard, the suggestion
 * is kept with its provider and model, and the same photos are not looked at
 * twice. A reviewer reads it labelled "AI suggestion — not verified"; someone
 * without the review action does not; setting the degree records whether the
 * reviewer agreed, on the decision and on the AI record. Runs only with
 * API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { fakeProvider, type AiProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { reportSeverity } from '../../worker/src/jobs/severity.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

/** What the classifier was shown, to check it is the review copy and the hazard. */
const shown: { keys: string[]; context: unknown }[] = [];
const fetched: string[] = [];
const classifying: AiProvider = {
  ...fakeProvider,
  classifier: {
    classify: async (images, context) => {
      shown.push({ keys: [...fetched], context });
      return {
        output: {
          degree: 'major',
          confidence: 0.8125,
          visibleFeatures: ['roof decking exposed', 'water line above outlets'],
        },
        provider: { provider: 'fake', model: 'keyword-rules', templateVersion: 'test-1' },
        latencyMs: 2,
      };
    },
  },
};

describe.skipIf(!appUrl || !workerUrl)('damage severity suggestion (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let reportId = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const ctx = () =>
    ({
      db: dbWorker,
      log: { warn: () => undefined },
      objects: {
        get: async (key: string) => {
          fetched.push(key);
          return { body: Buffer.from('webp bytes'), contentType: 'image/webp' };
        },
      },
      ai: { providerFor: async () => classifying },
    }) as unknown as JobContext;
  const message = () => ({
    id: 1,
    tenantId: county,
    topic: 'report.severity',
    payload: { reportId },
    executionId: null,
  });
  const suggestions = () =>
    dbWorker
      .selectFrom('cg.damage_suggestion')
      .selectAll()
      .where('report_id', '=', reportId)
      .execute();

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-severity-${run}`,
        name: `Exercise severity county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const eventId = await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      await trx
        .insertInto('cg.ai_use_register')
        .values({
          tenant_id: county,
          feature: 'photo.severity',
          provider: 'fake',
          model: 'keyword-rules',
          model_version: null,
          data_sent: 'Review copies of photos',
          decision_informed: 'A suggestion for reviewers',
          human_checkpoint: 'A reviewer sets the degree',
          owner: 'Damage assessment lead',
          evaluation: JSON.stringify({}),
          enabled: false,
        })
        .execute();
      return (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise severity flood ${run}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(Date.now() - 24 * 3_600_000),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    const { reportIds } = await loadDamageReports(dbWorker, {
      tenantId: county,
      eventId,
      reviewerId: randomUUID(),
      count: 2,
      tag: `sev${run}`,
    });
    reportId = reportIds[0]!;
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      const r = await trx
        .selectFrom('cg.report')
        .select('execution_id')
        .where('id', '=', reportId)
        .executeTakeFirstOrThrow();
      for (const n of [1, 2])
        await trx
          .insertInto('cg.photo')
          .values({
            tenant_id: county,
            execution_id: r.execution_id,
            report_id: reportId,
            object_key_original: `tenants/${county}/restricted/${run}/${n}/original.jpg`,
            status: 'processed',
            derivative_keys: JSON.stringify({
              review: `tenants/${county}/restricted/${run}/${n}/review.webp`,
              thumb: `tenants/${county}/restricted/${run}/${n}/thumb.webp`,
            }),
          })
          .execute();
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
    subjects['reviewer'] = as('assessment_reviewer');
    subjects['pio'] = as('public_information_officer');
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

  it('AI-10: with photo.severity off, nothing is suggested and the classifier is not asked', async () => {
    await reportSeverity(ctx(), message());
    expect(await suggestions()).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('PHO-09, PHO-12, AIG-01: switched on, the review copies and the hazard are classified, recorded, and not twice', async () => {
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.ai_use_register')
        .set({ enabled: true })
        .where('tenant_id', '=', county)
        .where('feature', '=', 'photo.severity')
        .execute(),
    );
    await reportSeverity(ctx(), message());
    const rows = await suggestions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      degree: 'major',
      provider: 'fake',
      template_version: 'test-1',
      visible_features: ['roof decking exposed', 'water line above outlets'],
    });
    expect(Number(rows[0]!.confidence)).toBeCloseTo(0.813, 3);
    expect(rows[0]!.photo_ids).toHaveLength(2);
    expect(shown[0]!.keys.every((k) => k.endsWith('/review.webp'))).toBe(true);
    expect(shown[0]!.context).toMatchObject({ hazard: 'flood' });
    const record = await dbWorker
      .selectFrom('cg.ai_output')
      .select(['feature', 'outcome', 'target_type', 'target_id'])
      .where('id', '=', rows[0]!.ai_output_id!)
      .executeTakeFirstOrThrow();
    expect(record).toEqual({
      feature: 'photo.severity',
      outcome: 'ok',
      target_type: 'report',
      target_id: reportId,
    });
    await reportSeverity(ctx(), message());
    expect(await suggestions()).toHaveLength(1);
  });

  it('PHO-10: a reviewer reads it labelled as not verified; a role without review does not', async () => {
    const res = await app.inject({
      url: `/api/v1/reports/${reportId}/suggestion`,
      headers: { authorization: 'Bearer reviewer' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      label: 'AI suggestion — not verified',
      degree: 'major',
      confidence: 0.813,
      photoCount: 2,
    });
    const pio = await app.inject({
      url: `/api/v1/reports/${reportId}/suggestion`,
      headers: { authorization: 'Bearer pio' },
    });
    expect(pio.statusCode).toBe(404);
    const other = await app.inject({
      url: `/api/v1/reports/${randomUUID()}/suggestion`,
      headers: { authorization: 'Bearer reviewer' },
    });
    expect(other.statusCode).toBe(404);
  });

  it('PHO-11, PHO-13: setting the degree records whether the reviewer agreed', async () => {
    const report = await dbWorker
      .selectFrom('cg.report')
      .select('version')
      .where('id', '=', reportId)
      .executeTakeFirstOrThrow();
    const reason = 'Exercise: water above the outlets, roof open; not habitable.';
    const set = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/fema-degree`,
      headers: {
        authorization: 'Bearer reviewer',
        'idempotency-key': randomUUID(),
        'if-match': `"${report.version}"`,
        'x-confirm': 'true',
        'x-reason': reason,
      },
      payload: { degree: 'destroyed', reason },
    });
    expect(set.statusCode, set.body).toBe(200);
    const decision = await dbWorker
      .selectFrom('cg.review_decision')
      .select(['ai_suggestion_id', 'agreed_with_ai'])
      .where('report_id', '=', reportId)
      .where('decision', '=', 'set_degree')
      .executeTakeFirstOrThrow();
    const [s] = await suggestions();
    expect(decision).toEqual({ ai_suggestion_id: s!.id, agreed_with_ai: false });
    const record = await dbWorker
      .selectFrom('cg.ai_output')
      .select(['human_action', 'acted_by'])
      .where('id', '=', s!.ai_output_id!)
      .executeTakeFirstOrThrow();
    expect(record).toEqual({
      human_action: 'rejected',
      acted_by: subjects['reviewer']!.accountId,
    });
  });
});

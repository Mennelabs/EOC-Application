/**
 * The damage severity suggestion against a real PostgreSQL (layer-7 task I;
 * PHO-09, PHO-10, PHO-11, PHO-12 and PHO-13 as decided 2026-10-15,
 * DCL:DEC-02, AIG-01). With the register's photo.severity off nothing is
 * suggested; switched on, the worker's classifier looks at the report's
 * blurred review copies (never the original) with its hazard, the suggestion
 * is kept with its provider and model, and the same photos are not looked at
 * twice. A reviewer reads it labelled "AI suggestion — not verified"; someone
 * without the review action does not; setting the degree records whether the
 * reviewer agreed, on the decision and on the AI record. Agreement is
 * reported per model by hazard, home type and income band, and a group that
 * falls behind raises a fairness alert that clears when it catches up.
 * Runs only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { fakeProvider, type AiProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadDamageReports } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import sharp from 'sharp';
import { photoProcess } from '../../worker/src/jobs/photos.ts';
import { reportSeverity } from '../../worker/src/jobs/severity.ts';
import { evaluateAiHealthFor } from '../../worker/src/jobs/ai-health.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

/** What the classifier was shown, to check it is the review copy and the hazard. */
const shown: { keys: string[]; context: unknown }[] = [];
const fetched: string[] = [];
/** Set to make the classifier fail, as a timeout or outage would (GATE-08). */
let classifierFails = false;
const classifying: AiProvider = {
  ...fakeProvider,
  classifier: {
    classify: async (images, context) => {
      if (classifierFails) throw new Error('provider unavailable');
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
            blur_status: 'applied',
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
    subjects['director'] = as('county_em_director');
    subjects['admin'] = as('tenant_admin');
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

  it('PHO-07, AIG-05, GATE-08: a photo the detector did not clear is never sent; a failing classifier is recorded and suggests nothing', async () => {
    const key = `tenants/${county}/restricted/${run}/3/review.webp`;
    const extra = await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      const r = await trx
        .selectFrom('cg.report')
        .select('execution_id')
        .where('id', '=', reportId)
        .executeTakeFirstOrThrow();
      return (
        await trx
          .insertInto('cg.photo')
          .values({
            tenant_id: county,
            execution_id: r.execution_id,
            report_id: reportId,
            object_key_original: `tenants/${county}/restricted/${run}/3/original.jpg`,
            status: 'processed',
            blur_status: 'skipped_no_detector',
            derivative_keys: JSON.stringify({ review: key }),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    fetched.length = 0;
    await reportSeverity(ctx(), message());
    // The uncleared photo is left out, so the set is the one already classified: nothing new.
    expect(fetched).not.toContain(key);
    expect(await suggestions()).toHaveLength(1);
    // Cleared, it changes the set; the classifier fails: recorded, no suggestion, no throw.
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx.updateTable('cg.photo').set({ blur_status: 'applied' }).where('id', '=', extra).execute(),
    );
    classifierFails = true;
    try {
      await reportSeverity(ctx(), message());
    } finally {
      classifierFails = false;
    }
    expect(fetched).toContain(key);
    expect(await suggestions()).toHaveLength(1);
    const failed = await dbWorker
      .selectFrom('cg.ai_output')
      .select('outcome')
      .where('tenant_id', '=', county)
      .where('feature', '=', 'photo.severity')
      .where('outcome', '=', 'error')
      .execute();
    expect(failed).toHaveLength(1);
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

  it('PHO-14: among reports with the same needs, the more severe suggestion comes first; age next', async () => {
    const [first, second] = [
      reportId,
      (
        await dbWorker
          .selectFrom('cg.report')
          .select('id')
          .where('tenant_id', '=', county)
          .where('id', '<>', reportId)
          .executeTakeFirstOrThrow()
      ).id,
    ];
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      await trx
        .updateTable('cg.report')
        .set({ need_signals: '{}' })
        .where('tenant_id', '=', county)
        .execute();
      // Age alone would put the second first; the first carries the "major" suggestion.
      await trx
        .updateTable('cg.report')
        .set({ submitted_at: new Date() })
        .where('id', '=', first)
        .execute();
      await trx
        .updateTable('cg.report')
        .set({ submitted_at: new Date(Date.now() - 86_400_000) })
        .where('id', '=', second!)
        .execute();
    });
    const list = (
      await app.inject({
        url: '/api/v1/reports?limit=50',
        headers: { authorization: 'Bearer reviewer' },
      })
    ).json() as { id: string }[];
    const ids = list.map((r) => r.id);
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second!));
    // A need signal still outranks any suggestion.
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.report')
        .set({ need_signals: JSON.stringify({ no_shelter: true }) })
        .where('id', '=', second!)
        .execute(),
    );
    const again = (
      (
        await app.inject({
          url: '/api/v1/reports?limit=50',
          headers: { authorization: 'Bearer reviewer' },
        })
      ).json() as { id: string }[]
    ).map((r) => r.id);
    expect(again.indexOf(second!)).toBeLessThan(again.indexOf(first));
  });

  it('PHO-15: a photo that looks the same as one on another report flags that report for a person', async () => {
    const store = new Map<string, Buffer>();
    const scene = await sharp({
      create: { width: 1000, height: 750, channels: 3, background: '#4a6' },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="1000" height="750"><rect x="90" y="100" width="380" height="300" fill="#fff"/><circle cx="760" cy="520" r="140" fill="#222"/></svg>',
          ),
        },
      ])
      .jpeg({ quality: 92 })
      .toBuffer();
    const copy = await sharp(scene).resize(500).jpeg({ quality: 50 }).toBuffer();
    const reports = await dbWorker
      .selectFrom('cg.report')
      .select(['id', 'execution_id'])
      .where('tenant_id', '=', county)
      .orderBy('submitted_at')
      .execute();
    const photoIds: string[] = [];
    for (const [i, bytes] of [scene, copy].entries()) {
      const key = `tenants/${county}/restricted/${run}/near-${i}/original.jpg`;
      store.set(key, bytes);
      photoIds.push(
        (
          await withTenant(dbWorker, { tenantId: county }, (trx) =>
            trx
              .insertInto('cg.photo')
              .values({
                tenant_id: county,
                execution_id: reports[i]!.execution_id,
                report_id: reports[i]!.id,
                object_key_original: key,
                status: 'uploaded',
                content_type: 'image/jpeg',
              })
              .returning('id')
              .executeTakeFirstOrThrow(),
          )
        ).id,
      );
    }
    const worker = {
      db: dbWorker,
      log: { warn: () => undefined },
      objects: {
        get: async (key: string) => ({ body: store.get(key)!, contentType: 'image/jpeg' }),
        put: async (key: string, body: Buffer) => {
          store.set(key, body);
        },
      },
      ai: { providerFor: async () => null },
    } as unknown as JobContext;
    for (const id of photoIds)
      await photoProcess(worker, {
        id: 1,
        tenantId: county,
        topic: 'photo.process',
        payload: { photoId: id },
        executionId: null,
      });
    const flagged = await dbWorker
      .selectFrom('cg.report')
      .select('flags')
      .where('id', '=', reports[1]!.id)
      .executeTakeFirstOrThrow();
    expect(flagged.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'near_duplicate_photo',
          photoId: photoIds[1],
          reportId: reports[0]!.id,
        }),
      ]),
    );
    const hashes = await dbWorker
      .selectFrom('cg.photo')
      .select('phash')
      .where('id', 'in', photoIds)
      .execute();
    expect(hashes.every((h) => h.phash !== null)).toBe(true);
  });

  it('PHO-13, AIG-09: agreement by group per model; a group behind raises one fairness alert, seen by the register, cleared when it catches up', async () => {
    const other = (
      await dbWorker
        .selectFrom('cg.report')
        .select('id')
        .where('tenant_id', '=', county)
        .where('id', '<>', reportId)
        .executeTakeFirstOrThrow()
    ).id;
    /** Decisions on a report against one suggestion from the same model, agreed or not. */
    const decide = (report: string, agreed: boolean[]) =>
      withTenant(dbWorker, { tenantId: county }, async (trx) => {
        const s = await trx
          .insertInto('cg.damage_suggestion')
          .values({
            tenant_id: county,
            report_id: report,
            degree: 'major',
            confidence: 0.8,
            photo_ids: [randomUUID()],
            provider: 'fake',
            model: 'keyword-rules',
            template_version: 'test-1',
            ai_output_id: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const a of agreed)
          await trx
            .insertInto('cg.review_decision')
            .values({
              tenant_id: county,
              report_id: report,
              report_version: 1,
              reviewer_account_id: subjects['reviewer']!.accountId,
              decision: 'set_degree',
              reason: 'Exercise decision.',
              ai_suggestion_id: s.id,
              agreed_with_ai: a,
            })
            .execute();
      });
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      await trx
        .updateTable('cg.report')
        .set({ answers: sql`answers || '{"home_type":"mobile_home"}'::jsonb` })
        .where('id', '=', reportId)
        .execute();
      await trx
        .updateTable('cg.report')
        .set({ answers: sql`answers || '{"home_type":"single_family"}'::jsonb` })
        .where('id', '=', other)
        .execute();
    });
    // The reviewer disagreed on the manufactured home earlier; three agreements on the other.
    await decide(other, [true, true, true]);
    const read = async (who = 'director') =>
      app.inject({
        url: '/api/v1/ai-register/severity-agreement',
        headers: { authorization: `Bearer ${who}` },
      });
    expect((await read('pio')).statusCode).toBe(403);
    const before = await read();
    expect(before.statusCode, before.body).toBe(200);
    const body = before.json() as {
      minimum: number;
      models: {
        model: string;
        decisions: number;
        agreed: number;
        slices: { dimension: string; group: string; decisions: number; behind: boolean }[];
      }[];
    };
    expect(body.minimum).toBe(20);
    expect(body.models).toEqual([
      expect.objectContaining({ model: 'fake / keyword-rules / test-1', decisions: 4, agreed: 3 }),
    ]);
    const slices = body.models[0]!.slices;
    expect(slices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: 'hazard', group: 'flood', decisions: 4 }),
        expect.objectContaining({ dimension: 'home_type', group: 'manufactured', decisions: 1 }),
        expect.objectContaining({ dimension: 'home_type', group: 'conventional', decisions: 3 }),
      ]),
    );
    // Twenty decisions are needed before a group can be called behind.
    expect(slices.some((x) => x.behind)).toBe(false);
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: county,
          key: 'ai.fairness',
          value: JSON.stringify({ minimum: 1, margin: 0.1 }),
        })
        .execute(),
    );
    const now = (await read()).json() as typeof body;
    expect(now.models[0]!.slices.filter((x) => x.behind)).toEqual([
      expect.objectContaining({ dimension: 'home_type', group: 'manufactured' }),
    ]);
    const job = {
      db: dbWorker,
      log: { warn: () => undefined, info: () => undefined },
    } as unknown as JobContext;
    const first = await evaluateAiHealthFor(job, county);
    expect(first.raised).toHaveLength(1);
    expect((await evaluateAiHealthFor(job, county)).raised).toEqual([]);
    const alerts = await app.inject({
      url: '/api/v1/ai-register/alerts',
      headers: { authorization: 'Bearer director' },
    });
    expect(alerts.statusCode, alerts.body).toBe(200);
    const [alert] = alerts.json() as { id: string; kind: string; scope: string; feature: string }[];
    expect(alert).toMatchObject({
      feature: 'photo.severity',
      kind: 'fairness',
      scope: 'home_type:manufactured',
    });
    // The feature stays on: alerts never switch it off (AIG-09 as decided).
    const register = await dbWorker
      .selectFrom('cg.ai_use_register')
      .select('enabled')
      .where('tenant_id', '=', county)
      .where('feature', '=', 'photo.severity')
      .executeTakeFirstOrThrow();
    expect(register.enabled).toBe(true);
    const ack = (who: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/ai-register/alerts/${alert!.id}/acknowledge`,
        headers: {
          authorization: `Bearer ${who}`,
          'idempotency-key': randomUUID(),
          'x-confirm': 'true',
          'x-reason': 'Exercise: seen; reviewing manufactured-home photos with the lead.',
        },
      });
    expect((await ack('director')).statusCode).toBe(403);
    expect((await ack('admin')).statusCode).toBe(204);
    expect((await ack('admin')).statusCode).toBe(404);
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', county)
      .where('action', 'in', ['ai.health_alert_raised', 'ai.health_alert_acknowledged'])
      .execute();
    expect(audited.map((a) => a.action).sort()).toEqual([
      'ai.health_alert_acknowledged',
      'ai.health_alert_raised',
    ]);
    // Four agreements later the manufactured homes are within the margin: the alert clears.
    await decide(reportId, [true, true, true, true]);
    const later = await evaluateAiHealthFor(job, county);
    expect(later.cleared).toEqual([alert!.id]);
    const open = (
      await app.inject({
        url: '/api/v1/ai-register/alerts',
        headers: { authorization: 'Bearer director' },
      })
    ).json() as unknown[];
    expect(open).toEqual([]);
  });

  it('PHO-07, AIG-01, GATE-08: switched on, the detector blurs what it finds and the call is recorded; when it fails the photo keeps an unblurred, restricted copy marked failed', async () => {
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .insertInto('cg.ai_use_register')
        .values({
          tenant_id: county,
          feature: 'photo.sensitive_regions',
          provider: 'fake',
          model: 'keyword-rules',
          model_version: null,
          data_sent: 'Review copies of photos',
          decision_informed: 'Regions to blur',
          human_checkpoint: 'Staff with the evidence category see the original',
          owner: 'Privacy officer',
          evaluation: JSON.stringify({}),
          enabled: true,
        })
        .execute(),
    );
    let detectorFails = false;
    const detecting: AiProvider = {
      ...fakeProvider,
      image: {
        analyse: async () => {
          if (detectorFails) throw new Error('provider unavailable');
          return {
            output: {
              qualityIssues: [],
              sensitiveRegions: [{ kind: 'face', x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
              detectorAvailable: true,
            },
            provider: fakeProvider.info,
            latencyMs: 2,
          };
        },
      },
    };
    const store = new Map<string, Buffer>();
    const scene = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#8a6' },
    })
      .jpeg()
      .toBuffer();
    const report = await dbWorker
      .selectFrom('cg.report')
      .select(['id', 'execution_id'])
      .where('id', '=', reportId)
      .executeTakeFirstOrThrow();
    const worker = {
      db: dbWorker,
      log: { warn: () => undefined },
      objects: {
        get: async (key: string) => ({ body: store.get(key)!, contentType: 'image/jpeg' }),
        put: async (key: string, body: Buffer) => {
          store.set(key, body);
        },
      },
      ai: { providerFor: async () => detecting },
    } as unknown as JobContext;
    const photo = async (n: string) => {
      const key = `tenants/${county}/restricted/${run}/detect-${n}/original.jpg`;
      store.set(key, scene);
      const id = (
        await withTenant(dbWorker, { tenantId: county }, (trx) =>
          trx
            .insertInto('cg.photo')
            .values({
              tenant_id: county,
              execution_id: report.execution_id,
              report_id: report.id,
              object_key_original: key,
              status: 'uploaded',
              content_type: 'image/jpeg',
            })
            .returning('id')
            .executeTakeFirstOrThrow(),
        )
      ).id;
      await photoProcess(worker, {
        id: 1,
        tenantId: county,
        topic: 'photo.process',
        payload: { photoId: id },
        executionId: null,
      });
      return dbWorker
        .selectFrom('cg.photo')
        .select(['status', 'blur_status'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    };
    expect(await photo('ok')).toEqual({ status: 'processed', blur_status: 'applied' });
    detectorFails = true;
    expect(await photo('down')).toEqual({ status: 'processed', blur_status: 'failed' });
    const calls = await dbWorker
      .selectFrom('cg.ai_output')
      .select('outcome')
      .where('tenant_id', '=', county)
      .where('feature', '=', 'photo.sensitive_regions')
      .orderBy('created_at')
      .execute();
    expect(calls.map((c) => c.outcome)).toEqual(['ok', 'error']);
  });
});

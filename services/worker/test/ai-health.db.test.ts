/**
 * AI feature health against a real PostgreSQL (layer-7 task A; AIG-09 as
 * decided 2026-10-15, AI-10, AIG-01): too many corrections or failures in a
 * language raise one alert, tell the administrators once and are audited;
 * the feature is never switched off; the alert clears when the share falls
 * back. Too few outputs say nothing. Runs on a county of its own, only with
 * API_DB_TEST_WORKER_URL set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import type { Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { evaluateAiHealthFor } from '../src/jobs/ai-health.ts';
import type { JobContext } from '../src/jobs/types.ts';

const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

describe.skipIf(!workerUrl)('AI feature health (database-backed)', () => {
  let db: Kysely<Database>;
  let tenantId = '';
  let ctx: JobContext;
  const run = randomUUID().slice(0, 8);
  let clock = Date.now() - 3_600_000;

  /** Outputs in order, a second apart, so "the latest" is well defined. */
  const outputs = (
    n: number,
    o: {
      feature?: string;
      language?: string;
      outcome?: string;
      action?: string | null;
      complaint?: string;
    },
  ) =>
    withTenant(db, { tenantId }, async (trx) => {
      for (let i = 0; i < n; i++)
        await trx
          .insertInto('cg.ai_output')
          .values({
            tenant_id: tenantId,
            feature: o.feature ?? 'intake.extraction',
            provider: 'openai',
            model: 'gpt-5-mini',
            template_version: 'extraction-1',
            language: o.language ?? 'en',
            outcome: (o.outcome ?? 'ok') as 'ok',
            latency_ms: 900,
            human_action: (o.action === undefined ? 'accepted' : o.action) as 'accepted' | null,
            ...(o.complaint ? { complaint: o.complaint, complained_at: new Date(clock) } : {}),
            created_at: new Date((clock += 1000)),
          } as never)
          .execute();
    });
  const alerts = () =>
    withTenant(db, { tenantId }, (trx) =>
      trx
        .selectFrom('cg.ai_health_alert')
        .select(['id', 'feature', 'language', 'kind', 'counted', 'flagged', 'cleared_at'])
        .where('tenant_id', '=', tenantId)
        .orderBy('raised_at')
        .execute(),
    );

  beforeAll(async () => {
    db = createDb(workerUrl!, 2);
    const seeded = await loadSeed(db);
    tenantId = (
      await db
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-ai-health-${run}`,
          name: `Exercise AI health county ${run}`,
          status: 'provisioning',
          security_contact_email: `ai-health-${run}@example.org`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    ctx = {
      db,
      log: pino({ level: 'silent' }),
      crypto: new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore()),
    } as unknown as JobContext;
  });

  afterAll(async () => {
    await db
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', tenantId)
      .execute();
    await db?.destroy();
  });

  it('too few outputs say nothing', async () => {
    await outputs(5, { action: 'rejected', feature: 'review.translation' });
    expect(await evaluateAiHealthFor(ctx, tenantId)).toEqual({ raised: [], cleared: [] });
  });

  it('AIG-09: people correcting more than 30% of the last outputs in a language raises one alert, told once and audited; the feature stays on', async () => {
    await outputs(10, { action: 'accepted' });
    await outputs(10, { action: 'edited' });
    await outputs(5, { action: 'rejected' });
    const first = await evaluateAiHealthFor(ctx, tenantId);
    expect(first.raised).toHaveLength(1);
    expect(await alerts()).toEqual([
      expect.objectContaining({
        feature: 'intake.extraction',
        language: 'en',
        kind: 'corrections',
        counted: 25,
        flagged: 15,
        cleared_at: null,
      }),
    ]);
    // Told once, to the people who manage the register (here, the security contact).
    const notices = await withTenant(db, { tenantId }, (trx) =>
      trx
        .selectFrom('cg.notice_log')
        .select(['kind', 'recipient_count'])
        .where('tenant_id', '=', tenantId)
        .execute(),
    );
    expect(notices).toEqual([{ kind: 'ai_health', recipient_count: 1 }]);
    const queued = await db
      .selectFrom('cg.outbox')
      .select('payload')
      .where('tenant_id', '=', tenantId)
      .where('topic', '=', 'message.send')
      .execute();
    expect(queued.map((q) => (q.payload as { template: string }).template)).toEqual([
      'ai_quality_notice',
    ]);
    const audited = await db
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', tenantId)
      .execute();
    expect(audited.map((a) => a.action)).toContain('ai.health_alert_raised');
    // A second run keeps the one alert and tells nobody again.
    expect((await evaluateAiHealthFor(ctx, tenantId)).raised).toEqual([]);
    expect(await alerts()).toHaveLength(1);
  });

  it('AI-10: calls failing more than 30% of the time raise a failures alert for that language alone', async () => {
    await outputs(12, { language: 'es', outcome: 'timeout', action: null });
    await outputs(10, { language: 'es', outcome: 'ok', action: null });
    const r = await evaluateAiHealthFor(ctx, tenantId);
    expect(r.raised).toHaveLength(1);
    expect((await alerts()).find((a) => a.language === 'es')).toMatchObject({
      kind: 'failures',
      counted: 22,
      flagged: 12,
    });
  });

  it('clears an alert, audited, once the share falls back under the threshold', async () => {
    await outputs(50, { action: 'accepted' });
    const r = await evaluateAiHealthFor(ctx, tenantId);
    expect(r.cleared).toHaveLength(1);
    const en = (await alerts()).find((a) => a.language === 'en')!;
    expect(en.cleared_at).not.toBeNull();
    const audited = await db
      .selectFrom('cg.audit_event')
      .select('action')
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'ai.health_alert_cleared')
      .execute();
    expect(audited).toHaveLength(1);
  });

  it('AIG-09: residents saying the help went wrong on more than 10% of the last outputs raises a complaints alert for that feature and language, and it clears when they stop', async () => {
    const feature = 'intake.transcription';
    await outputs(18, { feature, language: 'es', action: null });
    await outputs(3, { feature, language: 'es', action: null, complaint: 'not_my_language' });
    const r = await evaluateAiHealthFor(ctx, tenantId);
    expect(r.raised).toHaveLength(1);
    const raised = (await alerts()).find((a) => a.feature === feature);
    expect(raised).toMatchObject({ language: 'es', kind: 'complaints', counted: 21, flagged: 3 });
    // Ten more without a complaint: 3 of 31 is under the line, and the alert clears.
    await outputs(10, { feature, language: 'es', action: null });
    const later = await evaluateAiHealthFor(ctx, tenantId);
    expect(later.cleared).toContain(raised!.id);
  });
});

/**
 * The locked copy of an issued official report (layer-6 task E; RULE-10,
 * ADR-0010, SEC-13): once the API has frozen a report in its append-only
 * snapshot, this job checks the snapshot still hashes to what was issued and
 * writes it to the records bucket under object lock until the tenant's
 * records retention ends, then records where it went. Issuing never waits
 * on object storage: a failed write is retried with the message, and a
 * second delivery finds the copy already recorded.
 *
 * It also tells the county's webhooks the report was issued (SCL-09): once
 * per issued copy, whatever happens to the lock.
 */
import { sql } from 'kysely';
import { canonicalJson, contentHash } from '@cg/reporting';
import { asSystem, systemAudit } from '../system.ts';
import type { JobContext, TopicHandler } from './types.ts';
import { publishWebhookEvent, sendClaimed } from './webhooks.ts';

export const officialReportIssued: TopicHandler = async (ctx, msg) => {
  const snapshotId = msg.payload['snapshotId'];
  if (typeof snapshotId !== 'string') return;
  await announceIssued(ctx, msg.tenantId, snapshotId).catch((err: unknown) =>
    ctx.log.warn({ err, snapshotId }, 'webhook delivery deferred to the schedule'),
  );
  if (!ctx.objects) {
    ctx.log.warn({ snapshotId }, 'no object storage; the issued report has no locked copy yet');
    return;
  }
  const snap = await asSystem(ctx.db, msg.tenantId, async (trx) => {
    const held = await trx
      .selectFrom('cg.official_report_lock')
      .select('id')
      .where('snapshot_id', '=', snapshotId)
      .executeTakeFirst();
    if (held) return null;
    return trx
      .selectFrom('cg.official_report_snapshot as s')
      .select([
        's.id',
        's.report_id',
        's.content',
        's.record_versions',
        's.content_hash',
        's.issued_at',
        // SEC-13: the tenant's records retention, 7 years unless the county set longer.
        // The worker sees every tenant's policies: name the snapshot's own.
        sql<Date>`s.issued_at + coalesce(
          (select keep_for from cg.retention_policy rp
            where rp.tenant_id = s.tenant_id and rp.data_category = 'records'),
          interval '7 years')`.as('retain_until'),
      ])
      .where('s.id', '=', snapshotId)
      .executeTakeFirst();
  });
  if (!snap) return;
  if (contentHash(snap.content) !== snap.content_hash) {
    // Never lock content that is not what was issued; say so in the audit chain.
    await asSystem(ctx.db, msg.tenantId, (trx) =>
      systemAudit(trx, msg.tenantId, 'official_report.lock', {
        action: 'official_report.lock_refused',
        targetType: 'official_report_snapshot',
        targetId: snap.id,
        reason: 'content does not match its hash',
        executionId: msg.executionId,
      }),
    );
    ctx.log.error({ snapshotId }, 'issued report content does not match its hash; not locked');
    return;
  }
  const key = `tenant/${msg.tenantId}/official-reports/${snap.report_id}/${snap.id}.json`;
  const retainUntil = new Date(snap.retain_until);
  const body = canonicalJson({
    snapshotId: snap.id,
    reportId: snap.report_id,
    issuedAt: new Date(snap.issued_at).toISOString(),
    contentHash: snap.content_hash,
    content: snap.content,
    recordVersions: snap.record_versions,
  });
  const { versionId, mode } = await ctx.objects.putLocked(
    key,
    body,
    'application/json',
    retainUntil,
  );
  await asSystem(ctx.db, msg.tenantId, async (trx) => {
    await trx
      .insertInto('cg.official_report_lock')
      .values({
        tenant_id: msg.tenantId,
        snapshot_id: snap.id,
        object_key: key,
        version_id: versionId,
        lock_mode: mode,
        retain_until: retainUntil,
        content_hash: snap.content_hash,
      })
      .onConflict((oc) => oc.column('snapshot_id').doNothing())
      .execute();
    await systemAudit(trx, msg.tenantId, 'official_report.lock', {
      action: 'official_report.locked',
      targetType: 'official_report_snapshot',
      targetId: snap.id,
      changes: { objectKey: key, lockMode: mode, retainUntil: retainUntil.toISOString() },
      executionId: msg.executionId,
    });
  });
};

/** "Report issued" to the tenant's webhooks: what was issued, never its content or people. */
async function announceIssued(ctx: JobContext, tenantId: string, snapshotId: string) {
  const claimed = await asSystem(ctx.db, tenantId, async (trx) => {
    const r = await trx
      .selectFrom('cg.official_report_snapshot as s')
      .innerJoin('cg.official_report as r', 'r.id', 's.report_id')
      .select([
        'r.id',
        'r.event_id',
        'r.kind',
        'r.sequence',
        'r.title',
        'r.amends',
        's.issued_at',
        's.content_hash',
      ])
      .where('s.id', '=', snapshotId)
      .executeTakeFirst();
    if (!r) return [];
    return publishWebhookEvent(
      ctx,
      tenantId,
      'official_report.issued',
      snapshotId,
      {
        reportId: r.id,
        snapshotId,
        eventId: r.event_id,
        kind: r.kind,
        sequence: r.sequence,
        title: r.title,
        amends: r.amends,
        issuedAt: new Date(r.issued_at).toISOString(),
        contentHash: r.content_hash,
      },
      trx,
    );
  });
  await sendClaimed(ctx, claimed);
}

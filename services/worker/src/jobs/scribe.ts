/**
 * The scribe's unconfirmed conversations (layer-7 task H; FL-04, FL-18,
 * SEC-13). A conversation whose note was never confirmed or discarded expires
 * with the tenant's conversation retention (`command_conversation`, 30 days by
 * default): the encrypted audio is deleted from storage, the transcript and
 * the draft are cleared, the row says it expired, and the deletion is logged
 * and audited. A legal hold on the category or on the conversation keeps it
 * (SEC-13: legal holds override deletion).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import type { JobContext } from './types.ts';

export async function expireScribeSessions(ctx: JobContext): Promise<number> {
  const now = ctx.now?.() ?? new Date();
  let total = 0;
  for (const tenantId of await allTenantIds(ctx.db)) {
    const due = await asSystem(ctx.db, tenantId, async (trx) => {
      const keep = await sql<{ days: string | null }>`
        select (extract(epoch from keep_for) / 86400)::text as days from cg.retention_policy
        where tenant_id = ${tenantId} and data_category = 'command_conversation'
          and keep_for is not null`.execute(trx);
      const days = Number(keep.rows[0]?.days ?? 30);
      if (!Number.isFinite(days) || days <= 0) return [];
      const holds = await trx
        .selectFrom('cg.legal_hold')
        .select('scope')
        .where('tenant_id', '=', tenantId)
        .where('released_at', 'is', null)
        .execute();
      const held = new Set<string>();
      for (const h of holds) {
        const sc = (h.scope ?? {}) as Record<string, unknown>;
        if (sc['dataCategory'] === 'scribe_audio' || sc['dataCategory'] === 'command_conversation')
          return [];
        if (sc['targetType'] === 'scribe_session' && typeof sc['targetId'] === 'string')
          held.add(sc['targetId']);
      }
      const rows = await trx
        .selectFrom('cg.scribe_session')
        .select(['id', 'audio_object_key', 'created_at'])
        .where('state', 'in', ['consented', 'recorded', 'drafted'])
        .where('created_at', '<', new Date(now.getTime() - days * 86_400_000))
        .limit(200)
        .execute();
      return rows.filter((r) => !held.has(r.id));
    });
    if (!due.length) continue;
    const gone: typeof due = [];
    for (const r of due) {
      if (r.audio_object_key) {
        if (!ctx.objects?.delete) {
          ctx.log.warn({ tenantId }, 'scribe expiry: object storage cannot delete; audio kept');
          continue;
        }
        await ctx.objects.delete(r.audio_object_key);
      }
      gone.push(r);
    }
    if (!gone.length) continue;
    await asSystem(ctx.db, tenantId, async (trx) => {
      await trx
        .updateTable('cg.scribe_session')
        .set({
          state: 'expired',
          audio_object_key: null,
          audio_mime: null,
          audio_bytes: null,
          transcript_enc: null,
          draft_enc: null,
        })
        .where(
          'id',
          'in',
          gone.map((r) => r.id),
        )
        .where('state', 'in', ['consented', 'recorded', 'drafted'])
        .execute();
      const times = gone.map((r) => new Date(r.created_at).getTime());
      const executionId = randomUUID();
      await trx
        .insertInto('cg.deletion_log')
        .values({
          tenant_id: tenantId,
          data_category: 'scribe_audio',
          target_type: 'scribe_session',
          deleted_count: gone.length,
          oldest: new Date(Math.min(...times)),
          newest: new Date(Math.max(...times)),
          execution_id: executionId,
        })
        .execute();
      await systemAudit(trx, tenantId, 'retention.sweep', {
        action: 'retention.delete',
        targetType: 'scribe_session',
        targetId: `${gone.length} rows`,
        executionId,
      });
    });
    total += gone.length;
  }
  return total;
}

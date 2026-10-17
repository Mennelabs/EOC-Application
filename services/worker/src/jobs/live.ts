/**
 * Live conditions jobs (CON-14; layer-8 plan §6; ADR-0039, SCL-06, SCL-12):
 * - `live.pull`: read one of the county's feeds (WZDx, the Waze partner
 *   feed, a utility's outages) through the allow-listed HTTP client and store
 *   its items; a feed that is down or unreadable leaves its failure on the
 *   source beside the last good items, and the job never throws for that.
 * - schedule: pull every enabled feed whose last pull is older than its
 *   refresh period, once a minute at most.
 * Development and CI replay recorded synthetic feeds; in live mode only
 * hosts the deployment allows are reached (REFDATA_ALLOWED_HOSTS).
 */
import { diffForAudit } from '@cg/audit';
import { applyLiveItems, pullLiveFeed, type LiveSourceKind } from '@cg/refdata';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import type { JobContext, TopicHandler } from './types.ts';

const internal = () => 'internal' as const;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export interface PullOutcome {
  status: 'ok' | 'failed' | 'skipped';
  count: number;
  error: string | null;
}

/** One pull of one source, recorded on the source and in the audit log. */
export async function pullLiveSource(
  ctx: JobContext,
  tenantId: string,
  sourceId: string,
  requestedBy: string | null = null,
): Promise<PullOutcome> {
  const deps = ctx.refdata;
  const now = ctx.now?.() ?? new Date();
  const source = await asSystem(ctx.db, tenantId, (trx) =>
    trx
      .selectFrom('cg.live_source')
      .selectAll()
      .where('id', '=', sourceId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst(),
  );
  if (!source || source.kind === 'file' || !source.url)
    return { status: 'skipped', count: 0, error: null };
  if (!deps || deps.mode === 'off') {
    ctx.log.info({ sourceId }, 'live pulls are off; nothing pulled');
    return { status: 'skipped', count: 0, error: null };
  }
  let outcome: PullOutcome;
  try {
    const host = new URL(source.url).hostname;
    const parsed = await pullLiveFeed(
      deps.http([host]),
      source.kind as LiveSourceKind,
      source.url,
      now,
    );
    const applied = await asSystem(ctx.db, tenantId, (trx) =>
      applyLiveItems(trx, source, parsed.items, now, requestedBy),
    );
    outcome = { status: 'ok', count: applied.upserted, error: null };
    if (parsed.skipped.length)
      ctx.log.info({ sourceId, skipped: parsed.skipped.length }, 'feed entries left out');
  } catch (e) {
    outcome = { status: 'failed', count: 0, error: message(e) };
    ctx.log.warn({ sourceId, error: outcome.error }, 'live feed pull failed');
  }
  await asSystem(ctx.db, tenantId, async (trx) => {
    await trx
      .updateTable('cg.live_source')
      .set({
        last_pulled_at: now,
        last_status: outcome.status === 'ok' ? 'ok' : 'failed',
        last_error: outcome.error,
        ...(outcome.status === 'ok' ? { last_count: outcome.count } : {}),
      })
      .where('id', '=', source.id)
      .execute();
    await systemAudit(trx, tenantId, 'live.pull', {
      action: 'live.pull',
      targetType: 'live_source',
      targetId: source.id,
      changes: diffForAudit(
        null,
        { kind: source.kind, status: outcome.status, count: outcome.count, error: outcome.error },
        internal,
      ),
    });
  });
  return outcome;
}

export const livePull: TopicHandler = async (ctx, msg) => {
  const sourceId = msg.payload['sourceId'];
  const requestedBy =
    typeof msg.payload['requestedBy'] === 'string' ? msg.payload['requestedBy'] : null;
  if (typeof sourceId !== 'string') return;
  await pullLiveSource(ctx, msg.tenantId, sourceId, requestedBy);
};

/** Every enabled feed whose last pull is older than its refresh period. */
export async function scheduleLivePulls(ctx: JobContext): Promise<void> {
  if (!ctx.refdata || ctx.refdata.mode === 'off') return;
  const now = ctx.now?.() ?? new Date();
  for (const tenantId of await allTenantIds(ctx.db)) {
    const due = await asSystem(ctx.db, tenantId, (trx) =>
      trx
        .selectFrom('cg.live_source')
        .select(['id', 'refresh_ms', 'last_pulled_at'])
        .where('tenant_id', '=', tenantId)
        .where('enabled', '=', true)
        .where('kind', '<>', 'file')
        .execute(),
    );
    for (const s of due) {
      if (s.last_pulled_at && now.getTime() - s.last_pulled_at.getTime() < s.refresh_ms) continue;
      await pullLiveSource(ctx, tenantId, s.id);
    }
  }
}

/**
 * Change relay (layer-4 task F; NFR-07, ADR-0022): new `cg.change_feed`
 * rows are published to the fan-out exchange `cg.changes` as small notices
 * (feed position, tenant and its path) so every API process wakes the
 * streams that follow that tenant or an ancestor of it. The notice carries
 * no record data: the API reads the feed under the caller's row-level
 * security and the client refetches through the authorized routes. The
 * relay runs as the worker role, which sees every tenant's feed, and keeps
 * its position in memory: on restart it starts at the feed head, and the
 * streams' own poll covers the gap (SCL-06).
 */
import type { ConfirmChannel } from 'amqplib';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '@cg/db';
import { publishConfirmed, TOPOLOGY } from '@cg/adapters';

export interface ChangeRelayState {
  /** Last feed seq published; null until the first run reads the head. */
  last: number | null;
}

export async function relayChangesOnce(
  db: Kysely<Database>,
  channel: ConfirmChannel,
  log: Logger,
  state: ChangeRelayState,
  batch = 500,
): Promise<number> {
  if (state.last === null) {
    const head = await db
      .selectFrom('cg.change_feed')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirst();
    state.last = Number(head?.seq ?? 0);
    return 0;
  }
  const rows = await db
    .selectFrom('cg.change_feed as f')
    .innerJoin('cg.tenant as t', 't.id', 'f.tenant_id')
    .select(['f.seq', 'f.tenant_id', 't.path', 'f.record_type'])
    .where('f.seq', '>', state.last)
    .orderBy('f.seq')
    .limit(batch)
    .execute();
  for (const r of rows) {
    const notice = { seq: Number(r.seq), tenantId: r.tenant_id, tenantPath: r.path };
    await publishConfirmed(
      channel,
      TOPOLOGY.changesExchange,
      '',
      Buffer.from(JSON.stringify(notice)),
      { persistent: false, contentType: 'application/json', type: r.record_type },
    );
    state.last = notice.seq;
  }
  if (rows.length) log.debug({ relayed: rows.length, last: state.last }, 'changes relayed');
  return rows.length;
}

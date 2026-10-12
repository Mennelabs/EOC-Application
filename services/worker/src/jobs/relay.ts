/**
 * Outbox relay and queue consumer (ADR-0007).
 *  relayOnce: unpublished outbox rows → queue (publisher confirms) → published_at.
 *  consume:   queue → topic handler → ack; a failing message is retried by the
 *             broker up to its delivery limit, then dead-lettered.
 */
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '@cg/db';
import { TOPOLOGY } from '@cg/adapters';
import { describeMessage, topicHandlers } from './handlers.ts';
import type { JobContext, OutboxMessage } from './types.ts';

const QUEUE = TOPOLOGY.queues[1]; // jobs.default

export async function relayOnce(
  db: Kysely<Database>,
  channel: ConfirmChannel,
  log: Logger,
  batch = 100,
): Promise<number> {
  const rows = await db
    .selectFrom('cg.outbox')
    .select(['id', 'tenant_id', 'topic', 'payload', 'execution_id'])
    .where('published_at', 'is', null)
    .orderBy('id')
    .limit(batch)
    .execute();
  for (const row of rows) {
    const msg: OutboxMessage = {
      id: Number(row.id),
      tenantId: row.tenant_id,
      topic: row.topic,
      payload: (row.payload as Record<string, unknown>) ?? {},
      executionId: row.execution_id,
    };
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        '',
        QUEUE,
        Buffer.from(JSON.stringify(msg)),
        {
          persistent: true,
          contentType: 'application/json',
          messageId: `outbox-${msg.id}`,
          type: msg.topic,
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    await db
      .updateTable('cg.outbox')
      .set({ published_at: new Date(), attempts: Number(0) })
      .where('id', '=', row.id)
      .execute();
  }
  if (rows.length) log.debug({ relayed: rows.length }, 'outbox relayed');
  return rows.length;
}

export async function consume(ctx: JobContext, channel: ConfirmChannel): Promise<void> {
  // One at a time: outbox order is meaningful (a tenant is provisioned before its accounts).
  await channel.prefetch(1);
  await channel.consume(QUEUE, (raw: ConsumeMessage | null) => {
    if (!raw) return;
    void (async () => {
      let msg: OutboxMessage | undefined;
      try {
        msg = JSON.parse(raw.content.toString('utf8')) as OutboxMessage;
        const handler = topicHandlers[msg.topic];
        if (!handler) {
          ctx.log.warn({ topic: msg.topic }, 'no handler for topic; dropping');
          channel.ack(raw);
          return;
        }
        await handler(ctx, msg);
        channel.ack(raw);
      } catch (err) {
        ctx.log.error(
          { err, msg: msg ? describeMessage(msg) : 'unparseable' },
          'job failed; requeue',
        );
        // requeue=true → the broker's x-delivery-limit dead-letters it after 10 tries.
        channel.nack(raw, false, true);
      }
    })();
  });
}

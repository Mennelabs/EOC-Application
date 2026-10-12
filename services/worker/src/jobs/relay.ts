/**
 * Outbox relay and queue consumer (ADR-0007).
 *  relayOnce: unpublished outbox rows → queue (publisher confirms) → published_at.
 *  consume:   queue → topic handler → ack; a failing message is retried by the
 *             broker up to its delivery limit, then dead-lettered.
 */
import type { Channel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '@cg/db';
import { TOPOLOGY } from '@cg/adapters';
import { describeMessage, topicHandlers } from './handlers.ts';
import { fileSubmission } from './intake.ts';
import type { JobContext, OutboxMessage } from './types.ts';

const QUEUE = TOPOLOGY.queues[1]; // jobs.default
const INTAKE_QUEUE = TOPOLOGY.queues[0]; // intake.submissions

/** What the API publishes for a submission (public/routes.ts IntakeQueueMessage). */
interface IntakeQueueMessage {
  v: number;
  tenantId: string;
  executionId: string;
  referenceCode: string;
  eventId: string | null;
  channel: 'web' | 'assisted' | 'sms' | 'voice';
  payloadEnc: string;
}

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

/**
 * Intake consumer (SCL-03/06): several submissions in flight on their own
 * channel; filing is idempotent, so a redelivery or the stored-row sweep
 * finding the same execution id is harmless. A message that keeps failing is
 * dead-lettered by the broker after ten tries; the database row remains and
 * the sweep files it from there.
 */
export async function consumeIntake(
  ctx: JobContext,
  channel: Channel,
  prefetch = 8,
): Promise<void> {
  await channel.prefetch(prefetch);
  await channel.consume(INTAKE_QUEUE, (raw: ConsumeMessage | null) => {
    if (!raw) return;
    void (async () => {
      let executionId: string | undefined;
      try {
        const msg = JSON.parse(raw.content.toString('utf8')) as IntakeQueueMessage;
        executionId = msg.executionId;
        if (msg.v !== 1) {
          ctx.log.warn(
            { v: msg.v, executionId },
            'unknown intake message version; the sweep files it',
          );
          channel.ack(raw);
          return;
        }
        await fileSubmission(ctx, {
          tenantId: msg.tenantId,
          executionId: msg.executionId,
          referenceCode: msg.referenceCode,
          eventId: msg.eventId,
          channel: msg.channel,
          payloadEnc: Buffer.from(msg.payloadEnc, 'base64'),
          path: 'queue',
        });
        channel.ack(raw);
      } catch (err) {
        ctx.log.error({ err, executionId }, 'filing a queued submission failed; requeue');
        channel.nack(raw, false, true);
      }
    })();
  });
}

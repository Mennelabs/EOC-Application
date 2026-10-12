/**
 * Queue adapter (ADR-0007). Scaffold level: connection management, topology
 * and a health probe. Publishing with confirms and idempotent consumers are
 * built in layer 1/2.
 */
import amqp from 'amqplib';
import type { Probe } from './health.ts';

/** Queues that must exist before intake is opened (SCL-03, rule 8). */
export const TOPOLOGY = {
  deadLetterExchange: 'cg.dead-letter',
  queues: ['intake.submissions', 'jobs.default'] as const,
};

export interface QueueConnection {
  connection: amqp.ChannelModel;
  channel: amqp.ConfirmChannel;
  close(): Promise<void>;
}

export async function connectQueue(url: string): Promise<QueueConnection> {
  const connection = await amqp.connect(url);
  const channel = await connection.createConfirmChannel();
  return {
    connection,
    channel,
    async close() {
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    },
  };
}

export async function assertTopology(channel: amqp.Channel): Promise<void> {
  await channel.assertExchange(TOPOLOGY.deadLetterExchange, 'fanout', { durable: true });
  await channel.assertQueue(`${TOPOLOGY.deadLetterExchange}.queue`, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(`${TOPOLOGY.deadLetterExchange}.queue`, TOPOLOGY.deadLetterExchange, '');
  for (const name of TOPOLOGY.queues) {
    await channel.assertQueue(name, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-dead-letter-exchange': TOPOLOGY.deadLetterExchange,
        'x-delivery-limit': 10,
      },
    });
  }
}

/** Healthy while the long-lived connection is open and the broker answers. */
export function queueProbe(name: string, getConn: () => QueueConnection | undefined): Probe {
  return {
    name,
    async check() {
      const conn = getConn();
      if (!conn) throw new Error('not connected');
      await conn.channel.checkQueue(TOPOLOGY.queues[0]);
    },
  };
}

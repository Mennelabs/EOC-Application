/**
 * settle (SCL-06): acking on a channel the broker closed under a job in flight must not
 * throw out of the consumer; that ended the worker process in CI (relay.ts nack after a
 * CONNECTION_FORCED shutdown). The broker redelivers what was not acknowledged.
 */
import type { ConsumeMessage } from 'amqplib';
import { describe, expect, it } from 'vitest';
import { settle } from '../src/jobs/relay.ts';

describe('settle (SCL-06)', () => {
  it('acks and requeues on a live channel', () => {
    const calls: string[] = [];
    const ch = { ack: () => void calls.push('ack'), nack: () => void calls.push('nack') };
    const log = { warn: () => undefined } as never;
    settle(ch, {} as ConsumeMessage, 'ack', log);
    settle(ch, {} as ConsumeMessage, 'requeue', log);
    expect(calls).toEqual(['ack', 'nack']);
  });

  it('logs instead of throwing when the channel is already closed', () => {
    const closed = () => {
      throw new Error('Channel closed');
    };
    const warned: unknown[] = [];
    const log = { warn: (o: unknown) => void warned.push(o) } as never;
    expect(() =>
      settle({ ack: closed, nack: closed }, {} as ConsumeMessage, 'requeue', log),
    ).not.toThrow();
    expect(() =>
      settle({ ack: closed, nack: closed }, {} as ConsumeMessage, 'ack', log),
    ).not.toThrow();
    expect(warned).toHaveLength(2);
  });
});

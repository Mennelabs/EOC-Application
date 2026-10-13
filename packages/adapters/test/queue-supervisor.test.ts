/**
 * The queue supervisor (SCL-06, ADR-0007): a dead channel, a closed
 * connection or a failed liveness check rebuilds the connection and its
 * consumers once; while the broker is away it retries with backoff. Fakes
 * stand in for amqplib so the cases run without a broker.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { superviseQueue, type QueueConnection, type QueueSupervisor } from '../src/queue.ts';

class FakeChannel extends EventEmitter {
  dead = false;
  async checkQueue() {
    if (this.dead) throw new Error('Channel closed');
    return {};
  }
}
function fakeConnection(): QueueConnection & { extra: FakeChannel; closed: boolean } {
  const connection = new EventEmitter();
  const channel = new FakeChannel();
  const extra = new FakeChannel();
  const q = {
    connection,
    channel,
    extra,
    closed: false,
    async close() {
      q.closed = true;
      connection.emit('close');
    },
  };
  return q as unknown as QueueConnection & { extra: FakeChannel; closed: boolean };
}
const quiet = { info: () => undefined, warn: () => undefined };
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let sup: QueueSupervisor | undefined;
afterEach(async () => {
  await sup?.stop();
  sup = undefined;
});

describe('superviseQueue (SCL-06)', () => {
  it('a channel that dies while its connection stays open is rebuilt with its consumers', async () => {
    const made: ReturnType<typeof fakeConnection>[] = [];
    let ready = 0;
    sup = superviseQueue({
      connect: async () => {
        const q = fakeConnection();
        made.push(q);
        return q;
      },
      onReady: async (q) => {
        ready++;
        return [(q as ReturnType<typeof fakeConnection>).extra];
      },
      log: quiet,
      checkEveryMs: 20,
    });
    await until(() => sup!.current() !== undefined);
    expect(ready).toBe(1);
    // The intake channel closes on its own (no connection close): reconnect, consumers again.
    made[0]!.extra.emit('close');
    expect(sup.current()).toBeUndefined();
    await until(() => ready === 2 && sup!.current() !== undefined);
    expect(made[0]!.closed).toBe(true);
    expect(sup.current()).toBe(made[1]);
  });

  it('a connection close and a failed liveness check each reconnect once', async () => {
    const made: ReturnType<typeof fakeConnection>[] = [];
    sup = superviseQueue({
      connect: async () => {
        const q = fakeConnection();
        made.push(q);
        return q;
      },
      onReady: async () => [],
      log: quiet,
      checkEveryMs: 20,
    });
    await until(() => made.length === 1 && sup!.current() !== undefined);
    // The broker went away: close and error both fire; one new connection follows.
    made[0]!.connection.emit('error', new Error('CONNECTION_FORCED'));
    made[0]!.connection.emit('close');
    await until(() => made.length === 2 && sup!.current() === made[1]);
    await new Promise((r) => setTimeout(r, 100));
    expect(made.length).toBe(2);
    // A channel dead without any event: the periodic check notices it.
    (made[1]!.channel as unknown as FakeChannel).dead = true;
    await until(() => made.length === 3 && sup!.current() === made[2], 3000);
    expect(made.length).toBe(3);
  });

  it('a connect that never answers (a broker still starting) times out and is retried', async () => {
    let tries = 0;
    let lateClosed = false;
    sup = superviseQueue({
      connect: () => {
        tries++;
        if (tries === 1)
          // Hangs past the deadline, then arrives late: it must be closed, never used.
          return new Promise((resolve) =>
            setTimeout(() => {
              const q = fakeConnection();
              const close = q.close.bind(q);
              q.close = async () => {
                lateClosed = true;
                await close();
              };
              resolve(q);
            }, 200),
          );
        return Promise.resolve(fakeConnection());
      },
      onReady: async () => [],
      log: quiet,
      checkEveryMs: 1000,
      connectTimeoutMs: 50,
      maxBackoffMs: 20,
    });
    await until(() => sup!.current() !== undefined, 3000);
    expect(tries).toBe(2);
    await until(() => lateClosed, 3000);
  });

  it('retries with backoff while the broker is down, then connects', async () => {
    let tries = 0;
    sup = superviseQueue({
      connect: async () => {
        tries++;
        if (tries < 3) throw new Error('connect ECONNREFUSED');
        return fakeConnection();
      },
      onReady: async () => [],
      log: quiet,
      checkEveryMs: 1000,
      maxBackoffMs: 50,
    });
    await until(() => sup!.current() !== undefined, 3000);
    expect(tries).toBe(3);
  });
});

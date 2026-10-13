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
  /** Fan-out of change notices to every API process for the live stream (ADR-0022). */
  changesExchange: 'cg.changes',
  queues: ['intake.submissions', 'jobs.default'] as const,
};

export interface QueueConnection {
  connection: amqp.ChannelModel;
  channel: amqp.ConfirmChannel;
  close(): Promise<void>;
}

/** Seconds between AMQP heartbeats: a broker that vanishes without closing is noticed (SCL-06). */
export const QUEUE_HEARTBEAT_S = 10;

export async function connectQueue(url: string): Promise<QueueConnection> {
  const withHeartbeat = /[?&]heartbeat=/.test(url)
    ? url
    : `${url}${url.includes('?') ? '&' : '?'}heartbeat=${QUEUE_HEARTBEAT_S}`;
  // A socket that never answers fails instead of waiting forever (the supervisor also bounds it).
  const connection = await amqp.connect(withHeartbeat, { timeout: 10_000 });
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
  await channel.assertExchange(TOPOLOGY.changesExchange, 'fanout', { durable: true });
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

/** What the supervisor needs from a connection and its channels: events, and a way to close. */
interface Watchable {
  on(event: 'close' | 'error', listener: (err?: unknown) => void): unknown;
}

export interface QueueSupervisorOptions {
  connect: () => Promise<QueueConnection>;
  /** Sets the connection up (topology, consumers); returns any extra channels to watch. */
  onReady: (q: QueueConnection) => Promise<Watchable[]>;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
  /** A cheap round trip that fails on a dead channel; default checks the jobs queue. */
  check?: (q: QueueConnection) => Promise<unknown>;
  checkEveryMs?: number;
  checkTimeoutMs?: number;
  /** A connect or set-up that has not finished by then counts as failed and is retried. */
  connectTimeoutMs?: number;
  maxBackoffMs?: number;
}

export interface QueueSupervisor {
  /** The live connection, or undefined while it is being re-established. */
  current(): QueueConnection | undefined;
  stop(): Promise<void>;
}

/**
 * Keeps one queue connection alive for a long-running process (SCL-06, ADR-0007).
 * Any close or error on the connection or on any channel it set up, or a failed
 * liveness check, tears the whole connection down once and rebuilds it with its
 * consumers, with backoff while the broker is away. A channel that dies while its
 * connection stays open (a channel-level error, a broker restart seen only by one
 * channel) is caught the same way, so the process never keeps a dead consumer.
 */
export function superviseQueue(opts: QueueSupervisorOptions): QueueSupervisor {
  const checkEveryMs = opts.checkEveryMs ?? 10_000;
  const checkTimeoutMs = opts.checkTimeoutMs ?? 5_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 20_000;
  const check = opts.check ?? ((q) => q.channel.checkQueue(TOPOLOGY.queues[0]));
  let live: QueueConnection | undefined;
  let generation = 0;
  let attempt = 0;
  let connecting = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delay: number) => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void start();
    }, delay);
  };

  const drop = (gen: number, reason: string, err?: unknown) => {
    if (gen !== generation || stopped) return;
    generation++;
    const old = live;
    live = undefined;
    opts.log.warn({ err, reason }, 'queue connection lost; reconnecting');
    void old?.close();
    schedule(500);
  };

  async function start(): Promise<void> {
    if (stopped || connecting || live) return;
    connecting = true;
    const gen = ++generation;
    let q: QueueConnection | undefined;
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // A broker that is down or still starting can leave a connect or its set-up hanging;
      // past the deadline the attempt counts as failed, and a late connection is closed.
      const trying = (async () => {
        const c = await opts.connect();
        q = c;
        if (timedOut) throw new Error('late connection');
        const watch = (w: Watchable, what: string) => {
          w.on('close', (err) => drop(gen, `${what} closed`, err));
          w.on('error', (err) => drop(gen, `${what} error`, err));
        };
        watch(c.connection as unknown as Watchable, 'connection');
        watch(c.channel as unknown as Watchable, 'channel');
        for (const [i, ch] of (await opts.onReady(c)).entries()) watch(ch, `channel ${i + 2}`);
        if (timedOut) throw new Error('late connection');
        return c;
      })();
      trying.catch(() => {
        if (timedOut) void q?.close().catch(() => undefined);
      });
      q = await Promise.race([
        trying,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            timedOut = true;
            reject(new Error(`queue connect timed out after ${connectTimeoutMs} ms`));
          }, connectTimeoutMs);
        }),
      ]);
      clearTimeout(deadline);
      if (gen !== generation || stopped) {
        await q.close();
        return;
      }
      live = q;
      attempt = 0;
      opts.log.info({}, 'queue connected; consuming jobs and submissions');
    } catch (err) {
      clearTimeout(deadline);
      if (gen === generation) generation++;
      await q?.close().catch(() => undefined);
      const delay = Math.min(maxBackoffMs, 500 * 2 ** attempt++);
      opts.log.warn({ err, delay }, 'queue unavailable, retrying');
      schedule(delay);
    } finally {
      connecting = false;
    }
  }

  const timer = setInterval(() => {
    const q = live;
    if (!q) {
      if (!connecting) schedule(0);
      return;
    }
    const gen = generation;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      check(q),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('queue check timed out')), checkTimeoutMs);
      }),
    ])
      .catch((err: unknown) => drop(gen, 'liveness check failed', err))
      .finally(() => clearTimeout(timeout));
  }, checkEveryMs);
  timer.unref?.();

  void start();
  return {
    current: () => live,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (retry) clearTimeout(retry);
      const q = live;
      live = undefined;
      await q?.close();
    },
  };
}

/**
 * Publishes and waits for the broker's confirm, with a deadline (SCL-06). A channel that
 * closes under the publish, or a confirm that never comes, becomes an error the caller's
 * loop retries after the supervisor reconnects, instead of a wait that never ends.
 */
export function publishConfirmed(
  channel: Pick<amqp.ConfirmChannel, 'publish'>,
  exchange: string,
  routingKey: string,
  body: Buffer,
  options: amqp.Options.Publish,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no publish confirm within ${timeoutMs} ms`)),
      timeoutMs,
    );
    try {
      channel.publish(exchange, routingKey, body, options, (err) => {
        clearTimeout(timer);
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

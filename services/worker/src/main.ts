/**
 * Worker: queue consumers and scheduled jobs (architecture §2.1). The scaffold
 * keeps a broker connection, declares the topology and reports health.
 * Consumers arrive with their layer: intake persistence (layer 2), outbox
 * relay, retention deletion and audit-chain verification (layer 1).
 */
import { createServer } from 'node:http';
import pino from 'pino';
import { loadConfig, platformSchema } from '@cg/config';
import {
  assertTopology,
  connectQueue,
  createPool,
  postgresProbe,
  queueProbe,
  runProbes,
  type QueueConnection,
} from '@cg/adapters';

const config = loadConfig(platformSchema);
const log = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });
const pool = createPool(config.DATABASE_URL, 5);
let queue: QueueConnection | undefined;

const probes = [postgresProbe('db', pool), queueProbe('queue', () => queue)];

async function keepQueueConnected(attempt = 0): Promise<void> {
  try {
    queue = await connectQueue(config.AMQP_URL);
    await assertTopology(queue.channel);
    queue.connection.on('close', () => {
      queue = undefined;
      void keepQueueConnected();
    });
    log.info('queue connected');
  } catch {
    queue = undefined;
    const delay = Math.min(30_000, 500 * 2 ** attempt);
    log.warn({ delay }, 'queue unavailable, retrying');
    setTimeout(() => void keepQueueConnected(attempt + 1), delay);
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health/live') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (req.url === '/health/ready') {
    void runProbes(probes).then((checks) => {
      const ok = checks.every((c) => c.ok);
      res
        .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: ok ? 'ready' : 'degraded', checks }));
    });
    return;
  }
  res.writeHead(404).end();
});

void keepQueueConnected();
server.listen(config.PORT, '0.0.0.0', () => log.info({ port: config.PORT }, 'worker listening'));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    server.close();
    await queue?.close();
    await pool.end();
    process.exit(0);
  });
}

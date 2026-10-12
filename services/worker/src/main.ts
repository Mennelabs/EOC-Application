/**
 * Worker: outbox relay, queue consumer and scheduled system jobs
 * (architecture §2.1, ADR-0007). Runs as the cg_worker database role.
 */
import { createServer } from 'node:http';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import pino from 'pino';
import { loadConfig, workerSchema } from '@cg/config';
import {
  assertTopology,
  connectQueue,
  createPool,
  createS3,
  postgresProbe,
  queueProbe,
  runProbes,
  type QueueConnection,
} from '@cg/adapters';
import { createDb } from '@cg/db';
import { KeycloakAdmin } from './idp/keycloak.ts';
import { anchorAuditChains, expireBreakGlass, retentionSweep } from './jobs/handlers.ts';
import { consume, relayOnce } from './jobs/relay.ts';
import type { JobContext, Schedule } from './jobs/types.ts';
import { nullMailer, smtpMailer } from './mail.ts';

const config = loadConfig(workerSchema);
const log = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });
const pool = createPool(config.DATABASE_URL, 5);
const db = createDb(config.DATABASE_URL, 5);
let queue: QueueConnection | undefined;

const s3 = createS3({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  bucket: config.S3_BUCKET,
});

const ctx: JobContext = {
  db,
  log,
  idp: new KeycloakAdmin({
    adminBase: config.IDP_INTERNAL_BASE,
    adminUser: config.KC_ADMIN_USER,
    adminPassword: config.KC_ADMIN_PASSWORD,
  }),
  mail: config.SMTP_URL ? smtpMailer(config.SMTP_URL, config.MAIL_FROM) : nullMailer,
  urls: {
    gatewayPublic: config.GATEWAY_PUBLIC_URL,
    idpPublic: config.IDP_PUBLIC_BASE,
    idpInternal: config.IDP_INTERNAL_BASE,
  },
  objects: {
    async putAnchor(key, body) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: 'application/json',
        }),
      );
    },
  },
  devDirectGrant: config.IDP_DEV_DIRECT_GRANT,
};

const schedules: Schedule[] = [
  { name: 'break-glass-expiry', everyMs: 60_000, run: expireBreakGlass },
  { name: 'audit-anchor', everyMs: 15 * 60_000, run: anchorAuditChains },
  { name: 'retention-sweep', everyMs: 24 * 3600_000, run: retentionSweep },
];

const probes = [postgresProbe('db', pool), queueProbe('queue', () => queue)];

async function keepQueueConnected(attempt = 0): Promise<void> {
  try {
    queue = await connectQueue(config.AMQP_URL);
    await assertTopology(queue.channel);
    queue.connection.on('close', () => {
      queue = undefined;
      void keepQueueConnected();
    });
    await consume(ctx, queue.channel);
    log.info('queue connected; consuming jobs');
  } catch (err) {
    queue = undefined;
    const delay = Math.min(30_000, 500 * 2 ** attempt);
    log.warn({ err, delay }, 'queue unavailable, retrying');
    setTimeout(() => void keepQueueConnected(attempt + 1), delay);
  }
}

async function relayLoop(): Promise<void> {
  for (;;) {
    try {
      if (queue) {
        const n = await relayOnce(db, queue.channel, log);
        if (n > 0) continue; // drain quickly under load
      }
    } catch (err) {
      log.warn({ err }, 'relay failed');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function startSchedules(): void {
  for (const s of schedules) {
    const tick = async () => {
      try {
        await s.run(ctx);
      } catch (err) {
        log.error({ err, schedule: s.name }, 'schedule failed');
      }
    };
    setTimeout(() => void tick(), 5_000);
    setInterval(() => void tick(), s.everyMs);
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
void relayLoop();
startSchedules();
server.listen(config.PORT, '0.0.0.0', () => log.info({ port: config.PORT }, 'worker listening'));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    server.close();
    await queue?.close();
    await db.destroy();
    await pool.end();
    process.exit(0);
  });
}

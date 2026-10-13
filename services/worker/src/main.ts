/**
 * Worker: outbox relay, queue consumer and scheduled system jobs
 * (architecture §2.1, ADR-0007). Runs as the cg_worker database role.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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
  SimulatorSms,
  superviseQueue,
  TwilioSms,
  type QueueSupervisor,
} from '@cg/adapters';
import { fakeProvider, providerByName } from '@cg/ai';
import { FieldCrypto, OpenBaoKeyService, dbKeyStore } from '@cg/crypto';
import { westwindGraph } from '@cg/intake';
import { createDb } from '@cg/db';
import { KeycloakAdmin } from './idp/keycloak.ts';
import { anchorAuditChains, expireBreakGlass, retentionSweep } from './jobs/handlers.ts';
import { mergeLateAnswers, sweepStoredSubmissions, topUpReferenceCodes } from './jobs/intake.ts';
import {
  noticePublications,
  remindContactVerification,
  remindSiteConfirmations,
  reviewResources,
} from './jobs/reminders.ts';
import { relayChangesOnce, type ChangeRelayState } from './jobs/changes.ts';
import { dropPositionTrails, watchFieldSafety, watchReminders } from './jobs/field.ts';
import { consume, consumeIntake, relayOnce } from './jobs/relay.ts';
import type { JobContext, Schedule } from './jobs/types.ts';
import { nullMailer, smtpMailer } from './mail.ts';

const config = loadConfig(workerSchema);
const log = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });
const pool = createPool(config.DATABASE_URL, 5);
const db = createDb(config.DATABASE_URL, 5);
// Key-service token is injected as a file by the keys-init container (ADR-0009).
const keyToken = readFileSync(config.OPENBAO_TOKEN_FILE, 'utf8').trim();
const fieldCrypto = new FieldCrypto(
  new OpenBaoKeyService(config.OPENBAO_ADDR, keyToken),
  // Key records come through their own small pool: an encrypt inside a request or job
  // transaction must never wait for a connection that those transactions hold (SEC-10).
  dbKeyStore(createDb(config.DATABASE_URL, 2)),
);

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
  // docs/06, SCL-11: the real provider is configuration; without it the simulator stands in.
  sms:
    config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN
      ? new TwilioSms({
          accountSid: config.TWILIO_ACCOUNT_SID,
          authToken: config.TWILIO_AUTH_TOKEN,
          statusCallback: `${config.WEBHOOK_PUBLIC_BASE ?? config.GATEWAY_PUBLIC_URL}/api/webhooks/twilio/status`,
        })
      : new SimulatorSms(),
  crypto: fieldCrypto,
  urls: {
    gatewayPublic: config.GATEWAY_PUBLIC_URL,
    idpPublic: config.IDP_PUBLIC_BASE,
    idpInternal: config.IDP_INTERNAL_BASE,
  },
  objects: {
    async get(key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) throw new Error(`object ${key} has no body`);
      return { body: Buffer.from(bytes), contentType: res.ContentType ?? null };
    },
    async put(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
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
  ai: {
    // AIG-12: the provider is tenant configuration; only registered, compliant providers exist here.
    async providerFor(_tenantId, trx) {
      const row = await trx
        .selectFrom('cg.tenant_config')
        .select('value')
        .where('key', '=', 'ai.provider')
        .executeTakeFirst();
      const name = typeof row?.value === 'string' ? row.value : 'fake';
      return providerByName(name) ?? fakeProvider;
    },
  },
  defaultGraph: westwindGraph,
  devDirectGrant: config.IDP_DEV_DIRECT_GRANT,
};

const schedules: Schedule[] = [
  { name: 'break-glass-expiry', everyMs: 60_000, run: expireBreakGlass },
  { name: 'audit-anchor', everyMs: 15 * 60_000, run: anchorAuditChains },
  { name: 'retention-sweep', everyMs: 24 * 3600_000, run: retentionSweep },
  // SCL-06: submissions stored while the queue was down, or whose message was lost, are filed from the row.
  {
    name: 'intake-stored-sweep',
    everyMs: 10_000,
    run: (c) =>
      sweepStoredSubmissions(c)
        .then(() => mergeLateAnswers(c))
        .then(() => undefined),
  },
  { name: 'reference-code-pool', everyMs: 60_000, run: (c) => topUpReferenceCodes(c) },
  // F09, REM-01: reminders and notices on the worker's clock (jobs/reminders.ts); each is sent once per cycle.
  { name: 'site-reconfirm', everyMs: 5 * 60_000, run: remindSiteConfirmations }, // PUB-03
  { name: 'resource-review', everyMs: 60 * 60_000, run: reviewResources }, // BRD:FR-16.03, AC-16B
  { name: 'contact-reverify', everyMs: 60 * 60_000, run: remindContactVerification }, // CNT-01
  { name: 'publication-notices', everyMs: 30_000, run: noticePublications }, // PUB-06
  // DSP-04, DSP-07, FLD-16: check-in timers, acknowledgement windows, escalation; DSP-08 trails.
  { name: 'field-safety', everyMs: 60_000, run: watchFieldSafety },
  { name: 'reminders-f09', everyMs: 60_000, run: watchReminders }, // F09, FR-09.05/09.06
  { name: 'position-trails', everyMs: 24 * 3600_000, run: dropPositionTrails },
];

const probes = [postgresProbe('db', pool), queueProbe('queue', queueNow)];

// SCL-06: one supervised connection; a dead channel, a closed connection or a failed check
// rebuilds it with both consumers (packages/adapters/src/queue.ts superviseQueue).
let supervisor: QueueSupervisor | undefined;
function keepQueueConnected(): void {
  supervisor = superviseQueue({
    connect: () => connectQueue(config.AMQP_URL),
    onReady: async (q) => {
      await assertTopology(q.channel);
      await consume(ctx, q.channel);
      const intake = await q.connection.createChannel();
      await consumeIntake(ctx, intake);
      return [intake];
    },
    log,
  });
}
function queueNow() {
  return supervisor?.current();
}

async function relayLoop(): Promise<void> {
  for (;;) {
    try {
      const queue = queueNow();
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

/** ADR-0022: feed rows become notices on the fan-out exchange within about half a second. */
const changeRelay: ChangeRelayState = { last: null };
async function changeLoop(): Promise<void> {
  for (;;) {
    try {
      const queue = queueNow();
      if (queue) {
        const n = await relayChangesOnce(db, queue.channel, log, changeRelay);
        if (n > 0) continue;
      }
    } catch (err) {
      log.warn({ err }, 'change relay failed');
    }
    await new Promise((r) => setTimeout(r, 500));
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

keepQueueConnected();
void relayLoop();
void changeLoop();
startSchedules();
server.listen(config.PORT, '0.0.0.0', () => log.info({ port: config.PORT }, 'worker listening'));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    server.close();
    await supervisor?.stop();
    await db.destroy();
    await pool.end();
    process.exit(0);
  });
}

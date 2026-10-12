import { readFileSync } from 'node:fs';
import { loadConfig, platformSchema } from '@cg/config';
import {
  assertTopology,
  connectQueue,
  createPool,
  createS3,
  ensureBucket,
  httpProbe,
  openBaoProbe,
  postgresProbe,
  queueProbe,
  smtpProbe,
  storageProbe,
  type QueueConnection,
} from '@cg/adapters';
import { createDb } from '@cg/db';
import { FieldCrypto, OpenBaoKeyService, dbKeyStore } from '@cg/crypto';
import { buildApp } from './app.ts';
import { createSubjectLoader } from './auth/subject.ts';
import { routes } from './routes/index.ts';
import { fakeProvider, providerByName } from '@cg/ai';
import { westwindGraph } from '@cg/intake';
import { dataUrlFetcher, twilioMediaFetcher } from './channels/media.ts';
import { webhookRoutes } from './channels/routes.ts';
import { ChannelSessions } from './channels/session.ts';
import { RiskScorer } from './public/abuse.ts';
import { ReferenceCodeLeaser } from './public/reference-codes.ts';
import { submitIntake } from './public/submit.ts';
import { publicRoutes } from './public/routes.ts';
import { TenantResolver } from './public/tenant-resolver.ts';

const config = loadConfig(platformSchema);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const pool = createPool(config.DATABASE_URL);
const db = createDb(config.DATABASE_URL);
// Key-service token is injected as a file by the keys-init container (ADR-0009).
const keyToken = readFileSync(config.OPENBAO_TOKEN_FILE, 'utf8').trim();
const fieldCrypto = new FieldCrypto(
  new OpenBaoKeyService(config.OPENBAO_ADDR, keyToken),
  dbKeyStore(db),
);
const s3 = createS3({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  bucket: config.S3_BUCKET,
});
let queue: QueueConnection | undefined;

// One submission path for every channel (CHN-01): the web route and the text and voice sessions share it.
const resolver = new TenantResolver(db);
const codes = new ReferenceCodeLeaser(db, `${process.env['HOSTNAME'] ?? 'api'}:${process.pid}`);
const risk = new RiskScorer();
// Browsers upload to the public object host (SCL-04); the API itself talks to storage internally.
const presignClient = config.S3_PUBLIC_ENDPOINT
  ? createS3({
      endpoint: config.S3_PUBLIC_ENDPOINT,
      region: config.S3_REGION,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      bucket: config.S3_BUCKET,
    })
  : undefined;
const objects = {
  client: s3,
  ...(presignClient ? { presignClient } : {}),
  bucket: config.S3_BUCKET,
  maxBytes: config.PUBLIC_UPLOAD_MAX_BYTES,
};
const twilio =
  config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN
    ? { accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN }
    : undefined;
const submitDeps = {
  codes,
  risk,
  getQueue: () => queue,
  defaultGraph: westwindGraph,
  crypto: fieldCrypto,
  now: () => new Date(),
};
// AIG-12: the provider is tenant configuration; only registered, compliant providers exist here.
const ai = {
  async providerFor(
    _tenantId: string,
    trx: import('kysely').Transaction<import('@cg/db').Database>,
  ) {
    const row = await trx
      .selectFrom('cg.tenant_config')
      .select('value')
      .where('key', '=', 'ai.provider')
      .executeTakeFirst();
    const name = typeof row?.value === 'string' ? row.value : 'fake';
    return providerByName(name) ?? fakeProvider;
  },
};
const sessions = new ChannelSessions({
  crypto: fieldCrypto,
  defaultGraph: westwindGraph,
  submit: (req, input) => submitIntake(submitDeps, req, input),
  objects,
  media: twilio
    ? twilioMediaFetcher(twilio.accountSid, twilio.authToken, config.PUBLIC_UPLOAD_MAX_BYTES)
    : dataUrlFetcher(),
  publicBase: config.WEBHOOK_PUBLIC_BASE ?? config.IDP_PUBLIC_BASE.replace(/\/auth$/, ''),
});

const app = await buildApp({
  productName: config.PRODUCT_NAME,
  version: pkg.version,
  dataMode: config.DATA_CLASSIFICATION_MODE,
  logLevel: config.LOG_LEVEL,
  db,
  fieldCrypto,
  subjects: createSubjectLoader(db, {
    internalBase: config.IDP_INTERNAL_BASE,
    publicBase: config.IDP_PUBLIC_BASE,
  }),
  routes,
  publicRoutes: [
    publicRoutes({
      resolver,
      codes,
      risk,
      getQueue: () => queue,
      objects,
      residentTokenSecret: config.RESIDENT_TOKEN_SECRET,
      defaultGraph: westwindGraph,
      ai,
    }),
  ],
  reportDeps: { objects, ai, submit: (req, input) => submitIntake(submitDeps, req, input) },
  webhookRoutes: [
    webhookRoutes({
      resolver,
      sessions,
      twilio: twilio ? { authToken: twilio.authToken } : undefined,
      publicBase: config.WEBHOOK_PUBLIC_BASE,
      simulator: config.DATA_CLASSIFICATION_MODE === 'synthetic',
    }),
  ],
  probes: [
    postgresProbe('db', pool),
    queueProbe('queue', () => queue),
    storageProbe('objects', s3, config.S3_BUCKET),
    openBaoProbe('keys', config.OPENBAO_ADDR),
    httpProbe('idp', config.IDP_HEALTH_URL),
    smtpProbe('mail', config.SMTP_URL),
  ],
});

/** Keep a broker connection, reconnecting with backoff; readiness reflects it. */
async function keepQueueConnected(attempt = 0): Promise<void> {
  try {
    queue = await connectQueue(config.AMQP_URL);
    await assertTopology(queue.channel);
    queue.connection.on('close', () => {
      queue = undefined;
      void keepQueueConnected();
    });
    app.log.info('queue connected');
  } catch {
    queue = undefined;
    const delay = Math.min(30_000, 500 * 2 ** attempt);
    app.log.warn({ delay }, 'queue unavailable, retrying');
    setTimeout(() => void keepQueueConnected(attempt + 1), delay);
  }
}

async function ensureBucketWithRetry(attempt = 0): Promise<void> {
  try {
    await ensureBucket(s3, config.S3_BUCKET);
  } catch {
    setTimeout(() => void ensureBucketWithRetry(attempt + 1), Math.min(30_000, 500 * 2 ** attempt));
  }
}

void keepQueueConnected();
void ensureBucketWithRetry();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    await app.close();
    await queue?.close();
    await db.destroy();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: config.PORT });

import { readFileSync } from 'node:fs';
import { aiEnv, loadConfig, platformSchema } from '@cg/config';
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
import { routesWith } from './routes/index.ts';
import { DEFAULT_PROVIDER, openAIFromEnv, providerByName, registerProvider } from '@cg/ai';
import { westwindGraph } from '@cg/intake';
import { dataUrlFetcher, twilioMediaFetcher } from './channels/media.ts';
import { webhookRoutes } from './channels/routes.ts';
import { ChannelSessions } from './channels/session.ts';
import { DEFAULT_LIMITS, RiskScorer } from './public/abuse.ts';
import { ReferenceCodeLeaser } from './public/reference-codes.ts';
import { submitIntake } from './public/submit.ts';
import { publicRoutes } from './public/routes.ts';
import { TenantResolver } from './public/tenant-resolver.ts';
import { gisRoutes } from './routes/gis.ts';

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
let queue: QueueConnection | undefined;

// One submission path for every channel (CHN-01): the web route and the text and voice sessions share it.
const resolver = new TenantResolver(db);
const codes = new ReferenceCodeLeaser(db, `${process.env['HOSTNAME'] ?? 'api'}:${process.pid}`);
const risk = new RiskScorer({
  ...DEFAULT_LIMITS,
  ipVerify: config.PUBLIC_IP_VERIFY_PER_10MIN,
  ipDeny: config.PUBLIC_IP_DENY_PER_10MIN,
});
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
// ADR-0043: OpenAI for every AI function when the key is configured; no fake provider in a
// running system. AIG-12: the provider is tenant configuration (`ai.provider`, OpenAI by
// default); a tenant whose provider is not registered here has its AI features off.
const openai = openAIFromEnv(aiEnv(config));
if (openai) registerProvider(openai);
const ai = {
  async providerFor(
    tenantId: string,
    trx: import('kysely').Transaction<import('@cg/db').Database>,
  ) {
    const row = await trx
      .selectFrom('cg.tenant_config')
      .select('value')
      .where('tenant_id', '=', tenantId)
      .where('key', '=', 'ai.provider')
      .executeTakeFirst();
    const name = typeof row?.value === 'string' ? row.value : DEFAULT_PROVIDER;
    return providerByName(name) ?? null;
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
  routes: routesWith({
    dispatch: { getQueue: () => queue },
    // SEC-12, ADR-0038: the console links to the enclave; the platform never calls it.
    missions: {
      ...(config.CJIS_PUBLIC_URL ? { cjisPublicUrl: config.CJIS_PUBLIC_URL } : {}),
      objects: {
        client: s3,
        ...(presignClient ? { presignClient } : {}),
        bucket: config.S3_BUCKET,
      },
    },
    fieldVoice: { ai, defaultGraph: westwindGraph },
    commands: { ai },
    // BRD:FR-03.02: the self-hosted Nominatim when the maps profile runs; parcels answer first.
    geocode: { nominatimUrl: config.GEOCODER_URL },
    // CON-14, ADR-0046: the self-hosted router when the routing profile runs.
    routing: { routingUrl: config.ROUTING_URL },
    // SEC-07: what the county gives its identity provider names the realm's public address.
    sso: { idpPublicBase: config.IDP_PUBLIC_BASE },
    drafting: { ai, objects: { client: s3, bucket: config.S3_BUCKET } },
    scribe: { ai, objects: { client: s3, bucket: config.S3_BUCKET } },
    refdata: { objects: { client: s3, bucket: config.S3_BUCKET } },
    personnelPhotos: { objects: { client: s3, bucket: config.S3_BUCKET } },
    resources: { objects: { client: s3, bucket: config.S3_BUCKET } },
    exports: { objects: { client: s3, bucket: config.S3_BUCKET } },
    metrics: { productName: config.PRODUCT_NAME },
    icsForms: { productName: config.PRODUCT_NAME },
    packagePhotos: {
      objects: {
        client: s3,
        ...(presignClient ? { presignClient } : {}),
        bucket: config.S3_BUCKET,
      },
    },
    fieldSync: {
      objects: {
        client: s3,
        ...(presignClient ? { presignClient } : {}),
        maxBytes: config.PUBLIC_UPLOAD_MAX_BYTES,
        bucket: config.S3_BUCKET,
      },
    },
  }),
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
      publicBase: config.WEBHOOK_PUBLIC_BASE ?? config.IDP_PUBLIC_BASE.replace(/\/auth$/, ''),
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
  gisRoutes: [gisRoutes({ resolver, db })],
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

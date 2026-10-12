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
import { westwindGraph } from '@cg/intake';
import { ReferenceCodeLeaser } from './public/reference-codes.ts';
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
      resolver: new TenantResolver(db),
      codes: new ReferenceCodeLeaser(db, `${process.env['HOSTNAME'] ?? 'api'}:${process.pid}`),
      getQueue: () => queue,
      objects: { client: s3, bucket: config.S3_BUCKET, maxBytes: config.PUBLIC_UPLOAD_MAX_BYTES },
      residentTokenSecret: config.RESIDENT_TOKEN_SECRET,
      defaultGraph: westwindGraph,
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

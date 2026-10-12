import Fastify, { type FastifyPluginAsync } from 'fastify';
import swagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import type { Database } from '@cg/db';
import type { FieldCrypto } from '@cg/crypto';
import { runProbes, type Probe } from '@cg/adapters';
import { AuthError, type SubjectLoader } from './auth/subject.ts';
import { errorHandler } from './errors.ts';
import { redactPaths } from './logging.ts';
import { authorizePlugin } from './plugins/authorize.ts';
import { contextPlugin } from './plugins/context.ts';
import { idempotencyPlugin } from './plugins/idempotency.ts';
import { versionsPlugin } from './plugins/versions.ts';

export interface AppOptions {
  productName: string;
  version: string;
  dataMode: 'synthetic' | 'production';
  probes: readonly Probe[];
  logLevel?: string;
  db?: Kysely<Database>;
  subjects?: SubjectLoader;
  /** Field encryption for restricted columns (SEC-10); absent only in unit tests. */
  fieldCrypto?: FieldCrypto;
  /** Route plugins mounted under /api/v1. */
  routes?: FastifyPluginAsync[];
  /** Route plugins mounted under /api/public (no staff session; layer 2 intake). */
  publicRoutes?: FastifyPluginAsync[];
  /** Route plugins mounted under /api/webhooks (carrier callbacks and the simulator). */
  webhookRoutes?: FastifyPluginAsync[];
}

export type App = Awaited<ReturnType<typeof buildApp>>;

declare module 'fastify' {
  interface FastifyInstance {
    fieldCrypto: FieldCrypto;
  }
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({
    logger: { level: opts.logLevel ?? 'info', redact: { paths: redactPaths, remove: true } },
    // Correlation id for every request (NFR-10). Generated server-side; a
    // client-supplied execution id for idempotency is a separate header.
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  if (opts.fieldCrypto) app.decorate('fieldCrypto', opts.fieldCrypto);

  // SCL-09: documented REST API, generated from the same schemas that validate requests.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: `${opts.productName} API`, version: opts.version },
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });

  const subjects: SubjectLoader = opts.subjects ?? {
    fromBearer: async () => {
      throw new AuthError('identity_not_configured');
    },
  };
  await app.register(contextPlugin, { ...(opts.db ? { db: opts.db } : {}), subjects });
  await app.register(authorizePlugin, opts.db ? { db: opts.db } : {});
  await app.register(versionsPlugin);
  await app.register(idempotencyPlugin);

  // Liveness: the process is up. Never touches dependencies.
  app.get('/health/live', async () => ({ status: 'ok' }));

  // Readiness: every dependency by name, 503 if any is down (SCL-06 inputs).
  app.get('/health/ready', async (_req, reply) => {
    const checks = await runProbes(opts.probes);
    const ok = checks.every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });

  // Public, non-sensitive metadata (BRD:FR-18.02: public branding is separate
  // from private configuration). ADM-03: product name comes from config.
  app.get('/api/meta', async () => ({
    productName: opts.productName,
    version: opts.version,
    dataMode: opts.dataMode,
  }));

  app.get('/api/docs/json', async () => app.swagger());

  for (const routes of opts.routes ?? []) {
    await app.register(routes, { prefix: '/api/v1' });
  }
  for (const routes of opts.publicRoutes ?? []) {
    await app.register(routes, { prefix: '/api/public' });
  }
  for (const routes of opts.webhookRoutes ?? []) {
    await app.register(routes, { prefix: '/api/webhooks' });
  }

  return app;
}

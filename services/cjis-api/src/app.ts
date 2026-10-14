/**
 * The enclave API app (SEC-12, ADR-0036/0037). Everything under /api/v1 but
 * the system use notification needs an enclave token; unknown paths are
 * denied (default deny, ADM-05). No route calls the platform, and the
 * platform never calls this one.
 */
import Fastify, { type FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import type { CjisDatabase } from '@cg/cjis-db';
import type { FieldCrypto } from '@cg/crypto';
import { runProbes, type Probe } from '@cg/adapters';
import type { SubjectLoader } from './auth/subject.ts';
import { Sealer } from './crypto.ts';
import { errorHandler } from './errors.ts';
import { contextPlugin } from './plugins/context.ts';
import { accountRoutes } from './routes/accounts.ts';
import { auditRoutes } from './routes/audit.ts';
import { recordRoutes } from './routes/records.ts';

/** AC-8: shown before sign-in; the deployment can replace it (CJIS_SYSTEM_USE_NOTICE). */
export const DEFAULT_NOTICE =
  'You are about to use a criminal justice information system. Only authorized, screened ' +
  'personnel may use it, and only for authorized purposes. Everything you do here is recorded ' +
  'and may be reviewed. Misuse can lead to disciplinary action and criminal or civil penalties. ' +
  'By signing in you accept these conditions.';

export interface EnclaveAppOptions {
  db: Kysely<CjisDatabase>;
  subjects: SubjectLoader;
  crypto: FieldCrypto;
  probes?: readonly Probe[];
  notice?: string;
  logLevel?: string;
}

/** Never log a request body, header value or query string: they can carry CJI or tokens. */
const redact = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-reason"]',
  'res.headers["set-cookie"]',
];

export async function buildEnclaveApp(opts: EnclaveAppOptions) {
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? 'info',
      base: { service: 'cjis-api' },
      redact: { paths: redact, remove: true },
      serializers: {
        // The route pattern, never the URL with its query string.
        req: (req: FastifyRequest) => ({
          method: req.method,
          route: req.routeOptions?.url,
          id: req.id,
        }),
      },
    },
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 262_144,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.decorate('sealer', new Sealer(opts.crypto));

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    const checks = await runProbes(opts.probes ?? []);
    const ok = checks.every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });

  await app.register(
    async (api) => {
      // The one public route: the system use notification shown before sign-in (AC-8).
      api.get('/notice', async () => ({ text: opts.notice ?? DEFAULT_NOTICE }));
      await api.register(contextPlugin, {
        db: opts.db,
        subjects: opts.subjects,
        crypto: opts.crypto,
      });
      await api.register(accountRoutes);
      await api.register(recordRoutes);
      await api.register(auditRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Default deny (ADM-05): anything else is refused without saying what exists.
  app.setNotFoundHandler((_req, reply) =>
    reply
      .code(403)
      .send({ code: 'forbidden', message: 'Not allowed.', fields: [], retryable: false }),
  );

  return app;
}

export type EnclaveApp = Awaited<ReturnType<typeof buildEnclaveApp>>;

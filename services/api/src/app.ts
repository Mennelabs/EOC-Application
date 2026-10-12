import Fastify, { type FastifyInstance } from 'fastify';
import { runProbes, type Probe } from '@cg/adapters';
import { redactPaths } from './logging.ts';

export interface AppOptions {
  productName: string;
  version: string;
  dataMode: 'synthetic' | 'production';
  probes: readonly Probe[];
  logLevel?: string;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: opts.logLevel ?? 'info', redact: { paths: redactPaths, remove: true } },
    // Correlation id for every request (NFR-10). Generated server-side; a
    // client-supplied execution id for idempotency is a separate header.
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

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

  return app;
}

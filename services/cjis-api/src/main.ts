/**
 * CJIS enclave API (SEC-12, ADR-0021). Runs only on the cg_cjis network with
 * its own database, keys and identity provider. It holds no real CJI: real
 * criminal-justice data is allowed only after the move to an authorized
 * government cloud and a passed state CJIS audit (SCL-12); the configuration
 * refuses production mode without both declared.
 */
import Fastify from 'fastify';
import { cjisSchema, loadConfig } from '@cg/config';
import { createPool, openBaoProbe, postgresProbe, runProbes } from '@cg/adapters';

const config = loadConfig(cjisSchema);
const pool = createPool(config.CJIS_DATABASE_URL, 5);
const probes = [
  postgresProbe('cjis-db', pool),
  openBaoProbe('cjis-keys', config.CJIS_OPENBAO_ADDR),
];

const app = Fastify({ logger: { level: config.LOG_LEVEL, base: { service: 'cjis-api' } } });

app.get('/health/live', async () => ({ status: 'ok' }));
app.get('/health/ready', async (_req, reply) => {
  const checks = await runProbes(probes);
  const ok = checks.every((c) => c.ok);
  return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
});

// Default deny until task C adds enclave identity and authorization (ADM-05).
app.setNotFoundHandler((_req, reply) => reply.code(403).send({ error: 'forbidden' }));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: config.PORT });

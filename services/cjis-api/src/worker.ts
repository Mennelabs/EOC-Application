/**
 * The enclave worker (`cjis-worker`, SEC-12, ADR-0037): system jobs as the
 * `cjis_job` role with the identity provider's least-privilege admin client.
 * The API never holds either credential. Health on /health/live and
 * /health/ready like every service.
 */
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { cjisWorkerSchema, loadConfig } from '@cg/config';
import { createPool, httpProbe, openBaoProbe, postgresProbe, runProbes } from '@cg/adapters';
import { createCjisDb } from '@cg/cjis-db';
import { FieldCrypto, OpenBaoKeyService } from '@cg/crypto';
import { agencyKeyStore } from './crypto.ts';
import { ADMIN_CLIENT_ID, EnclaveKeycloak } from './idp/keycloak.ts';
import {
  copySignInEvents,
  runIdentityOutbox,
  suspendInactive,
  sweepRetention,
  type JobDeps,
} from './jobs.ts';

const config = loadConfig(cjisWorkerSchema);
const db = createCjisDb(config.CJIS_DATABASE_URL, 4);
const probePool = createPool(config.CJIS_DATABASE_URL, 1);
const token = readFileSync(config.CJIS_OPENBAO_TOKEN_FILE, 'utf8').trim();
const crypto = new FieldCrypto(
  new OpenBaoKeyService(config.CJIS_OPENBAO_ADDR, token),
  agencyKeyStore(db),
);
const idp = new EnclaveKeycloak(config.CJIS_IDP_INTERNAL_BASE, {
  kind: 'client',
  realm: config.CJIS_IDP_REALM,
  clientId: ADMIN_CLIENT_ID,
  secret: config.CJIS_IDP_ADMIN_CLIENT_SECRET,
});
const deps: JobDeps = { db, crypto, idp, realm: config.CJIS_IDP_REALM };

const app = Fastify({ logger: { level: config.LOG_LEVEL, base: { service: 'cjis-worker' } } });
const probes = [
  postgresProbe('cjis-db', probePool),
  openBaoProbe('cjis-keys', config.CJIS_OPENBAO_ADDR),
  httpProbe(
    'cjis-idp',
    `${config.CJIS_IDP_INTERNAL_BASE}/realms/${config.CJIS_IDP_REALM}/.well-known/openid-configuration`,
  ),
];
app.get('/health/live', async () => ({ status: 'ok' }));
app.get('/health/ready', async (_req, reply) => {
  const checks = await runProbes(probes);
  const ok = checks.every((c) => c.ok);
  return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
});

/** A job loop that never overlaps itself and never stops on an error. */
function every(name: string, ms: number, job: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await job();
      app.log.debug({ job: name, out }, 'job ran');
    } catch (err) {
      app.log.warn({ job: name, err: err instanceof Error ? err.message : 'error' }, 'job failed');
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(() => void tick(), ms);
}

const timers = [
  every('identity', 3_000, () => runIdentityOutbox(deps)),
  every('sign-in-events', 15_000, () => copySignInEvents(deps)),
  every('retention', 60 * 60_000, () => sweepRetention(deps)),
  every('inactivity', 60 * 60_000, () => suspendInactive(deps)),
];

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    for (const t of timers) clearInterval(t);
    await app.close();
    await db.destroy();
    await probePool.end();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: config.PORT });

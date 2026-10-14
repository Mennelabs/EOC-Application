/**
 * CJIS enclave API (SEC-12, ADR-0021, ADR-0036/0037). Runs only on the
 * cg_cjis network with its own database, keys and identity provider. It holds
 * no real CJI: real criminal-justice data is allowed only after the move to
 * an authorized government cloud and a passed state CJIS audit (SCL-12); the
 * configuration refuses production mode without both declared.
 */
import { readFileSync } from 'node:fs';
import { cjisSchema, loadConfig } from '@cg/config';
import { openBaoProbe, postgresProbe, createPool } from '@cg/adapters';
import { createCjisDb } from '@cg/cjis-db';
import { FieldCrypto, OpenBaoKeyService } from '@cg/crypto';
import { buildEnclaveApp } from './app.ts';
import { createSubjectLoader } from './auth/subject.ts';
import { createTokenVerifier, remoteKeys } from './auth/token.ts';
import { agencyKeyStore } from './crypto.ts';

const config = loadConfig(cjisSchema);
const db = createCjisDb(config.CJIS_DATABASE_URL, 10);
const probePool = createPool(config.CJIS_DATABASE_URL, 1);
const token = readFileSync(config.CJIS_OPENBAO_TOKEN_FILE, 'utf8').trim();
const crypto = new FieldCrypto(
  new OpenBaoKeyService(config.CJIS_OPENBAO_ADDR, token),
  agencyKeyStore(db),
);
const verify = createTokenVerifier({
  issuer: `${config.CJIS_IDP_PUBLIC_BASE.replace(/\/$/, '')}/realms/${config.CJIS_IDP_REALM}`,
  audience: config.CJIS_API_AUDIENCE,
  secondFactors: config.CJIS_SECOND_FACTORS,
  keys: remoteKeys(config.CJIS_IDP_INTERNAL_BASE, config.CJIS_IDP_REALM),
});

const app = await buildEnclaveApp({
  db,
  crypto,
  subjects: createSubjectLoader(db, verify),
  probes: [
    postgresProbe('cjis-db', probePool),
    openBaoProbe('cjis-keys', config.CJIS_OPENBAO_ADDR),
  ],
  ...(config.CJIS_SYSTEM_USE_NOTICE ? { notice: config.CJIS_SYSTEM_USE_NOTICE } : {}),
  logLevel: config.LOG_LEVEL,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.destroy();
    await probePool.end();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: config.PORT });

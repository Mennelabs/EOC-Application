/**
 * One-shot enclave provisioning (`cjis-provision`, SEC-12, ADR-0036):
 * 1. waits for the enclave's own Keycloak;
 * 2. builds realm `cjis` (flows with method references, the CJIS lockout,
 *    session and password values, the web app's PKCE client, the worker's
 *    least-privilege service account);
 * 3. on a synthetic stack only, loads the exercise agencies and accounts
 *    (SCL-12) and gives them development credentials for the test client.
 * Re-runs change nothing that is already in place.
 */
import { cjisProvisionSchema, loadConfig } from '@cg/config';
import { EnclaveKeycloak } from './idp/keycloak.ts';
import { provisionExercise } from './provision/exercise.ts';

const config = loadConfig(cjisProvisionSchema);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ service: 'cjis-provision', msg, ...extra }));

const kc = new EnclaveKeycloak(config.CJIS_IDP_INTERNAL_BASE, {
  kind: 'master',
  user: config.CJIS_KC_ADMIN_USER,
  password: config.CJIS_KC_ADMIN_PASSWORD,
});

for (let attempt = 1; ; attempt++) {
  try {
    const res = await fetch(`${config.CJIS_IDP_INTERNAL_BASE}/realms/master`);
    if (res.ok) break;
  } catch {
    /* not up yet */
  }
  if (attempt >= 90) throw new Error('enclave identity provider did not come up');
  await new Promise((r) => setTimeout(r, 2000));
}

await kc.ensureRealm({
  realm: config.CJIS_IDP_REALM,
  displayName: 'CJIS enclave',
  publicUrl: config.CJIS_PUBLIC_URL,
  adminClientSecret: config.CJIS_IDP_ADMIN_CLIENT_SECRET,
  devAccounts: config.CJIS_DEV_ACCOUNTS && config.DATA_CLASSIFICATION_MODE === 'synthetic',
});
log('realm ready', { realm: config.CJIS_IDP_REALM });

if (config.CJIS_DEV_ACCOUNTS) {
  if (config.DATA_CLASSIFICATION_MODE !== 'synthetic') {
    throw new Error('exercise accounts are for synthetic stacks only (SCL-12)');
  }
  const loaded = await provisionExercise(config.CJIS_DATABASE_URL, kc, config.CJIS_IDP_REALM);
  log('exercise agencies and accounts ready', loaded);
}

/**
 * Exercise data for the enclave (SCL-12): filled in by layer-5 task B with
 * the synthetic agencies and accounts. Until then provisioning builds the
 * realm only.
 */
import type { EnclaveKeycloak } from '../idp/keycloak.ts';

export async function provisionExercise(
  _databaseUrl: string,
  _kc: EnclaveKeycloak,
  _realm: string,
): Promise<{ agencies: number; accounts: number }> {
  return { agencies: 0, accounts: 0 };
}

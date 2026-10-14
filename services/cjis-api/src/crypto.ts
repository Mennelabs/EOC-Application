/**
 * Field encryption in the enclave (SEC-10, ADR-0037): AES-256-GCM with a
 * data key per agency (the agency id is the AAD), wrapped by the enclave's
 * own key service (OpenBao locally, the cloud's FIPS-validated KMS later).
 * Keys never leave the enclave; the platform's keys are never used here.
 */
import type { Kysely } from 'kysely';
import { FieldCrypto, type TenantKeyStore } from '@cg/crypto';
import { withAgency, type CjisDatabase } from '@cg/cjis-db';

export function agencyKeyStore(db: Kysely<CjisDatabase>): TenantKeyStore {
  return {
    async getActive(agencyId) {
      return withAgency(db, { agencyId }, async (trx) => {
        const row = await trx
          .selectFrom('cjis.agency_key')
          .select(['version', 'wrapped'])
          .where('agency_id', '=', agencyId)
          .orderBy('version', 'desc')
          .executeTakeFirst();
        return row ? { version: row.version, wrapped: row.wrapped } : null;
      });
    },
    async get(agencyId, version) {
      return withAgency(db, { agencyId }, async (trx) => {
        const row = await trx
          .selectFrom('cjis.agency_key')
          .select(['version', 'wrapped'])
          .where('agency_id', '=', agencyId)
          .where('version', '=', version)
          .executeTakeFirst();
        return row ? { version: row.version, wrapped: row.wrapped } : null;
      });
    },
    async insert(agencyId, record) {
      await withAgency(db, { agencyId }, (trx) =>
        trx
          .insertInto('cjis.agency_key')
          .values({
            agency_id: agencyId,
            version: record.version,
            wrapped: record.wrapped,
            kek_name: record.kekName,
          })
          .onConflict((oc) => oc.columns(['agency_id', 'version']).doNothing())
          .execute(),
      );
    },
  };
}

/** Optional values: null stays null; strings and JSON are encrypted under the agency key. */
export class Sealer {
  private readonly crypto: FieldCrypto;
  constructor(crypto: FieldCrypto) {
    this.crypto = crypto;
  }

  async seal(agencyId: string, value: string | null | undefined): Promise<Buffer | null> {
    if (value === null || value === undefined || value === '') return null;
    return this.crypto.encrypt(agencyId, value);
  }

  async sealJson(agencyId: string, value: unknown): Promise<Buffer | null> {
    if (value === null || value === undefined) return null;
    return this.crypto.encrypt(agencyId, JSON.stringify(value));
  }

  async open(agencyId: string, blob: Buffer | null): Promise<string | null> {
    return blob ? this.crypto.decrypt(agencyId, blob) : null;
  }

  async openJson<T>(agencyId: string, blob: Buffer | null): Promise<T | null> {
    const text = await this.open(agencyId, blob);
    return text === null ? null : (JSON.parse(text) as T);
  }
}

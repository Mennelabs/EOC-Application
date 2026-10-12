/** cg.tenant_key as a TenantKeyStore, inside the tenant's own RLS context. */
import type { Kysely } from 'kysely';
import { withTenant, type Database } from '@cg/db';
import type { TenantKeyRecord, TenantKeyStore } from './field.ts';

export function dbKeyStore(db: Kysely<Database>): TenantKeyStore {
  return {
    async getActive(tenantId) {
      return withTenant(db, { tenantId }, async (trx) => {
        const row = await trx
          .selectFrom('cg.tenant_key')
          .select(['key_version', 'wrapped_dek'])
          .where('tenant_id', '=', tenantId)
          .where('status', '=', 'active')
          .orderBy('key_version', 'desc')
          .executeTakeFirst();
        return row ? { version: row.key_version, wrapped: row.wrapped_dek } : null;
      });
    },
    async get(tenantId, version) {
      return withTenant(db, { tenantId }, async (trx) => {
        const row = await trx
          .selectFrom('cg.tenant_key')
          .select(['key_version', 'wrapped_dek'])
          .where('tenant_id', '=', tenantId)
          .where('key_version', '=', version)
          .executeTakeFirst();
        return row ? { version: row.key_version, wrapped: row.wrapped_dek } : null;
      });
    },
    async insert(tenantId, record) {
      await withTenant(db, { tenantId }, (trx) =>
        trx
          .insertInto('cg.tenant_key')
          .values({
            tenant_id: tenantId,
            key_version: record.version,
            kek_name: record.kekName,
            wrapped_dek: record.wrapped,
          })
          .execute(),
      );
    },
  };
}

export class MemoryKeyStore implements TenantKeyStore {
  private readonly rows = new Map<string, TenantKeyRecord[]>();

  async getActive(tenantId: string): Promise<TenantKeyRecord | null> {
    const list = this.rows.get(tenantId) ?? [];
    return list.length ? (list[list.length - 1] ?? null) : null;
  }

  async get(tenantId: string, version: number): Promise<TenantKeyRecord | null> {
    return (this.rows.get(tenantId) ?? []).find((r) => r.version === version) ?? null;
  }

  async insert(tenantId: string, record: TenantKeyRecord): Promise<void> {
    const list = this.rows.get(tenantId) ?? [];
    list.push({ version: record.version, wrapped: record.wrapped });
    this.rows.set(tenantId, list);
  }
}

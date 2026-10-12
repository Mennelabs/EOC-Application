/**
 * Public routes name the tenant by slug in the URL (QR codes and short links,
 * CHN-08). The resolver turns the slug into the tenant row and sets the
 * public subject's tenant so request.tx() runs under that tenant's RLS.
 * Tenants rarely change, so a short cache keeps the hot path off the database.
 */
import type { Kysely } from 'kysely';
import type { Database } from '@cg/db';
import { withTenant } from '@cg/db';
import { sql } from 'kysely';
import { errors } from '../errors.ts';

export interface PublicTenant {
  id: string;
  slug: string;
  name: string;
  locales: string[];
  branding: Record<string, unknown>;
  status: string;
}

export class TenantResolver {
  private readonly cache = new Map<string, { at: number; tenant: PublicTenant | null }>();
  private readonly db: Kysely<Database>;
  private readonly ttlMs: number;

  constructor(db: Kysely<Database>, ttlMs = 60_000) {
    this.db = db;
    this.ttlMs = ttlMs;
  }

  async bySlug(slug: string): Promise<PublicTenant> {
    const hit = this.cache.get(slug);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      if (!hit.tenant) throw errors.notFound();
      return hit.tenant;
    }
    // No tenant context exists yet: the select policy on cg.tenant admits the
    // one row whose slug equals app.public_slug for this transaction (0017).
    const row = await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.public_slug', ${slug}, true)`.execute(trx);
      return trx
        .selectFrom('cg.tenant')
        .select(['id', 'slug', 'name', 'locales', 'branding', 'status'])
        .where('slug', '=', slug)
        .executeTakeFirst();
    });
    const tenant = row
      ? {
          id: row.id,
          slug: row.slug,
          name: row.name,
          locales: row.locales,
          branding: (row.branding ?? {}) as Record<string, unknown>,
          status: row.status,
        }
      : null;
    this.cache.set(slug, { at: Date.now(), tenant });
    if (!tenant) throw errors.notFound();
    return tenant;
  }

  /** Inbound webhooks name the county's number (0019 admits the number row and its tenant). */
  async byNumber(number: string): Promise<PublicTenant> {
    const key = `number:${number}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      if (!hit.tenant) throw errors.notFound();
      return hit.tenant;
    }
    const row = await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.public_number', ${number}, true)`.execute(trx);
      return trx
        .selectFrom('cg.channel_number')
        .innerJoin('cg.tenant', 'cg.tenant.id', 'cg.channel_number.tenant_id')
        .select([
          'cg.tenant.id as id',
          'cg.tenant.slug as slug',
          'cg.tenant.name as name',
          'cg.tenant.locales as locales',
          'cg.tenant.branding as branding',
          'cg.tenant.status as status',
        ])
        .where('cg.channel_number.number', '=', number)
        .executeTakeFirst();
    });
    const tenant = row
      ? {
          id: row.id,
          slug: row.slug,
          name: row.name,
          locales: row.locales,
          branding: (row.branding ?? {}) as Record<string, unknown>,
          status: row.status,
        }
      : null;
    this.cache.set(key, { at: Date.now(), tenant });
    if (!tenant) throw errors.notFound();
    return tenant;
  }

  /** Runs fn under the tenant's RLS without any account (public path). */
  asTenant<T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]): Promise<T> {
    return withTenant(this.db, { tenantId }, fn);
  }
}

/**
 * 0012 parties and locations (layer-2 plan §2; HLP-01, WIT-01, ORG-01, EQ-03,
 * SEC-10, CHN-04). Names and contact details are encrypted with blind
 * indexes; the location stays queryable for maps and geocoding and is read
 * only with the location_exact category, audited (SEC-18).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.party (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      kind text not null check (kind in ('resident', 'helper', 'witness', 'organization')),
      display_name_enc bytea,
      contact_enc bytea,
      phone_bidx bytea,
      email_bidx bytea,
      language text not null default 'en',
      sms_opt_in boolean not null default false,
      sms_opt_in_evidence jsonb,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index party_phone_bidx on cg.party (tenant_id, phone_bidx) where phone_bidx is not null`.execute(
    db,
  );
  await sql`create index party_email_bidx on cg.party (tenant_id, email_bidx) where email_bidx is not null`.execute(
    db,
  );
  await sql`create trigger party_touch before update on cg.party for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.party')`.execute(db);

  await sql`
    create table cg.location (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      line1 text,
      unit text,
      city text,
      state text,
      postal text,
      landmark text,
      note text,
      no_fixed_address boolean not null default false,
      geom geometry(Point, 4326),
      precision text not null default 'unknown' check (precision in ('exact', 'approximate', 'area', 'unknown')),
      source text not null default 'resident' check (source in ('resident', 'geocoder', 'reviewer', 'field')),
      parcel_id text,
      usng text,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index location_geom_gist on cg.location using gist (geom)`.execute(db);
  await sql`create trigger location_touch before update on cg.location for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.location')`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.location cascade`.execute(db);
  await sql`drop table if exists cg.party cascade`.execute(db);
}

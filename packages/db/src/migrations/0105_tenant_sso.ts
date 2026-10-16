/**
 * 0105 single sign-on through a county's own identity provider (SEC-07
 * "Staff sign-in via tenant SSO (SAML/OIDC) with phishing-resistant MFA",
 * ADR-0008, plan reading 49). One row per proposed configuration: an
 * administrator proposes, a second administrator approves or declines
 * (ADM-05), and the approved one is applied to the county's realm by the
 * worker. At most one is in force and one waits at a time. The SAML
 * metadata is public by nature; an OIDC client secret is kept encrypted
 * under the tenant key and never returned.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.tenant_sso (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      protocol text not null check (protocol in ('saml', 'oidc')),
      display_name text not null check (length(display_name) between 2 and 80),
      saml_metadata text check (length(saml_metadata) <= 200000),
      idp_entity_id text check (length(idp_entity_id) <= 500),
      oidc_issuer text check (length(oidc_issuer) <= 500),
      oidc_authorization_url text check (length(oidc_authorization_url) <= 500),
      oidc_token_url text check (length(oidc_token_url) <= 500),
      oidc_jwks_url text check (length(oidc_jwks_url) <= 500),
      oidc_client_id text check (length(oidc_client_id) <= 255),
      oidc_client_secret_enc bytea,
      status text not null default 'proposed'
        check (status in ('proposed', 'active', 'declined', 'replaced', 'disabled')),
      reason text not null check (length(reason) between 1 and 500),
      decided_by uuid,
      decided_at timestamptz,
      decision_reason text,
      disabled_by uuid,
      disabled_at timestamptz,
      disabled_reason text,
      applied_at timestamptz,
      apply_error text check (length(apply_error) <= 500),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid not null,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      -- ADM-05: the second administrator is never the one who proposed it.
      check (decided_by is null or decided_by <> created_by),
      check (protocol <> 'saml' or (saml_metadata is not null and idp_entity_id is not null)),
      check (
        protocol <> 'oidc' or (
          oidc_issuer is not null and oidc_authorization_url is not null
          and oidc_token_url is not null and oidc_jwks_url is not null
          and oidc_client_id is not null and oidc_client_secret_enc is not null
        )
      )
    )`.execute(db);
  await sql`create unique index tenant_sso_one_active on cg.tenant_sso (tenant_id)
    where status = 'active'`.execute(db);
  await sql`create unique index tenant_sso_one_proposed on cg.tenant_sso (tenant_id)
    where status = 'proposed'`.execute(db);
  await sql`create trigger tenant_sso_touch before update on cg.tenant_sso
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.tenant_sso')`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.tenant_sso`.execute(db);
  await loadDictionary(db);
}

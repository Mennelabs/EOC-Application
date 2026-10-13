/**
 * 0022 partner sharing (layer-3 plan §2 and §6; NED-04, NED-05, AC-17C, FL-03,
 * FL-10, BRD:FR-17.01–17.03, CNT-01): share grants carry the minimum-field
 * projection a partner organization may see and are the only path a partner
 * reads through; referrals between organizations; the interagency contact
 * registry (restricted). Retention categories for the new records (SEC-13).
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.share_grant (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      to_tenant_id uuid not null references cg.tenant(id),
      org_type text not null,
      report_id uuid references cg.report(id),
      need_id uuid references cg.need(id),
      party_id uuid references cg.party(id),
      consent_id uuid references cg.consent(id),
      agreement_id uuid references cg.data_sharing_agreement(id),
      sections text[] not null default '{}',
      projection jsonb not null default '{}'::jsonb,
      projection_enc bytea,
      granted_at timestamptz not null default now(),
      revoked_at timestamptz,
      revoke_reason text,
      recall_notice_message_id uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create unique index share_grant_active_idx on cg.share_grant (to_tenant_id, org_type, coalesce(report_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(need_id, '00000000-0000-0000-0000-000000000000'::uuid)) where revoked_at is null`.execute(
    db,
  );
  await sql`create index share_grant_partner_idx on cg.share_grant (to_tenant_id, revoked_at)`.execute(
    db,
  );
  await sql`create index share_grant_report_idx on cg.share_grant (report_id)`.execute(db);
  await sql`create index share_grant_need_idx on cg.share_grant (need_id)`.execute(db);
  await sql`create trigger share_grant_touch before update on cg.share_grant for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.share_grant')`.execute(db);
  // The partner organization reads its own grants in its own tenant context; nothing else of the county's.
  await sql`
    create policy share_grant_partner_select on cg.share_grant for select using (
      to_tenant_id = cg.current_tenant_id())`.execute(db);

  await sql`
    create table cg.referral (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      from_tenant_id uuid not null references cg.tenant(id),
      to_tenant_id uuid references cg.tenant(id),
      to_org_type text,
      report_id uuid references cg.report(id),
      need_id uuid references cg.need(id),
      party_id uuid references cg.party(id),
      share_grant_id uuid references cg.share_grant(id),
      purpose text not null,
      status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'done')),
      opened_by uuid not null,
      accepted_by uuid,
      closed_at timestamptz,
      outcome text,
      attempts jsonb not null default '[]'::jsonb,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check (to_tenant_id is not null or to_org_type is not null)
    )`.execute(db);
  await sql`create index referral_to_idx on cg.referral (to_tenant_id, status)`.execute(db);
  await sql`create index referral_report_idx on cg.referral (report_id)`.execute(db);
  await sql`create trigger referral_touch before update on cg.referral for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.referral')`.execute(db);
  await sql`
    create policy referral_partner_select on cg.referral for select using (
      to_tenant_id = cg.current_tenant_id() or from_tenant_id = cg.current_tenant_id())`.execute(
    db,
  );
  await sql`
    create policy referral_partner_update on cg.referral for update
      using (to_tenant_id = cg.current_tenant_id())
      with check (to_tenant_id = cg.current_tenant_id())`.execute(db);

  // Interagency contacts (F17): names and methods restricted, owned by the county.
  await sql`
    create table cg.partner_contact (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      org_tenant_id uuid references cg.tenant(id),
      agency text not null,
      name_enc bytea not null,
      role text,
      methods_enc bytea not null,
      type text not null default 'operations' check (type in ('operations', 'twenty_four_hour', 'backup', 'media', 'liaison')),
      active boolean not null default true,
      verified_at timestamptz,
      verify_by date,
      backup_of uuid references cg.partner_contact(id),
      owner_account_id uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index partner_contact_tenant_idx on cg.partner_contact (tenant_id, active)`.execute(
    db,
  );
  await sql`create trigger partner_contact_touch before update on cg.partner_contact for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.partner_contact')`.execute(db);

  // Retention categories for the new records (SEC-13); existing tenants get the rows now.
  await sql`
    create or replace function cg.seed_retention_defaults(p_tenant uuid, p_actor uuid) returns void
    language sql as $$
      insert into cg.retention_policy (tenant_id, data_category, keep_for, rule, note, created_by)
      values
        (p_tenant, 'records', interval '7 years', 'duration', 'SEC-13 default', p_actor),
        (p_tenant, 'photos', interval '7 years', 'duration', 'SEC-13 default', p_actor),
        (p_tenant, 'free_text', interval '7 years', 'duration', 'SEC-13 default', p_actor),
        (p_tenant, 'audit', interval '7 years', 'duration', 'SEC-13 default; cannot be shortened', p_actor),
        (p_tenant, 'position_trail', interval '30 days', 'duration', 'DSP-08', p_actor),
        (p_tenant, 'command_conversation', interval '30 days', 'duration', 'Section 30.2', p_actor),
        (p_tenant, 'scribe_audio', null, 'on_confirm', 'FL-04: deleted once the note is confirmed', p_actor),
        (p_tenant, 'cji', null, 'external', 'SEC-12: CJIS and state records rules in the enclave', p_actor),
        (p_tenant, 'drafts', interval '7 days', 'duration', 'INT-20: paused reports', p_actor),
        (p_tenant, 'otp', interval '1 day', 'duration', 'SEC-09: one-time codes', p_actor),
        (p_tenant, 'sessions', interval '90 days', 'duration', 'CHN-03/05: SMS and voice sessions', p_actor),
        (p_tenant, 'abuse_signals', interval '90 days', 'duration', 'SEC-17: rate-limit and risk evidence', p_actor),
        (p_tenant, 'sharing', interval '7 years', 'duration', 'NED-04/05: grants and recall notices follow the report', p_actor),
        (p_tenant, 'referrals', interval '7 years', 'duration', 'FL-10, F17: referrals and communication attempts', p_actor),
        (p_tenant, 'contacts', interval '3 years', 'duration', 'F17, CNT-01: re-verified each season', p_actor),
        (p_tenant, 'publications', interval '7 years', 'duration', 'PUB-06: what was published, where and when', p_actor),
        (p_tenant, 'site_confirmations', interval '1 year', 'duration', 'PUB-03: confirmation history', p_actor)
      on conflict do nothing
    $$`.execute(db);
  await sql`select cg.seed_retention_defaults(t.id, null) from cg.tenant t`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.partner_contact cascade`.execute(db);
  await sql`drop table if exists cg.referral cascade`.execute(db);
  await sql`drop table if exists cg.share_grant cascade`.execute(db);
  await sql`delete from cg.retention_policy where data_category in ('sharing', 'referrals', 'contacts', 'publications', 'site_confirmations') and note like '%:%'`.execute(
    db,
  );
  await sql`
    create or replace function cg.seed_retention_defaults(p_tenant uuid, p_actor uuid) returns void
    language sql as $$
      insert into cg.retention_policy (tenant_id, data_category, keep_for, rule, note, created_by)
      values
        (p_tenant, 'records', interval '7 years', 'duration', 'SEC-13 default', p_actor),
        (p_tenant, 'photos', interval '7 years', 'duration', 'SEC-13 default', p_actor),
        (p_tenant, 'free_text', interval '7 years', 'duration', 'SEC-13 default', p_actor),
        (p_tenant, 'audit', interval '7 years', 'duration', 'SEC-13 default; cannot be shortened', p_actor),
        (p_tenant, 'position_trail', interval '30 days', 'duration', 'DSP-08', p_actor),
        (p_tenant, 'command_conversation', interval '30 days', 'duration', 'Section 30.2', p_actor),
        (p_tenant, 'scribe_audio', null, 'on_confirm', 'FL-04: deleted once the note is confirmed', p_actor),
        (p_tenant, 'cji', null, 'external', 'SEC-12: CJIS and state records rules in the enclave', p_actor),
        (p_tenant, 'drafts', interval '7 days', 'duration', 'INT-20: paused reports', p_actor),
        (p_tenant, 'otp', interval '1 day', 'duration', 'SEC-09: one-time codes', p_actor),
        (p_tenant, 'sessions', interval '90 days', 'duration', 'CHN-03/05: SMS and voice sessions', p_actor),
        (p_tenant, 'abuse_signals', interval '90 days', 'duration', 'SEC-17: rate-limit and risk evidence', p_actor)
      on conflict do nothing
    $$`.execute(db);
}

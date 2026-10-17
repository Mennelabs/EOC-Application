/**
 * 0067 spoken public information (layer-7 task G; PUB-14, AIG-01, AIG-06,
 * AIG-08, ADR-0043). An audio file of a radio loop for a low-power AM
 * Travelers' Information Station, or of a read-out for ARES/RACES nets, made
 * with the AI voice from the script a person approved: the script as spoken
 * (it opens by saying the voice is computer-generated), the object in
 * storage with its size and hash, and the provider and model that spoke it.
 * Nothing in it is about a person. Text to speech joins the AI use register
 * for every tenant that has one, switched off and not evaluated.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.public_audio (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      site_id uuid not null references cg.site(id),
      form text not null check (form in ('radioLoop', 'netReadout')),
      language text not null check (language in ('en', 'es')),
      script text not null check (length(script) between 1 and 4096),
      object_key text not null,
      mime_type text not null,
      bytes integer not null check (bytes > 0),
      sha256 text not null,
      provider text not null,
      model text not null,
      ai_output_id uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid
    )`.execute(db);
  await sql`create index public_audio_site on cg.public_audio (tenant_id, site_id, created_at desc)`.execute(
    db,
  );
  await sql`create trigger public_audio_touch before update on cg.public_audio
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.public_audio')`.execute(db);

  // The migrator owns the register: row security is lifted for the insert, as in 0066.
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`
    insert into cg.ai_use_register (
      tenant_id, feature, provider, model, model_version, data_sent, decision_informed,
      human_checkpoint, owner, us_region, zero_retention, no_training, evaluation, enabled)
    select r.tenant_id, 'public.speech', r.provider, r.model, r.model_version,
           ${"A radio script a person approved: a site's public details; never a resident"},
           ${'Speaks the script as an audio file for a Travelers’ Information Station loop or an amateur radio net (PUB-14); the file opens by saying the voice is computer-generated'},
           ${'The PIO approves the script first and listens to the file before it goes on the air'},
           'Public information officer',
           r.us_region, r.zero_retention, r.no_training, '{}'::jsonb, false
      from cg.ai_use_register r
     where r.feature = 'intake.extraction'
       and not exists (
         select 1 from cg.ai_use_register x
          where x.tenant_id = r.tenant_id and x.feature = 'public.speech')`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`delete from cg.ai_use_register where feature = 'public.speech'`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
  await sql`drop table if exists cg.public_audio`.execute(db);
}

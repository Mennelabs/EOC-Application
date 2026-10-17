/**
 * 0068 the conversation scribe (layer-7 task H; FL-04, FL-05, FL-18,
 * FL:FR-16, FL:FR-23, FL:FR-26, AIG-01, AIG-05, SEC-13). One row per
 * conversation a worker records with a survivor's consent: the consent as
 * stated to the survivor in their language and how it was given; the audio,
 * encrypted in object storage, and the transcript, encrypted here, both kept
 * only until the note is confirmed; the drafted note and then the confirmed
 * note (encrypted); who stopped the recording. A note never confirmed expires
 * with the conversation retention (30 days by default), audio included. The
 * scribe's two AI features join the register for every tenant that has one,
 * switched off and not evaluated.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

const FEATURES: [string, string, string, string][] = [
  [
    'scribe.transcription',
    "A recorded conversation between a worker and a survivor, with the survivor's consent",
    'A transcript that feeds the drafted note; deleted with the audio when the note is confirmed (FL-04)',
    'The worker reviews and confirms the note; only the confirmed note is kept',
  ],
  [
    'scribe.note',
    'The transcript, redacted of names, phone numbers, emails, street addresses and identifiers',
    'Drafts the note (needs heard, help given, follow-ups, referrals), each line with the words it rests on (FL-04)',
    'The worker confirms or changes every line; only the confirmed note is kept',
  ],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.scribe_session (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      client_uuid uuid not null,
      account_id uuid not null,
      context text not null check (context in ('general', 'legal_aid', 'child')),
      language text not null check (language in ('en', 'es')),
      consent_method text not null check (consent_method in ('spoken', 'tapped')),
      consent_text text not null,
      consent_at timestamptz not null,
      related_type text,
      related_id uuid,
      state text not null default 'consented'
        check (state in ('consented', 'recorded', 'drafted', 'confirmed', 'discarded', 'expired')),
      stopped_by text check (stopped_by in ('worker', 'survivor')),
      audio_object_key text,
      audio_mime text,
      audio_bytes integer,
      transcript_enc bytea,
      draft_enc bytea,
      draft_output_id uuid,
      note_enc bytea,
      confirmed_at timestamptz,
      edited boolean,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (tenant_id, client_uuid),
      check (state <> 'confirmed' or (note_enc is not null and audio_object_key is null
        and transcript_enc is null and draft_enc is null))
    )`.execute(db);
  await sql`create index scribe_session_mine on cg.scribe_session (tenant_id, account_id, created_at desc)`.execute(
    db,
  );
  await sql`create index scribe_session_open on cg.scribe_session (tenant_id, created_at)
    where state in ('consented', 'recorded', 'drafted')`.execute(db);
  await sql`create trigger scribe_session_touch before update on cg.scribe_session
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.scribe_session')`.execute(db);
  await sql`drop policy tenant_delete on cg.scribe_session`.execute(db);

  // The migrator owns the register: row security is lifted for the insert, as in 0066.
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  for (const [feature, dataSent, decision, checkpoint] of FEATURES)
    await sql`
      insert into cg.ai_use_register (
        tenant_id, feature, provider, model, model_version, data_sent, decision_informed,
        human_checkpoint, owner, us_region, zero_retention, no_training, evaluation, enabled)
      select r.tenant_id, ${feature}, r.provider, r.model, r.model_version,
             ${dataSent}, ${decision}, ${checkpoint}, 'Field operations lead',
             r.us_region, r.zero_retention, r.no_training, '{}'::jsonb, false
        from cg.ai_use_register r
       where r.feature = 'intake.extraction'
         and not exists (
           select 1 from cg.ai_use_register x
            where x.tenant_id = r.tenant_id and x.feature = ${feature})`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`delete from cg.ai_use_register
    where feature in ('scribe.transcription', 'scribe.note')`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
  await sql`drop table if exists cg.scribe_session`.execute(db);
}

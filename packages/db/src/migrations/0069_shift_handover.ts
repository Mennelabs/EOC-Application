/**
 * 0069 shift hand-over (layer-7 task H; FL-12, AIG-01). At check-out a
 * worker confirms a note for the next shift: what was done and what is still
 * open, drafted from their own shift's records (the ICS 214 activity log,
 * open assignments, follow-ups in their conversation notes) by the rules or,
 * where the register allows, by the AI assistant, each fact cited. One note
 * per check-in; the next shift on the same team reads it. The AI feature
 * joins the register for every tenant that has one, off and not evaluated.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.shift_handover (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id),
      check_in_id uuid not null references cg.check_in(id),
      personnel_id uuid not null references cg.personnel(id),
      team_id uuid references cg.team(id),
      language text not null check (language in ('en', 'es')),
      text text not null check (length(text) between 1 and 4000),
      sources text[] not null default '{}',
      ai_output_id uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      unique (check_in_id)
    )`.execute(db);
  await sql`create index shift_handover_team on cg.shift_handover (tenant_id, team_id, created_at desc)`.execute(
    db,
  );
  await sql`create trigger shift_handover_touch before update on cg.shift_handover
    for each row execute function cg.touch()`.execute(db);
  await sql`select cg.apply_tenant_rls('cg.shift_handover')`.execute(db);
  await sql`drop policy tenant_delete on cg.shift_handover`.execute(db);

  // The migrator owns the register: row security is lifted for the insert, as in 0066.
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`
    insert into cg.ai_use_register (
      tenant_id, feature, provider, model, model_version, data_sent, decision_informed,
      human_checkpoint, owner, us_region, zero_retention, no_training, evaluation, enabled)
    select r.tenant_id, 'field.handover', r.provider, r.model, r.model_version,
           ${"Counts and summaries of a worker's own records from their shift, redacted of names, phone numbers, emails and street addresses; open assignments by mission name"},
           ${'Drafts the hand-over note for the next shift, each sentence citing its facts (FL-12)'},
           ${'The worker edits and confirms the note before checking out'},
           'Field operations lead',
           r.us_region, r.zero_retention, r.no_training, '{}'::jsonb, false
      from cg.ai_use_register r
     where r.feature = 'intake.extraction'
       and not exists (
         select 1 from cg.ai_use_register x
          where x.tenant_id = r.tenant_id and x.feature = 'field.handover')`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.ai_use_register no force row level security`.execute(db);
  await sql`delete from cg.ai_use_register where feature = 'field.handover'`.execute(db);
  await sql`alter table cg.ai_use_register force row level security`.execute(db);
  await sql`drop table if exists cg.shift_handover`.execute(db);
}

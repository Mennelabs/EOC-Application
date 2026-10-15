/**
 * 0049 joint damage assessment (layer-6 task F; FL:FR-10, DCL:DEC-13,
 * Form 010-0-13 Box 10, ADM-05 G4):
 * - `joint_pda`: one per event; the scheduled dates, areas and teams of the
 *   joint federal, state and county assessment, and the sample in force.
 * - `joint_pda_stop`: the sample route, drawn in proportion to the verified,
 *   counted homes by degree of damage. A new sample is a new sample version;
 *   earlier stops stay as they were drawn.
 * - `joint_pda_mark`: a validator's mark on a stop (validated, a different
 *   degree seen, or not seen), never changed; the latest mark stands.
 * Stops name the record, never the person or address: what a validator sees
 * is generalized when read (DEC-13). Every column is in the dictionary; RLS.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

const DEGREES = `'affected', 'minor', 'major', 'destroyed'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cg.joint_pda (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      event_id uuid not null references cg.event(id) unique,
      starts_on date,
      ends_on date,
      areas text[] not null default '{}' check (cardinality(areas) <= 50),
      teams jsonb not null default '[]'::jsonb check (jsonb_typeof(teams) = 'array'),
      status text not null default 'planned' check (status in ('planned', 'in_progress', 'done')),
      sample_version integer not null default 0 check (sample_version >= 0),
      sample_size integer check (sample_size between 1 and 500),
      sample_seed integer,
      sampled_at timestamptz,
      sampled_by uuid,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      created_by uuid,
      updated_at timestamptz not null default now(),
      updated_by uuid,
      check (ends_on is null or starts_on is null or ends_on >= starts_on)
    )`.execute(db);
  await sql`create trigger joint_pda_touch before update on cg.joint_pda for each row execute function cg.touch()`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.joint_pda')`.execute(db);
  await sql`drop policy tenant_delete on cg.joint_pda`.execute(db);

  await sql
    .raw(
      `
    create table cg.joint_pda_stop (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      joint_pda_id uuid not null references cg.joint_pda(id),
      sample_version integer not null check (sample_version >= 1),
      seq integer not null check (seq >= 1),
      record_kind text not null check (record_kind in ('report', 'assessment')),
      record_id uuid not null,
      stratum text not null check (stratum in (${DEGREES})),
      created_at timestamptz not null default now(),
      unique (joint_pda_id, sample_version, seq),
      unique (joint_pda_id, sample_version, record_id)
    )`,
    )
    .execute(db);
  await sql`select cg.apply_tenant_rls('cg.joint_pda_stop')`.execute(db);
  await sql`drop policy tenant_update on cg.joint_pda_stop`.execute(db);
  await sql`drop policy tenant_delete on cg.joint_pda_stop`.execute(db);

  await sql
    .raw(
      `
    create table cg.joint_pda_mark (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references cg.tenant(id),
      stop_id uuid not null references cg.joint_pda_stop(id),
      result text not null check (result in ('validated', 'different', 'not_seen')),
      degree_seen text check (degree_seen in (${DEGREES}, 'no_damage')),
      note text check (char_length(note) <= 500),
      marked_by uuid not null,
      marked_at timestamptz not null default now(),
      check ((result = 'different') = (degree_seen is not null))
    )`,
    )
    .execute(db);
  await sql`create index joint_pda_mark_stop_idx on cg.joint_pda_mark (stop_id, marked_at desc)`.execute(
    db,
  );
  await sql`select cg.apply_tenant_rls('cg.joint_pda_mark')`.execute(db);
  await sql`drop policy tenant_update on cg.joint_pda_mark`.execute(db);
  await sql`drop policy tenant_delete on cg.joint_pda_mark`.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists cg.joint_pda_mark`.execute(db);
  await sql`drop table if exists cg.joint_pda_stop`.execute(db);
  await sql`drop table if exists cg.joint_pda`.execute(db);
  await loadDictionary(db);
}

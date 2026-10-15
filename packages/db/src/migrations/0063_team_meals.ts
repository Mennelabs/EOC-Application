/**
 * 0063 a canteen's declared serving rate (layer-7 task E2; REC-06): partner
 * setup uses each partner's declared assets and limits, such as two canteens
 * and the meals each serves an hour. Null is unknown and is never guessed
 * (REC-10); staff is the team's member count.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.team add column meals_per_hour integer check (meals_per_hour >= 0)`.execute(
    db,
  );
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.team drop column if exists meals_per_hour`.execute(db);
}

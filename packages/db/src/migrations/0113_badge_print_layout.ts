/**
 * 0113 the label a badge was printed on (BRD:FR-13.05, BRD:FR-13.06; decision
 * 2026-10-15, ADR-0047). Badges print from the console through the operating
 * system's Brother driver on a QL-820NWB (62 mm × 100 mm label) or a
 * QL-1110NWB (4 in × 6 in label), or on a letter page; the layout chosen is
 * recorded with each print outcome, so a reprint on the other printer is a
 * fact and not a guess.
 */
import { sql, type Kysely } from 'kysely';
import { loadDictionary } from './0009_data_dictionary_rows.ts';

export const BADGE_PRINT_LAYOUTS = ['letter', 'ql820_62x100', 'ql1110_4x6'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table cg.badge add column print_layout text
      check (print_layout in ('letter', 'ql820_62x100', 'ql1110_4x6'));
  `.execute(db);
  await loadDictionary(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cg.badge drop column if exists print_layout;`.execute(db);
}

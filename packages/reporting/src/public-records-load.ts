/**
 * Reads the rows of a public-records release (SEC-13): for each kind of
 * record asked for, only the columns that may leave, of the one event, in
 * the period, as the worker sees them. Column and table names come from the
 * fixed catalog in public-records.ts and the data dictionary, never from the
 * request.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import {
  RECORD_TYPES,
  releasePlan,
  type PublicRecordsData,
  type PublicRecordsScope,
} from './public-records.ts';

const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function loadPublicRecords(
  trx: Transaction<Database>,
  tenantId: string,
  eventId: string,
  scope: PublicRecordsScope,
): Promise<PublicRecordsData | null> {
  const event = await trx
    .selectFrom('cg.event')
    .select('name')
    .where('id', '=', eventId)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (!event) return null;
  const rows: PublicRecordsData['rows'] = {};
  for (const type of scope.recordTypes) {
    const t = RECORD_TYPES[type];
    const cols = releasePlan(type).released.filter((c) => IDENT.test(c));
    if (cols.length === 0) {
      rows[type] = [];
      continue;
    }
    const conditions = [
      sql`x.tenant_id = ${tenantId}`,
      sql`${sql.raw(t.event)} = ${eventId}`,
      ...(t.where ? [sql.raw(t.where)] : []),
      ...(scope.from ? [sql`${sql.raw(t.date)} >= ${new Date(scope.from)}`] : []),
      ...(scope.to ? [sql`${sql.raw(t.date)} < ${new Date(scope.to)}`] : []),
    ];
    const result = await sql<Record<string, unknown>>`
      select ${sql.join(cols.map((c) => sql.raw(`x."${c}"`)))}
      from ${sql.raw(t.from)}
      where ${sql.join(conditions, sql` and `)}
      order by ${sql.raw(t.date)}`.execute(trx);
    rows[type] = result.rows;
  }
  return { event: { name: event.name }, rows };
}

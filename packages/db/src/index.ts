import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/** Table types are added layer by layer; layer 1 starts with tenancy and audit. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Database {}

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
  });
}

export { migrations } from './migrations/index.ts';

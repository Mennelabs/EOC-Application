import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_foundation.ts';

/** Ordered enclave migrations (packages/cjis-db). The platform's live in packages/db. */
export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
};

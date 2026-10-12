import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_foundation.ts';

/** Ordered, explicit list: no filesystem scanning inside containers. */
export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
};

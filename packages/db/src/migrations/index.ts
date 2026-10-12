import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_foundation.ts';
import * as m0002 from './0002_tenancy.ts';
import * as m0003 from './0003_events.ts';
import * as m0004 from './0004_identity.ts';
import * as m0005 from './0005_permissions.ts';
import * as m0006 from './0006_audit.ts';
import * as m0007 from './0007_data_protection.ts';
import * as m0008 from './0008_execution.ts';
import * as m0009 from './0009_data_dictionary_rows.ts';

/** Ordered, explicit list: no filesystem scanning inside containers. */
export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
  '0002_tenancy': m0002,
  '0003_events': m0003,
  '0004_identity': m0004,
  '0005_permissions': m0005,
  '0006_audit': m0006,
  '0007_data_protection': m0007,
  '0008_execution': m0008,
  '0009_data_dictionary_rows': m0009,
};

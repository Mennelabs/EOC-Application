import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_foundation.ts';
import * as m0002 from './0002_people_roles.ts';
import * as m0003 from './0003_records.ts';
import * as m0004 from './0004_audit_retention.ts';
import * as m0005 from './0005_subject_lookup.ts';

/** Ordered enclave migrations (packages/cjis-db). The platform's live in packages/db. */
export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
  '0002_people_roles': m0002,
  '0003_records': m0003,
  '0004_audit_retention': m0004,
  '0005_subject_lookup': m0005,
};

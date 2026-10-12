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
import * as m0010 from './0010_tenant_provisioning.ts';
import * as m0011 from './0011_intake_graph.ts';
import * as m0012 from './0012_parties_locations.ts';
import * as m0013 from './0013_reports.ts';
import * as m0014 from './0014_needs_consent.ts';
import * as m0015 from './0015_channels.ts';
import * as m0016 from './0016_ai_register.ts';
import * as m0017 from './0017_public_tenant_lookup.ts';
import * as m0018 from './0018_report_flags.ts';

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
  '0010_tenant_provisioning': m0010,
  '0011_intake_graph': m0011,
  '0012_parties_locations': m0012,
  '0013_reports': m0013,
  '0014_needs_consent': m0014,
  '0015_channels': m0015,
  '0016_ai_register': m0016,
  '0017_public_tenant_lookup': m0017,
  '0018_report_flags': m0018,
};

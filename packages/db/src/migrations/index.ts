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
import * as m0019 from './0019_channel_numbers.ts';
import * as m0020 from './0020_after_answers.ts';
import * as m0021 from './0021_needs_board.ts';
import * as m0022 from './0022_sharing.ts';
import * as m0023 from './0023_sites.ts';
import * as m0024 from './0024_resources.ts';
import * as m0025 from './0025_publication.ts';
import * as m0026 from './0026_message_direction.ts';
import * as m0027 from './0027_reminders.ts';
import * as m0028 from './0028_field_roster.ts';
import * as m0029 from './0029_positions_parcels.ts';
import * as m0030 from './0030_missions.ts';
import * as m0031 from './0031_hazards_safety_comms.ts';
import * as m0032 from './0032_reminders_badges.ts';
import * as m0033 from './0033_field_records.ts';
import * as m0034 from './0034_sync.ts';
import * as m0035 from './0035_roster_visibility.ts';
import * as m0036 from './0036_change_feed.ts';
import * as m0037 from './0037_field_assessment.ts';
import * as m0038 from './0038_field_record_photos.ts';
import * as m0039 from './0039_site_operator.ts';
import * as m0040 from './0040_audit_chain_order.ts';
import * as m0041 from './0041_cji_link.ts';
import * as m0042 from './0042_reference_data.ts';
import * as m0043 from './0043_location_geography.ts';
import * as m0044 from './0044_declaration_data.ts';
import * as m0045 from './0045_official_reports.ts';
import * as m0046 from './0046_fema_form_mapping.ts';
import * as m0047 from './0047_export_file.ts';
import * as m0048 from './0048_package_photo.ts';
import * as m0049 from './0049_joint_pda.ts';
import * as m0050 from './0050_equity_alert.ts';
import * as m0051 from './0051_integrations.ts';
import * as m0052 from './0052_partner_posting.ts';
import * as m0053 from './0053_partner_counts.ts';
import * as m0054 from './0054_ai_register_openai.ts';
import * as m0055 from './0055_ai_output.ts';
import * as m0056 from './0056_command_execution.ts';
import * as m0057 from './0057_ai_register_command.ts';

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
  '0019_channel_numbers': m0019,
  '0020_after_answers': m0020,
  '0021_needs_board': m0021,
  '0022_sharing': m0022,
  '0023_sites': m0023,
  '0024_resources': m0024,
  '0025_publication': m0025,
  '0026_message_direction': m0026,
  '0027_reminders': m0027,
  '0028_field_roster': m0028,
  '0029_positions_parcels': m0029,
  '0030_missions': m0030,
  '0031_hazards_safety_comms': m0031,
  '0032_reminders_badges': m0032,
  '0033_field_records': m0033,
  '0034_sync': m0034,
  '0035_roster_visibility': m0035,
  '0036_change_feed': m0036,
  '0037_field_assessment': m0037,
  '0038_field_record_photos': m0038,
  '0039_site_operator': m0039,
  '0040_audit_chain_order': m0040,
  '0041_cji_link': m0041,
  '0042_reference_data': m0042,
  '0043_location_geography': m0043,
  '0044_declaration_data': m0044,
  '0045_official_reports': m0045,
  '0046_fema_form_mapping': m0046,
  '0047_export_file': m0047,
  '0048_package_photo': m0048,
  '0049_joint_pda': m0049,
  '0050_equity_alert': m0050,
  '0051_integrations': m0051,
  '0052_partner_posting': m0052,
  '0053_partner_counts': m0053,
  '0054_ai_register_openai': m0054,
  '0055_ai_output': m0055,
  '0056_command_execution': m0056,
  '0057_ai_register_command': m0057,
};

/**
 * Action catalog (BRD:FR-C03, NFR-11): every governed operation, callable
 * manually, by the field app, or later by the command window, with the same
 * authorization. Layer 1 lists the foundation actions; each layer extends it.
 * An action not in the catalog is denied (default deny).
 */
export type ActionKind = 'read' | 'write' | 'export' | 'admin';

export interface ActionMeta {
  kind: ActionKind;
  resource: string;
  description: string;
  /** Allowed for unauthenticated subjects (within guardrail G2). */
  public?: boolean;
  /** RULE-14: confirmation and reason required. */
  consequential?: boolean;
  /** Never covered by a wildcard grant ('*' or 'family.*'): a role must name it (DSP-08). */
  explicit?: boolean;
}

const a = (
  kind: ActionKind,
  resource: string,
  description: string,
  extra: Partial<ActionMeta> = {},
): ActionMeta => ({ kind, resource, description, ...extra });

export const actions = {
  'meta.read': a('read', 'meta', 'Public product metadata and branding', { public: true }),
  'me.read': a('read', 'account', 'Own account, roles and active sessions'),

  'tenant.read': a('read', 'tenant', 'Tenant details and hierarchy'),
  'tenant.create_child': a(
    'admin',
    'tenant',
    'Create a child tenant (region, county, city, partner)',
    {
      consequential: true,
    },
  ),
  'tenant.update': a('admin', 'tenant', 'Update tenant details, locales, branding, status', {
    consequential: true,
  }),
  'tenant.config.read': a('read', 'tenant_config', 'Read tenant configuration'),
  'tenant.config.write': a('admin', 'tenant_config', 'Change tenant configuration (versioned)', {
    consequential: true,
  }),
  'license.read': a('read', 'license', 'Read subscription and covered jurisdictions'),
  'license.write': a('admin', 'license', 'Set subscription tier and term', { consequential: true }),

  'dsa.read': a('read', 'data_sharing_agreement', 'Read data-sharing agreements'),
  'dsa.create': a('write', 'data_sharing_agreement', 'Draft an agreement with another tenant'),
  'dsa.sign': a('admin', 'data_sharing_agreement', 'Sign an agreement', { consequential: true }),
  'dsa.revoke': a('admin', 'data_sharing_agreement', 'Revoke an agreement', {
    consequential: true,
  }),

  'event.read': a('read', 'event', 'Read events'),
  'event.create': a('write', 'event', 'Create an event from a template'),
  'event.update': a('write', 'event', 'Update event details and footprint'),
  'event.open': a('write', 'event', 'Open an event and publish its intake link and keyword', {
    consequential: true,
  }),
  'event.close': a('write', 'event', 'Close an event', { consequential: true }),
  'event.participant.add': a('write', 'event', 'Invite a partner tenant to an event'),

  'account.read': a('read', 'account', 'List and read staff accounts'),
  'account.invite': a('admin', 'account', 'Invite a staff account'),
  'account.activate': a('admin', 'account', 'Activate an invited account'),
  'account.suspend': a('admin', 'account', 'Suspend an account', { consequential: true }),
  'account.deactivate': a('admin', 'account', 'Deactivate an account (history kept)', {
    consequential: true,
  }),

  'personnel.read': a('read', 'personnel', 'Read personnel records'),
  'personnel.create': a('write', 'personnel', 'Create a personnel record'),
  'personnel.update': a('write', 'personnel', 'Update skills, agency, availability'),
  'personnel.archive': a('write', 'personnel', 'Archive a personnel record', {
    consequential: true,
  }),

  'role.read': a('read', 'role', 'Read roles and their versions'),
  'role.create': a('admin', 'role', 'Create a role from a template or from scratch'),
  'role.edit': a('admin', 'role', 'Draft a new version of a role'),
  'role.publish': a('admin', 'role', 'Publish a role version (needs a second administrator)', {
    consequential: true,
  }),
  'role.retire': a('admin', 'role', 'Retire a role', { consequential: true }),
  'role.preview': a('read', 'role', 'What can this role do'),

  'permission_change.read': a(
    'read',
    'permission_change_request',
    'Read pending permission changes',
  ),
  'permission_change.request': a(
    'admin',
    'permission_change_request',
    'Request a permission change',
  ),
  'permission_change.approve': a(
    'admin',
    'permission_change_request',
    'Approve a permission change requested by someone else',
    { consequential: true },
  ),
  'permission_change.reject': a('admin', 'permission_change_request', 'Reject a permission change'),
  'permission_change.withdraw': a('admin', 'permission_change_request', 'Withdraw own request'),

  'role_assignment.read': a('read', 'role_assignment', 'Read who holds which role'),
  'role_assignment.create': a('admin', 'role_assignment', 'Apply an approved assignment', {
    consequential: true,
  }),
  'role_assignment.revoke': a('admin', 'role_assignment', 'Revoke an assignment at once', {
    consequential: true,
  }),

  'break_glass.start': a(
    'admin',
    'break_glass_session',
    'Start a time-boxed emergency read session',
    {
      consequential: true,
    },
  ),
  'break_glass.end': a('admin', 'break_glass_session', 'End a break-glass session early'),
  'break_glass.read': a('read', 'break_glass_session', 'Read break-glass sessions'),

  'audit.read': a('read', 'audit_event', 'Read the audit log'),
  'audit.verify': a('read', 'audit_event', 'Verify the audit chain'),
  'audit.export': a('export', 'audit_event', 'Export audit records with redaction', {
    consequential: true,
  }),

  'definition.read': a('read', 'governed_definition', 'Read governed definitions'),
  'definition.write': a('admin', 'governed_definition', 'Publish a new definition version', {
    consequential: true,
  }),
  'retention.read': a('read', 'retention_policy', 'Read retention policies'),
  'retention.write': a('admin', 'retention_policy', 'Change retention policies', {
    consequential: true,
  }),
  'legal_hold.read': a('read', 'legal_hold', 'Read legal holds'),
  'legal_hold.place': a('admin', 'legal_hold', 'Place a legal hold', { consequential: true }),
  'legal_hold.release': a('admin', 'legal_hold', 'Release a legal hold', { consequential: true }),

  // ---- Layer 2: intake, reports, review ----
  'intake.read': a(
    'read',
    'intake_graph',
    'Published question graph, branding and languages for an event',
    { public: true },
  ),
  'intake.submit': a(
    'write',
    'report',
    'Submit a damage report or a need without a staff session',
    { public: true },
  ),
  'intake.draft': a('write', 'draft', 'Pause and resume a report with a short code', {
    public: true,
  }),
  'intake.upload': a('write', 'photo', 'Upload photos for a submission', { public: true }),
  'intake.extract': a('read', 'extraction', 'Candidate answers from free text (fixed schema)', {
    public: true,
  }),
  'intake.lookup': a('read', 'report', 'Start and verify a reference-code lookup (one-time code)', {
    public: true,
  }),
  'report.self_read': a('read', 'report', 'Read own report after verification', { public: true }),
  'report.self_update': a(
    'write',
    'report',
    'Correct, add to, withdraw own report or change consent',
    { public: true },
  ),
  'intake_graph.read': a('read', 'intake_graph', 'Read question graph versions'),
  'intake_graph.edit': a('admin', 'intake_graph', 'Draft a new question graph version'),
  'intake_graph.publish': a('admin', 'intake_graph', 'Publish a question graph version', {
    consequential: true,
  }),
  'report.read': a('read', 'report', 'Read damage reports and the review queue'),
  'report.create_assisted': a(
    'write',
    'report',
    "Record a report on a resident's behalf (assisted intake)",
  ),
  'report.update': a('write', 'report', "Update a report's location or answers as a reviewer"),
  'report.review': a(
    'write',
    'report',
    'Decide: approve, reject, needs information, duplicate, supersede, reopen',
    { consequential: true },
  ),
  'report.verify': a('write', 'report', 'Set the verification level'),
  'report.set_degree': a('write', 'report', 'Set the official FEMA degree of damage', {
    consequential: true,
  }),
  'report.request_information': a('write', 'report', 'Ask the resident for more information'),
  'photo.read': a('read', 'photo', 'Read photos (originals need the evidence category)'),
  'need.read': a('read', 'need', 'Read needs and the needs board'),
  'need.update': a('write', 'need', "Update a need's status"),
  'need.claim': a('write', 'need', 'Claim a need on the board for your organization'),
  'need.assign': a('write', 'need', 'Assign a need to a partner organization'),
  'need.release': a('write', 'need', 'Release a claimed need'),
  'need.done': a('write', 'need', 'Mark a need done with a note'),
  'need.export': a('export', 'need', 'Export needs (CSV or API) for a partner system', {
    consequential: true,
  }),
  'board.configure': a('admin', 'board_visibility', 'Set who sees whose claims on the board', {
    consequential: true,
  }),
  'board.read': a('read', 'board_visibility', 'See who sees whose claims on the board'),
  'shared.read': a('read', 'share_grant', 'Read records shared with your organization'),
  'referral.create': a('write', 'referral', 'Refer a resident to another organization'),
  'referral.respond': a('write', 'referral', 'Accept, decline or close a referral'),
  'message.send': a('write', 'message', 'Send a resident an update by text or email'),
  'site.read': a('read', 'site', 'Read sites (shelters, feeding, PODs, MARCs)'),
  'site.edit': a('write', 'site', 'Open, update or close a site'),
  'site.confirm': a('write', 'site', 'Confirm a site is still as published'),
  'site.publish': a('admin', 'site', 'Publish or unpublish a site on every public channel', {
    consequential: true,
  }),
  'resource.read': a('read', 'resource', 'Read published resources and drafts'),
  'resource.edit': a('write', 'resource', 'Draft or change a resource'),
  'resource.publish': a('admin', 'resource', 'Publish or unpublish a resource', {
    consequential: true,
  }),
  'publication.read': a('read', 'publication', 'Read the publication log'),
  'publication.draft': a(
    'write',
    'publication',
    'Draft alert and notification text from a site change',
  ),
  'contact.read': a('read', 'partner_contact', 'Read interagency contacts (restricted)'),
  'contact.edit': a('write', 'partner_contact', 'Add, change or verify an interagency contact'),
  'dashboard.read': a('read', 'dashboard', 'Key counts with their as-of time'),
  'partner.invite': a('admin', 'tenant', 'Invite a partner organization and start its agreement', {
    consequential: true,
  }),
  'help.read': a('read', 'help', 'Public sites and resources (Find help)', { public: true }),
  'need.create_public': a('write', 'need', 'Ask for help without a damage report', {
    public: true,
  }),
  'consent.read': a('read', 'consent', 'Read sharing consent'),
  'message.read': a('read', 'message', 'Read messages sent to residents'),
  'intake_session.read': a(
    'read',
    'intake_session',
    'Read SMS and voice sessions (agent hand-off)',
  ),
  'ai_register.read': a('read', 'ai_use_register', 'Read the AI use register'),
  'ai_register.write': a(
    'admin',
    'ai_use_register',
    'Enable or disable an AI feature for the tenant',
    { consequential: true },
  ),
  // Layer 4 task A: the field roster (PER-01, DSP-02, DSP-08, DSP-09, FLD-02, FLD-03, FLD-04).
  'credential.read': a('read', 'credential', 'Read recorded skills and credentials'),
  'credential.record': a(
    'write',
    'credential',
    'Record a credential for a person (never inferred)',
  ),
  'credential.verify': a(
    'write',
    'credential',
    'Verify a recorded credential against its evidence',
  ),
  'credential.revoke': a('write', 'credential', 'Revoke a credential (history kept)', {
    consequential: true,
  }),
  'team.read': a('read', 'team', 'Read teams and units, their members and status'),
  'team.manage': a('write', 'team', 'Create a team or unit; add and remove members'),
  'team.status': a('write', 'team', "Set or confirm a team's status"),
  'team.archive': a('write', 'team', 'Stand down or archive a team', { consequential: true }),
  'check_in.create': a('write', 'check_in', 'Check yourself in to an event by code or QR'),
  'check_in.end': a('write', 'check_in', 'Check yourself out'),
  'check_in.read': a('read', 'check_in', 'Read who is checked in, on which team, since when'),
  'check_in.manage': a(
    'write',
    'check_in',
    'Check another person in or out (staging, net control)',
  ),
  'device.register': a('write', 'field_device', 'Register this app install'),
  'device.read': a('read', 'field_device', 'Read registered app installs'),
  'device.wipe': a('admin', 'field_device', "Request a remote wipe of the app's data", {
    consequential: true,
  }),
  'position.record': a('write', 'position', 'Report your position while checked in'),
  'position.read': a('read', 'position', 'See live positions (dispatch and safety roles)', {
    explicit: true,
  }),
  'parcel.read': a('read', 'parcel', 'Read parcel outlines and addresses of record'),
  'parcel.import': a('admin', 'parcel', "Load or replace the tenant's parcel data", {
    consequential: true,
  }),
  // Layer 4 task B: missions, assignments, hazards, messages, safety, logs, reminders (F09),
  // badges, field records and sync (MIS-01–04, FR-02/04/06/07/09/13, DSP-06/07/10/11, FL:FR-*).
  'mission.read': a('read', 'mission', 'Read missions, their timeline and assignments'),
  'mission.create': a('write', 'mission', 'Create a mission (draft or intake save; CALL-01)'),
  'mission.update': a('write', 'mission', "Update a mission's summary, location and links"),
  'mission.narrative': a('write', 'mission', 'Add a narrative entry or an amendment by role'),
  'mission.transition': a(
    'write',
    'mission',
    'Open, en route, on scene, cleared (the allowed graph)',
  ),
  'mission.priority': a('write', 'mission', 'Change priority with a reason', {
    consequential: true,
  }),
  'mission.lock': a('write', 'mission', 'Lock or unlock a mission against edits'),
  // Layer 5 (SEC-12, ADR-0038): the platform holds only an opaque pointer to the CJIS enclave.
  // Both are explicit: no wildcard grant ('*', 'mission.*') ever carries them.
  'mission.cji.link': a(
    'write',
    'mission',
    'Link a mission to the CJIS enclave (law-enforcement involvement)',
    { consequential: true, explicit: true },
  ),
  'mission.cji.open': a(
    'read',
    'mission',
    'See the enclave reference and open the mission in the CJIS enclave',
    { explicit: true },
  ),
  'mission.cancel': a('write', 'mission', 'Cancel a mission with a reason', {
    consequential: true,
  }),
  'mission.close': a('write', 'mission', 'Close a mission with its disposition', {
    consequential: true,
  }),
  'mission.reopen': a('write', 'mission', 'Reopen a closed mission with a reason', {
    consequential: true,
  }),
  'mission.person.read': a(
    'read',
    'mission_person',
    'Read people involved (restricted details by category)',
  ),
  'mission.person.edit': a('write', 'mission_person', 'Add, change or remove a person involved'),
  'mission.media.read': a(
    'read',
    'mission_media',
    'Read media references and download through the authorized route',
  ),
  'mission.media.add': a('write', 'mission_media', 'Attach or remove a media reference'),
  'assignment.read': a('read', 'assignment', 'Read assignments and their history'),
  'assignment.create': a('write', 'assignment', 'Assign a person or team to a mission'),
  'assignment.override': a('write', 'assignment', 'Assign despite a conflict, with a reason', {
    consequential: true,
  }),
  'assignment.dispatch': a('write', 'assignment', 'Dispatch an assignment through a method'),
  'assignment.acknowledge': a('write', 'assignment', 'Acknowledge or decline your assignment'),
  'assignment.status': a('write', 'assignment', 'Record en route, on scene or cleared'),
  'assignment.release': a('write', 'assignment', 'Release a resource with a reason', {
    consequential: true,
  }),
  'dispatch.read': a('read', 'dispatch', 'The board: teams, work queue, suggestions, replay'),
  'stream.read': a('read', 'stream', 'Live updates (Server-Sent Events)'),
  'hazard.read': a('read', 'hazard', 'Read hazards (restricted details by category)'),
  'hazard.report': a('write', 'hazard', 'Report a hazard or correct one'),
  'hazard.confirm': a('write', 'hazard', 'Confirm a hazard or accept an AI suggestion'),
  'hazard.clear': a('write', 'hazard', 'Clear a hazard with a reason', { consequential: true }),
  'field_message.send': a('write', 'field_message', 'Message a person, team, agency or area'),
  'field_message.read': a('read', 'field_message', 'Read messages and receipts'),
  'field_message.receipt': a('write', 'field_message', 'Record delivered, read or acknowledged'),
  'safety_alert.raise': a('write', 'safety_alert', 'Raise a help alert'),
  'safety_alert.read': a('read', 'safety_alert', 'Read safety alerts'),
  'safety_alert.acknowledge': a('write', 'safety_alert', 'Acknowledge or escalate an alert'),
  'safety_alert.resolve': a('write', 'safety_alert', 'Resolve an alert with its resolution', {
    consequential: true,
  }),
  'comms_log.read': a('read', 'comms_log', 'Read the communications log (ICS 309)'),
  'comms_log.write': a('write', 'comms_log', 'Log traffic heard on a net (net control)'),
  'activity.read': a('read', 'activity_entry', 'Read activity logs (ICS 214)'),
  'activity.write': a('write', 'activity_entry', 'Add an activity note'),
  'significant_event.read': a('read', 'significant_event', 'Read the significant events log'),
  'significant_event.write': a('write', 'significant_event', 'Add a significant event'),
  'reminder.read': a('read', 'reminder', 'Read reminders (F09)'),
  'reminder.manage': a('write', 'reminder', 'Create, snooze, reset or cancel a reminder'),
  'reminder.acknowledge': a('write', 'reminder', 'Acknowledge a reminder'),
  'reminder.complete': a('write', 'reminder', 'Complete a reminder against a persisted update'),
  'badge.read': a('read', 'badge', 'Read badges and their history'),
  'badge.generate': a('write', 'badge', 'Generate or replace a badge'),
  'badge.print': a('write', 'badge', 'Print requested, confirmed, failed or handed out'),
  'badge.revoke': a('write', 'badge', 'Revoke a badge at once', { consequential: true }),
  'badge.verify': a('read', 'badge', 'Verify a badge at a checkpoint (name, agency, label only)'),
  'service_log.write': a('write', 'service_log', 'One-tap service counters'),
  'service_log.read': a('read', 'service_log', 'Read service counts'),
  'job_aid.read': a('read', 'job_aid', 'Read job aids for your role'),
  'job_aid.edit': a('write', 'job_aid', 'Draft or change a job aid'),
  'job_aid.approve': a('admin', 'job_aid', 'Approve a job aid for the county', {
    consequential: true,
  }),
  'search_mark.read': a('read', 'search_mark', 'Read search marks and the searched layer'),
  'search_mark.write': a('write', 'search_mark', 'Record a search mark'),
  'placard.read': a('read', 'placard', 'Read posted placards'),
  'placard.write': a('write', 'placard', 'Record a posted placard'),
  'road_status.read': a('read', 'road_status', 'Read road status'),
  'road_status.write': a('write', 'road_status', 'Set road status'),
  'debris_ticket.read': a('read', 'debris_ticket', 'Read debris load tickets'),
  'debris_ticket.write': a('write', 'debris_ticket', 'Record a debris load ticket'),
  'inspection.read': a('read', 'inspection', 'Read inspections (aggregate illness counts only)'),
  'inspection.write': a('write', 'inspection', 'Record an inspection'),
  'pet_intake.read': a('read', 'pet_intake', 'Read pet intake and matches'),
  'pet_intake.write': a('write', 'pet_intake', 'Record a pet intake or match'),
  'walkthrough.read': a('read', 'site_walkthrough', 'Read facility walk-throughs'),
  'walkthrough.write': a('write', 'site_walkthrough', 'Record a facility walk-through'),
  'right_of_entry.read': a('read', 'right_of_entry', 'Read right-of-entry records (restricted)'),
  'right_of_entry.write': a('write', 'right_of_entry', 'Record a signed right of entry or release'),
  'volunteer_registration.read': a('read', 'volunteer_registration', 'Read walk-up registrations'),
  'volunteer_registration.write': a(
    'write',
    'volunteer_registration',
    'Register a walk-up volunteer',
  ),
  'stock.read': a('read', 'stock_item', 'Read stock and movements'),
  'stock.write': a('write', 'stock_item', 'Record stock received, issued, counted or requested'),
  'interpreter.request': a('write', 'interpreter_request', 'Request an interpreter'),
  'interpreter.respond': a(
    'write',
    'interpreter_request',
    'Accept, join or finish an interpreter request',
  ),
  'interpreter.read': a('read', 'interpreter_request', 'Read the interpreter queue'),
  'child_check_in.read': a('read', 'child_check_in', 'Read child check-ins (restricted)'),
  'child_check_in.write': a('write', 'child_check_in', 'Check a child in or out'),
  'canvass_visit.read': a('read', 'canvass_visit', 'Read canvass visits'),
  'canvass_visit.write': a('write', 'canvass_visit', 'Record a canvass visit'),
  'shelter_stay.read': a('read', 'shelter_stay', 'Read shelter registrations and census'),
  'shelter_stay.write': a('write', 'shelter_stay', 'Register, assign a cot, check out'),
  'shelter_incident.read': a('read', 'shelter_incident', 'Read the quiet incident log'),
  'shelter_incident.write': a('write', 'shelter_incident', 'Add to the quiet incident log'),
  'health_note.read': a(
    'read',
    'health_note',
    'Read health notes (health roles only; every view audited)',
  ),
  'health_note.write': a('write', 'health_note', 'Write a health note or request'),
  'field.sync': a('read', 'change_feed', 'Pull changes for your scopes since a cursor'),
  'field.command': a('write', 'client_command', 'Apply a batch of field commands'),
  'field.area': a('read', 'area_package', 'Download the area package for offline work'),
  'field.photo': a(
    'write',
    'photo',
    'Take photos in the field and attach them to a field record (FLD-07)',
  ),
  'assessment.record': a(
    'write',
    'field_assessment',
    'Record a field damage assessment at a property (FLD-08, FLD-10)',
  ),
  'assessment.read': a('read', 'field_assessment', 'Read field damage assessments'),
  'assessment.approve': a(
    'write',
    'field_assessment',
    'Accept or reject a field assessment; acceptance verifies the linked report',
  ),
  'assessment.export': a('export', 'report', 'Export assessments as CSV or GeoJSON (SCL-13)', {
    consequential: true,
  }),
  'route.import': a('admin', 'mission', 'Import routes from GeoJSON or CSV'),

  // Layer 6 (ADR-0039, SCL-09): public reference data pulled from free federal sources or imported.
  'refdata.read': a(
    'read',
    'refdata_snapshot',
    'See reference data sources, snapshots and imports',
  ),
  'refdata.manage': a(
    'admin',
    'refdata_snapshot',
    'Pull reference data now, and upload, map and apply reference data files',
  ),

  // Layer 6 declaration data (DCL:DEC-07/08/10/14/16/17, FL-17).
  'declaration.read': a(
    'read',
    'declaration',
    'See the declaration view: verified totals, outages, casualties, public damage, the clock',
  ),
  'declaration.write': a(
    'write',
    'declaration',
    'Enter the incident period, requested areas and the Box 8 and 9 drafts',
  ),
  'outage.write': a('write', 'outage', 'Log, update and confirm infrastructure outages'),
  'casualty.record': a(
    'write',
    'casualty_count',
    'Enter official injured, missing and deceased counts from an official source (DEC-08)',
    { explicit: true },
  ),
  'pa_site.write': a(
    'write',
    'pa_site',
    'Record public damage sites with category, cost and flags',
  ),
  'declaration.export': a(
    'export',
    'declaration',
    'Export the IDA package (PDF, CSV, GeoJSON): counts and generalized places, no personal details',
  ),

  // Layer 6 metrics and equity (BRD:F14, MET, EQ-11/12/13, CON-07).
  'metric.read': a('read', 'metric', 'See metrics from the shared definitions, with their trends'),
  'metric.export': a('export', 'metric', 'Export metrics as CSV or PDF (counts only)'),
  'equity.read': a(
    'read',
    'equity',
    'See the equity dashboard: report and need rates by tract and group, small numbers hidden',
  ),
  'equity.act': a(
    'write',
    'equity',
    'Acknowledge an equity or coverage alert and record the outreach taken',
  ),

  // Layer 6 joint damage assessment (FL:FR-10) and the state liaison's view (DCL:DEC-13).
  'joint_assessment.read': a(
    'read',
    'joint_assessment',
    'See the joint assessment schedule and sample route: verified homes without personal details',
  ),
  'joint_assessment.plan': a(
    'write',
    'joint_assessment',
    'Schedule the joint assessment and draw its sample route',
  ),
  'joint_assessment.validate': a(
    'write',
    'joint_assessment',
    'Mark a sampled home validated, seen at a different degree, or not seen',
    { explicit: true },
  ),
  'shared_declaration.read': a(
    'read',
    'declaration',
    "See a county's declaration figures, de-identified, under its signed agreement with your tenant",
  ),

  // Layer 6 official reports (F15, RULE-10, A7): drafted, reviewed and issued by different people.
  'official_report.read': a(
    'read',
    'official_report',
    'See official reports, their sections and issued snapshots, and what changed since the last one',
  ),
  'official_report.draft': a(
    'write',
    'official_report',
    'Draft situation reports and briefings, edit their judgments and narrative, refresh their facts, draft amendments',
  ),
  'official_report.review': a(
    'write',
    'official_report',
    'Approve, or return with a note, a report someone else drafted',
  ),
  'official_report.issue': a(
    'admin',
    'official_report',
    'Issue a reviewed report someone else drafted; it is frozen and corrected only by amendment',
    { consequential: true, explicit: true },
  ),
  'official_report.export': a(
    'export',
    'official_report',
    'Export an issued official report as PDF or CSV, drawn from its frozen copy',
  ),

  // Layer 6 FEMA form mappings (DCL:DEC-12, DEC-15): changed without a release.
  'fema_mapping.read': a('read', 'fema_form_mapping', 'See FEMA form mappings and their versions'),
  'fema_mapping.write': a(
    'write',
    'fema_form_mapping',
    'Draft and edit a new version of a FEMA form mapping',
  ),
  'fema_mapping.activate': a(
    'admin',
    'fema_form_mapping',
    'Put a FEMA form mapping version in force for every export that follows',
    { consequential: true },
  ),
  // Layer 6 outbound integrations (SCL-09): keys and webhooks need a second administrator (ADM-05).
  'api_key.read': a(
    'read',
    'api_key',
    'See API keys: name, scopes, status, expiry, last use; never the key',
  ),
  'api_key.manage': a(
    'admin',
    'api_key',
    'Ask for, approve or decline (never your own), and revoke an API key',
    { consequential: true, explicit: true },
  ),
  'webhook.read': a('read', 'webhook', 'See webhooks and their deliveries; never the secret'),
  'webhook.manage': a(
    'admin',
    'webhook',
    'Ask for, approve or decline (never your own), and disable a webhook',
    { consequential: true, explicit: true },
  ),
} as const satisfies Record<string, ActionMeta>;

export type ActionKey = keyof typeof actions;

export function isActionKey(key: string): key is ActionKey {
  return Object.hasOwn(actions, key);
}

/** Does a grant pattern cover an action? '*' and 'family.*' are the only wildcards. */
export function actionMatches(pattern: string, action: string): boolean {
  if (pattern === action) return true;
  // An explicit action is granted only by name, never by a wildcard (DSP-08: positions).
  if ((actions as Record<string, ActionMeta>)[action]?.explicit) return false;
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const family = pattern.slice(0, -1); // keep the trailing dot
    return action.startsWith(family);
  }
  return false;
}

/** A7 / AC-12B: approving a finding the same person recorded. */
export const SELF_REVIEW_ACTIONS: readonly string[] = [
  'report.approve',
  'report.review',
  'report.verify',
  'report.set_degree',
  'assessment.approve',
  'finding.approve',
  // Official reports: the author neither reviews nor issues (A7); the database refuses it too.
  'official_report.review',
  'official_report.issue',
  // Joint assessment: nobody validates a home whose degree they set or assessed.
  'joint_assessment.validate',
];

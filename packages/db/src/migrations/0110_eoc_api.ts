/**
 * 0110 the state's read API and callbacks (CON-13, SCL-09; layer-8 plan §7).
 * API key scopes gain `eoc.read` (resource requests, significant events,
 * issued situation reports and ICS forms for an event) and
 * `resource_request.update` (a state system sets its tracking number and
 * the status of a request); webhooks and their deliveries gain the events
 * resource_request.submitted, resource_request.updated,
 * significant_event.created and ics_form.issued. Keys and webhooks keep
 * their second-administrator approval (0051).
 */
import { sql, type Kysely } from 'kysely';

const SCOPES = ['pda.read', 'eoc.read', 'resource_request.update'];
const EVENTS = [
  'official_report.issued',
  'export.ready',
  'resource_request.submitted',
  'resource_request.updated',
  'significant_event.created',
  'ics_form.issued',
];
const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(', ');

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table cg.api_key drop constraint if exists api_key_scopes_check;
    alter table cg.api_key add constraint api_key_scopes_check
      check (cardinality(scopes) between 1 and 8 and scopes <@ array[${sql.raw(list(SCOPES))}]::text[]);
    alter table cg.webhook drop constraint if exists webhook_events_check;
    alter table cg.webhook add constraint webhook_events_check
      check (cardinality(events) between 1 and 8 and events <@ array[${sql.raw(list(EVENTS))}]::text[]);
    alter table cg.webhook_delivery drop constraint if exists webhook_delivery_event_check;
    alter table cg.webhook_delivery add constraint webhook_delivery_event_check
      check (event in (${sql.raw(list(EVENTS))}));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table cg.api_key drop constraint if exists api_key_scopes_check;
    alter table cg.api_key add constraint api_key_scopes_check
      check (cardinality(scopes) between 1 and 8 and scopes <@ array['pda.read']::text[]);
    alter table cg.webhook drop constraint if exists webhook_events_check;
    alter table cg.webhook add constraint webhook_events_check
      check (cardinality(events) between 1 and 8 and events <@ array['official_report.issued', 'export.ready']::text[]);
    alter table cg.webhook_delivery drop constraint if exists webhook_delivery_event_check;
    alter table cg.webhook_delivery add constraint webhook_delivery_event_check
      check (event in ('official_report.issued', 'export.ready'));
  `.execute(db);
}

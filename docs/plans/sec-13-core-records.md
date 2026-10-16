# SEC-13: deleting the core records after their period (plan, not built)

Status: proposed 2026-10-16, waiting on the questions at the end. Nothing here is built yet.

## Why a plan first

Every other SEC-13 category is swept daily (`services/worker/src/jobs/retention.ts`):

- the short-lived categories;
- the 7-year communications, referrals, sharing and publications;
- field records, counted from the day their event closed;
- the field change feed.

The core records are different. Reports, needs, missions and their photos and free text are linked to about 40 tables and to object storage:

- **Reports** are referenced by: report_version, review_decision, correction_request, photo, need, consent, post_submission_answers, otp_challenge, message, share_grant, referral, mission, placard, right_of_entry, canvass_visit, field_assessment, damage_suggestion, shared_document and reference_code. Reports also point at each other through `supersedes` and `duplicate_of`.
- **Needs** are referenced by: need_event, share_grant, referral, mission and right_of_entry.
- **Missions** are referenced by: mission_event, mission_person, mission_media, assignment, hazard, field_message, significant_event, reminder, service_log, search_mark, right_of_entry, stock_movement, interpreter_request, canvass_visit and field_assessment.
- **Parties** (the resident's name and contact details) and **locations** (the address) are shared by several of these.
- **Photos** live as originals and derivatives in object storage, and FEMA packages copy some of them (`package_photo`).

Deleting these touches records that people outside the county may also hold: partners under sharing grants, and FEMA through packages already sent. It is irreversible. So the reading below is written down for a decision before any code.

## Proposed reading

1. **The clock is the event's close.**
   - A resident's report, needs and missions are kept for the `records` period after their event closes (7 years by default, tenant-configurable).
   - Photos follow the `photos` period, and words residents wrote follow the `free_text` period, both counted from the same day.
   - An open event's records never expire. This is the same rule as field records (migration 0081).
2. **Holds win.** A hold on the category, the event or the record (report, need or mission) keeps it and everything that belongs to it.
3. **The whole household record goes together.** For each expired report, these go in one transaction:
   - its versions, decisions, correction requests, answers, codes, messages, consents and AI records;
   - its photos, with their stored files deleted from object storage after the transaction commits;
   - its needs and their history;
   - its referrals and grants (partners are sent the existing "sharing recall" notice first);
   - the party and location, unless another record still uses them.

   Field records were already removed in their own sweep.

4. **Missions** go with their history once their event has expired, after the field records that point at them.
5. **What is kept**, unless you decide otherwise:
   - issued official reports and declaration figures, which are aggregates without personal details;
   - the audit trail, which follows its own 7-year category and cannot be cleared;
   - the deletion log, which counts what went and when, never what it said.
6. **Order:**
   1. leaves first;
   2. a record another kept record still points at stays until that record goes;
   3. batches per tenant per day, as the other sweeps do.

## Questions for Adam

1. Is the event's close the right day to count from, for records? The alternatives are the report's last change, or the end of the declaration's closeout.
2. Should issued official reports, declaration figures and FEMA package exports be kept beyond 7 years as county records? Or should they follow the county's own records schedule, set as its own category?
3. Should partners get the sharing-recall notice when a shared record expires? Their agreements already require them to delete what they hold.
4. Should anything be kept in de-identified form, such as counts per tract for later equity comparisons? Or does everything go?

## Tests the build will need

The tests will run on a county of their own, with:

- an event closed 8 years ago, another closed last year, and an open one;
- a held event;
- a held report;
- a report another kept report supersedes;
- a shared need with a partner grant;
- photos in an in-memory object store.

Then check that:

- exactly the expired, unheld household records go;
- their stored files are deleted;
- partners are recalled;
- the official reports and audit stay;
- the deletion log counts it all.

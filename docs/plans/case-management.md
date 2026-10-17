# Case management on the shared record

Plan for the work Adam put after layer 8 (decision 2026-10-15): the shared survivor record gains help received, a recovery plan, appointments and the hand-offs a survivor meets at a recovery centre and at day 30. Written 2026-10-17 before building; the status file is `case-management-status.md`.

## 1. Requirement IDs covered

| ID                     | Class | What this plan does with it                                                                                                                                      |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FL-13                  | Must  | Help received logged with source, type and dollar value; a duplication-of-benefits check before FEMA, SBA or other aid.                                          |
| FL-03                  | Must  | The shared record now holds help received, the recovery plan and appointments; each organization sees only the sections the survivor consented to. From partial. |
| FL:FR-18               | Must  | Caseworkers and disaster case managers: shared record, recovery plan with unmet needs, help received with dollar values, appointments by SMS, referrals.         |
| FL:FR-07               | Must  | County human services caseworkers share case management with NGOs.                                                                                               |
| FL:FR-12               | Must  | SBA representatives: the MARC queue and a warm hand-off from other tables.                                                                                       |
| FL:FR-27               | Must  | The long-term recovery group: the day-30 hand-off with every dollar of help already given; funds committed per household.                                        |
| NED-04, NED-05, SEC-05 | Must  | Minimum-field sharing still governs: a partner reads a case through a grant cut to its service, while consent stands.                                            |
| SEC-18, ADM-05         | Must  | Every read of a case is audited; dollar values are the `financial` category; nobody approves their own entries where approval exists.                            |

Named external case-management systems (NED-07, Section 21) stay deferred to the pilot; this plan is the case record inside the platform and its CSV and API, which those systems would read.

## 2. What already exists

- One shared record per report with sections, grants, consent per organization type and a projection (layer 3, ADR-0030); referrals with accept, decline and done (FL-10); legal aid's notes outside the record (FL:FR-23); documents a survivor shares with consent (FL-09); finding a record without the code (FL-02).
- The case manager, legal aid attorney and disability advocate templates; the `shared.read` action with data categories; the `financial` data category.
- Texts to a resident through the message pipeline with opt-in, templates and quiet hours (layer 2, BRD:FR-09.06); reminders with owners and due times.
- MARC sites and their recommendation (REC-09, CON-09); the scribe's "help given" section for a conversation note (FL-04).

## 3. Design

### 3.1 The case

`cg.case`: one per report (and so per household), opened by the county or by a partner holding a case grant; status open, handed_off, closed; the lead organization; opened and closed with a reason. A case is the frame the sections below hang on; it never copies the report.

### 3.2 Help received (FL-13)

`cg.help_received`: case, source (FEMA IA, SBA loan, insurance, NGO grant, goods, services, other) with the giving organization's name or tenant, type, description, **dollar value** (nullable for services without one), given on, recorded by whom and for which organization. Append-only: an entry is voided with a reason, never edited or deleted, so the duplication-of-benefits picture is a record (RULE-10). A **duplication check** lists, for a case, every dollar by source and type and totals them, so a case manager sees before FEMA, SBA or a grant decides.

### 3.3 Recovery plan (FL:FR-18)

`cg.recovery_plan_item`: case, the unmet need (a need category or text), the organization that owns it, a due date, status open, in progress, met, dropped, with the referral it rides on when one exists. The plan is the list of what is still unmet.

### 3.4 Appointments by SMS (FL:FR-18)

`cg.appointment`: case, with which organization or table, at which place (a site or text), when, purpose, status scheduled, kept, missed, cancelled. Scheduling one queues a text to the survivor through the existing message pipeline (template `appointment`, English and Spanish, opt-in required, quiet hours respected), and a reminder the day before; the message ids are kept on the appointment. No appointment detail goes to a partner the survivor has not consented to.

### 3.5 The recovery centre queue and warm hand-offs (FL:FR-12)

`cg.marc_visit`: a survivor's visit to a MARC site: arrived, the tables to see (each a partner organization or a county desk), the current table, and each hand-off (from, to, when, by whom, a one-line "why"). A table's queue lists the visits waiting for it; "hand to the next table" moves the visit and tells the next table, so the survivor does not retell her story. The SBA representative is a partner role with the queue for its table and the consented sections only.

### 3.6 The day-30 hand-off (FL:FR-27)

A daily worker job: cases opened 30 days ago (or earlier) with no hand-off yet, where the survivor consented to the `long_term_recovery` organization type, get a share grant for the county's long-term recovery partner (service `case_management`) and a referral with the case attached; the case is marked handed off and the lead organization changes. The long-term recovery group reads every dollar of help already given (3.2). Funds committed per household are help-received entries of source `ltrg_commitment`. Without consent, no hand-off: the case stays with the county and the caseworker is told why.

### 3.7 Sharing

A new sharing service **`case_management`** with sections `name`, `contact`, `contact_preference`, `address_exact`, `household_band`, `need`, and the new sections **`help_received`** (category `financial`), **`recovery_plan`** (basic) and **`appointments`** (contact). The county's agreement with a partner names the service and the data categories; the survivor's consent for the organization type (`case_management`, `long_term_recovery`, `sba`) is asked on the shared record the way the others are. The resident-facing wording for the three new organization types is proposed in `packages/intake` in English and Spanish and flagged for Adam.

### 3.8 Roles

- `case_manager` (partner) gains `case.read`, `case.write`, `help_received.write`, `appointment.write`, `marc.queue`.
- New `county_caseworker` (county human services, FL:FR-07): the same, plus opening and closing cases, the duplication check for any case, and the day-30 view.
- New `sba_representative` (partner): `marc.queue` for its table, `case.read` of consented sections, `help_received.write` for SBA loans.
- New `long_term_recovery_manager` (partner): cases handed off to it, `help_received.write` for commitments.
- Every case read is audited with the sections read (SEC-18); dollar values need the `financial` data category on the role and the agreement.

### 3.9 Screens

- Console **Case work**: the caseworker's cases, one case with its sections (help received with the duplication total, the plan, appointments, referrals, documents, hand-offs), open and close, the day-30 list.
- Console **Recovery centre**: a MARC site's tables and queues, check a survivor in, hand to the next table.
- The field app's shared-record screens show help received and appointments read-only (a later task).

## 4. Tasks

| Task | What                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| CM-A | Tables, actions, templates; the case, help received with the duplication check, the recovery plan; API and database tests; seed |
| CM-B | Appointments with the SMS and the reminder; the MARC visit, queues and warm hand-off; tests                                     |
| CM-C | The `case_management` sharing service and sections, consent organization types with proposed wording, the day-30 job; tests     |
| CM-D | Console screens Case work and Recovery centre; navigation; scan with axe; accessibility records                                 |
| CM-E | Records: traceability (`trace-case.json`), known limitations, README, the report                                                |

## 5. Readings taken in favour of privacy and safety (flagged for Adam)

1. **Dollar values are financial data:** read only by roles and agreements that name the `financial` category, audited on every read.
2. **No hand-off without consent:** the day-30 hand-off needs the survivor's consent for the long-term recovery group; otherwise the case stays with the county.
3. **A MARC table sees the consented sections only;** the queue itself carries a first name or the reference code and the tables to see, nothing more.
4. **Help received is append-only;** a wrong entry is voided with a reason and stays visible as voided.
5. **Appointment texts carry the time and place, never the purpose** in a text that may be read by others on the phone.

## 6. Questions for Adam (defaults in force until answered)

1. **Consent wording** for the three new organization types (case management, long-term recovery group, SBA): the proposed English and Spanish texts in `packages/intake` stand until replaced.
2. **Is SBA a partner organization in the platform** (a tenant with an agreement), or a table the county staffs? Default: a partner tenant with the `sba_representative` role.
3. **The day-30 rule:** 30 days from the case opening (default) or from the event's start?
4. **Which NGO case-management systems to read the CSV and API first** (Section 21): still deferred to the pilot.

# Layer 8 plan: ICS forms and EOC functions

**Draft for Adam's review, written 2026-10-16. Nothing in it is built.** CLAUDE.md rule 4 starts a layer only after the previous one passes its acceptance cases and gates and is approved. Layer 7's report (`docs/plans/layer-7-report.md`) and the follow-ups since it (`docs/plans/layer-7-status.md`, L1–L85) are waiting for Adam's approval. This plan is ready for that approval, with its questions in §13.

Layer 8 lets a county run its EOC without WebEOC or a similar system for the functions CON-13 names. Those are resource requests to the state, situation reports and briefings, and the significant events log with its ICS forms. It also adds a briefing display for the EOC wall (CON-11) and labelled live conditions from outside feeds (CON-14). Most of the records already exist from layers 4 to 7. Layer 8 adds the state resource request workflow, the forms as accessible documents, the wall display, the feeds, and a way for a state system to receive all of it.

## 1. Requirement IDs covered

| Area                         | IDs                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EOC functions                | **CON-13** (Must): resource requests to the state with ICS 213 RR fields, exportable to the state's system; ICS 201-style briefings and situation reports; the significant events log with ICS 214 activity logs and ICS 213 general messages; every record to PDF and CSV; an API a state system that still runs WebEOC can receive them from |
| Wall display                 | **CON-11** (Should): briefing mode with large type, auto-refresh and no personal details                                                                                                                                                                                                                                                       |
| Live conditions              | **CON-14** (Must): utility outages and state DOT road closures where available; Waze for Cities both ways; routing and travel times; staff entry as fallback and override; each labelled with its source and age                                                                                                                               |
| Finished from earlier layers | DSP-10 (the ICS 309 log as a document), DSP-11 (ICS 214 as a document), CON-03 (live closures and outages on the situation map), CON-06 (situation reports in the ICS 201 frame), FL:FR-05 (Waze: the receive side), SCL-09 (webhooks and keys for the new records)                                                                            |
| Accessibility and exports    | NFR-12 (every form a tagged PDF/UA, checked by veraPDF), ACC-49, GATE-03 (every new screen), F14                                                                                                                                                                                                                                               |
| Cross-cutting                | FR-00.* (save, versions, idempotency), ADM-05 (approvals by a second person), SEC-11 (dictionary), SEC-13 (retention of the new records), SEC-18 (exports audited)                                                                                                                                                                             |

## 2. What already exists

- **Significant events log** (`cg.significant_event`, layer 4): assignments, status changes, messages, check-ins and alerts write to it (DSP-11). Staff add entries on the field operations screen.
- **ICS 214 activity entries** (`cg.activity_entry`): per person and team, with time and kind.
- **ICS 309 communications log** (`cg.comms_log`, DSP-10): net control's status and positions heard.
- **Messages to the field** (`cg.field_message`): to a person, team, agency, area or event, with receipts.
- **Situation reports** (`cg.official_report`, layer 6): drafted from frozen facts, reviewed, issued and amended. AI drafting with sources was added in layer 7.
- **Supply requests from sites** (FL:FR-21/22): the warehouse fills them locally. A state request is the step after that.
- **Outages** (`cg.outage`, staff and utility reports; `cg.ref_power_outage` from DOE/ORNL's public ODIN feed, county level, as suggestions a person confirms) and **road closures** (blocked-road hazards and crew reports) are on the situation map. **Waze CIFS** publishes the county's closures (FL:FR-05, off until the county enrols).
- **Keys and webhooks** (SCL-09): API keys with scopes and signed webhooks, each approved by a second administrator.
- **The tagged PDF engine** (ADR-0040) and **versioned form mappings** (the FEMA mappings in L6-F2) can hold ICS form editions too.

## 3. Resource requests to the state (ICS 213 RR)

- **Record:** `cg.resource_request`. It carries the ICS 213 RR blocks:
  - incident name and number; date and time; the county's request number;
  - each line of the order: quantity, kind, type, detailed description, requested and estimated arrival, cost;
  - delivery or reporting location; suitable substitutes and suggested sources; requested by (name and position); priority (urgent, high, low);
  - approvals; logistics order number; supplier; notes; order placed by (supply unit or procurement); finance's reply.

  The block numbers follow FEMA's ICS 213 RR. The current edition must be checked against fema.gov before release, which this build environment cannot reach, the same as DCL:DEC-12.

- **Flow:**
  1. Draft. A site's supply request can be raised to a state request, keeping the link.
  2. Submit with a reason.
  3. A second person approves it as section chief (ADM-05: never the requester).
  4. Logistics places it: with the state, which exports the form and sends it through the API or webhook, or locally.
  5. The state's mission or tracking number is recorded, typed by staff or set by the state system through the API.
  6. Status runs through en route and received, or ends cancelled, with the arrival time.
  7. Received resources can become roster teams or warehouse stock in one step.

  Every step is versioned, confirmed and audited.

- **Finance:** the cost and finance's reply stay on the request. A county threshold above which finance must reply before it is placed is a configurable default (off).

## 4. ICS forms as documents

| Form                                                                | Built from                                                                                                                                                                                                                         | Scope                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| ICS 201 Incident Briefing                                           | Event, objectives, current and planned actions, current organization (roster positions), resource summary (teams and state requests with ordered, ETA and arrived), the latest issued situation report, a sketch of the event area | Event, operational period |
| ICS 202 Incident Objectives (only to feed the 201 and the briefing) | `cg.incident_objective` per operational period, entered by planning                                                                                                                                                                | Operational period        |
| ICS 213 General Message                                             | A general message (to, from, subject, message, approved by, reply), new on top of messages to the field                                                                                                                            | One message               |
| ICS 213 RR Resource Request                                         | §3                                                                                                                                                                                                                                 | One request               |
| ICS 214 Activity Log                                                | Activity entries of a person or a team in the period, resources assigned, prepared by                                                                                                                                              | Person or team, period    |
| ICS 309 Communications Log                                          | The comms log of the period, by operator                                                                                                                                                                                           | Operator, period          |

- **Each form** is a tagged PDF (PDF/UA-1, veraPDF in CI, like every other PDF) and a CSV. Both come from one form model, with the edition named on the form.
- **Editions:** field placement lives in a versioned form mapping, as the FEMA forms do (L6-F2). A new FEMA edition is a mapping change, not code.
- **Sketch:** the event area, sites and damage clusters are drawn as vectors in the PDF from the data the map uses. Where there is no geometry, the 201 says so and lists the places in a table instead.
- **People on forms:** names and ICS positions of staff, never residents. Personal details of residents never appear on any ICS form.
- **Exports:** every export is audited with its scope (SEC-18).

## 5. Briefing display (CON-11)

- A full-screen briefing view per event, for the EOC wall. It shows:
  - damage counts by degree;
  - shelters open with occupancy;
  - open needs;
  - missions by state;
  - the significant events of the last hours;
  - live conditions with their source and age;
  - the current objectives.
- Large type, high contrast and an auto-refresh (60 s, configurable). Updates are announced politely, and motion is reduced. **Aggregates and place names only:** no resident, no address of a home, no staff phone number.
- **Who sees it:** a display account with only `briefing.read`, signed in on the wall's device. A shared screen therefore never holds a staff member's session (question 4).

## 6. Live conditions (CON-14)

Every item is shown with its **source and age**. Stale items say so, and staff entries override a feed for their area until they lapse. Feeds follow the reference-data pattern (ADR-0039): allowed hosts only, recorded synthetic responses for development and CI, and file import as the fallback.

| Source                   | Plan                                                                                                                                                                                                   | Cost                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Utility outages          | Already in: ODIN's county-level outages as suggestions, and staff and utility reports. Add county-configured utility feeds where a utility publishes one.                                              | Free sources only           |
| State DOT road closures  | A connector for USDOT's **WZDx** (Work Zone Data Exchange), the open standard most DOTs publish, plus a state 511 feed where it is free. Configured per state.                                         | Free                        |
| Waze for Cities          | Publishing closures is built. Add the **receive** side (alerts and jams from the partner feed), off until the county enrols.                                                                           | Free to government partners |
| Routing and travel times | **Self-hosted routing (OSRM or Valhalla) from the same OpenStreetMap extract as the tiles**, in a container, as the default. Google Maps Platform only if Adam approves the paid service (question 2). | Free (self-hosted)          |
| Staff entry              | Already in: closures, hazards and outages entered by staff, now marked as the override.                                                                                                                | —                           |

## 7. Receiving the records in a state system (CON-13)

- **Read API** with API keys, as the GIS feature service uses, under a new scope `eoc.read`: resource requests, significant events, issued situation reports and ICS forms (PDF or JSON), for a given event and period. Same key approval and audit as the feature service (SCL-09).
- **Webhooks:** new events `resource_request.submitted`, `resource_request.updated`, `significant_event.created` and `ics_form.issued`, next to `official_report.issued`. Each is signed (Standard Webhooks) and retried.
- **State callbacks:** a state system may set its mission or tracking number and the status of a resource request, through a key with scope `resource_request.update`. That key is approved by a second administrator.
- **Direct writes into a state's WebEOC board** need that state's account and board design. They are an adapter per state on request, not release 1 (question 3).

## 8. Data model (migrations 0106 onward; every column in the dictionary, RLS on every tenant table)

- `cg.resource_request`, `cg.resource_request_line` and `cg.resource_request_step`. The steps are the history: who, when, reason and state number.
- `cg.incident_objective`: operational period, objective, owner position, status.
- `cg.general_message` (ICS 213): to, from, subject, body, approved by, reply, replied by. It can also be sent to the field as a field message.
- `cg.ics_form_mapping`: versioned per form and edition, the same shape as the FEMA mappings. `cg.ics_form_issue` records each issued form with its hash, like official report snapshots.
- `cg.live_condition`: source, kind, geometry, severity, starts, ends, as of, source reference, staff override. `cg.live_source` holds per-county feed configuration.
- Retention (SEC-13): the default 7 years. Resource requests and ICS forms are public records and kept with the event.

## 9. APIs (staff unless marked; versioned, idempotent and audited)

| Path                   | What                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `/resource-requests`   | List, draft, edit, submit, approve, place, status, cancel, receive; lines; raise from a supply request |
| `/incident-objectives` | Per operational period                                                                                 |
| `/general-messages`    | Draft, approve, send, reply                                                                            |
| `/ics-forms/:form`     | Preview (JSON), issue, PDF, CSV for a scope; mappings and their versions                               |
| `/briefing/:event`     | The display's aggregate payload (display role)                                                         |
| `/live-conditions`     | List with source and age; staff override; sources and their health                                     |
| `/api/eoc/...` (keys)  | The read API in §7, and state callbacks on resource requests                                           |

## 10. Screens and roles

- **Resource requests:** a list by state and priority, the 213 RR form, approval and placing, and the state's number and status.
- **ICS forms:** pick a form and scope, preview it, issue it, and download the PDF and CSV.
- **Objectives:** per operational period.
- **General messages:** with the reply.
- **Briefing display:** full screen.
- **Live conditions:** a list and a map layer, with the sources' health.
- **Roles:** new actions `resource_request.*`, `ics_form.*`, `incident_objective.*`, `general_message.*`, `briefing.read` and `live_condition.*`. Their template defaults:
  - the county EM director and planning lead write objectives and issue the 201;
  - logistics places requests, and a section chief approves them;
  - every staff role reads the significant events log;
  - the display role reads only the briefing.

## 11. Deferred, with reasons

| What                                                                          | Why                                          | When                                                              |
| ----------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Google Maps Platform routing and travel times                                 | Paid service                                 | Only if Adam approves (question 2); self-hosted routing meanwhile |
| Writing into a state's WebEOC board                                           | Needs the state's account and board design   | Per state, on request (question 3)                                |
| Paid outage aggregators                                                       | Paid                                         | Ask Adam if the free sources fall short                           |
| ICS forms beyond 201, 202, 213, 213 RR, 214 and 309 (for example 204 and 205) | CON-13 names these; others follow on request | After the pilot                                                   |

## 12. Readings taken in favour of privacy and safety (flagged for Adam)

1. **The wall display shows aggregates and place names only.** That means no resident, no home address and no staff contact details, because a wall screen is seen by everyone in the room and by visitors.
2. **ICS forms carry staff names and positions, never residents.** A resident need reaches a 213 RR only as counts ("cots, 120"), never as a household.
3. **Live conditions from Waze and DOT feeds are shown with their source and age, and never override a staff entry.** Staff know the ground, and a stale feed must not reopen a road they closed.
4. **A state system gets only what a key's scope allows,** with the same second-administrator approval and audit as the feature service.

## 13. Questions for Adam

1. **Approve layer 7** (`docs/plans/layer-7-report.md` and the follow-ups in `layer-7-status.md`) so layer 8 can start.
2. **Routing:** self-hosted routing from OpenStreetMap (free, recommended), or Google Maps Platform (paid)?
3. **State systems:** at release, the read API and webhooks for the state to pull from (recommended). Direct WebEOC writes would come per state later. Which state is first?
4. **Wall display:** a display account signed in on the wall's device (recommended), or a time-limited display link?
5. **Resource request approvals:** a second person approves as section chief (recommended default). Does finance have to reply before an order is placed, and above what cost?
6. **DOT feeds:** which state DOT feed should come first (WZDx or 511)?

## 14. Tests and gates

- **Unit:** form models from fixed data (201, 202, 213, 213 RR, 214, 309); WZDx and Waze feed parsing; the briefing aggregate keeps out personal fields.
- **Database:** the resource request flow (no self-approval, versions, state callbacks by scope); form issue snapshots and hashes; live-condition overrides and staleness; retention.
- **Integration:** a request from draft to received with the state's number set by the API; webhooks delivered and signed.
- **e2e with axe:** resource requests; ICS forms (preview, issue, download); the briefing display at wall size and at 320 px; live conditions.
- **veraPDF:** every form's sample PDF in CI (NFR-12).
- **Gates:** GATE-03 (every new screen), GATE-04 (permissions on every route), GATE-07 (form totals equal the screens'), GATE-09 (restore covers the new tables).

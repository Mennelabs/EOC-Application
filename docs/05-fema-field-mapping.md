# FEMA field mapping

Every field on FEMA's damage assessment forms maps to a data element, so the declaration package (Section 20) can be generated without retyping. Mapping found nine kinds of fields the product did not yet capture; they are added as DEC-17 below. No state-specific mapping is needed for the first pilot.

## Sources mapped

FEMA publishes its current forms through fema.gov/pda, which could not be downloaded here. The mapping uses FEMA's own IA damage assessment checklist and PDA Guide, plus state copies of the FEMA street sheet, tick sheet, summary sheet and narrative report. Before build, compare against the forms on fema.gov/pda and update the versioned mapping (DEC-15).

- [FEMA IA Initial Damage Assessment checklist (2021)](https://www.fema.gov/sites/default/files/documents/fema_ia-ida-checklist_05-18-21.pdf)
- [FEMA Preliminary Damage Assessment Guide (July 2025)](https://www.fema.gov/sites/default/files/documents/fema_rd_pda-guide_07012025.pdf)
- [Kentucky EM: FEMA street, summary, tick sheet and narrative instructions](https://kyem.ky.gov/recovery/Documents/IA%20PDA%20for%20551%20Form.pdf)
- [Ohio EMA IA street sheet](https://dam.assets.ohio.gov/image/upload/ema.ohio.gov/Documents/DAToolbox/Downloads/Tab-A-Individual-Assistance-Damage-Assessment.pdf)
- [Pennsylvania IA Form 1 definitions](https://susqco.com/getmedia/e080891a-711b-47c1-bbf2-7a0f2e17ccde/IA-Form-1-Definitions.pdf)
- [New Jersey PDA form (IA and PA)](https://nj.gov/njoem/programs/pdf/20240311_PDA_Form.pdf)
- [Completing FEMA Form 010-0-13](https://www.fema.gov/sites/default/files/documents/completing-fema-form_010-0-13.pdf)

## Per-home fields (IA street sheet and IDA damage inventory)

| FEMA field | Data element (original D05 unless noted) | Captured by | Status |
| --- | --- | --- | --- |
| Address (street, apt/condo, complex, mobile home park) | Address components, unit, landmarks, coordinates (D02 location, FR-03.01) | Resident intake; field parcel snap (FLD-04) | Covered |
| Degree of damage: affected, minor, major, destroyed | Severity, set by reviewer only (DEC-02) | Reviewer or field assessor | Covered |
| Inaccessible | Verification level "cannot verify" plus access reason | Field app "can't reach" (FLD-10) | Covered; add reason: private road or bridge vs public (DEC-17) |
| Structure type: single family, multi-family (units counted separately), manufactured/mobile home, apartment, condo, business | Structure type, units count | Intake home-type question; field app | Covered; add unit count for multi-family (DEC-17) |
| Occupancy: owner, renter | Occupancy | Intake | Covered |
| Primary residence (occupied more than six months a year) / secondary | Primary residence | Intake | Covered; use FEMA's six-month wording in the question |
| Insured for the peril: homeowners, renters, flood, condominium, manufactured home, sewer backup rider, other riders | Insurance (homeowners, renters, flood, none, unknown) | Intake insurance question | Partly covered; add condominium, manufactured home and sewer backup rider (DEC-17) |
| Low income | Not collected per home (NED-09) | Census ACS tract share | Covered as aggregate only; see decision below |
| Utilities out | Utilities (FR-10.04) | Intake; field app; outage feed | Covered at area level; add per-home flag (DEC-17) |
| Water depth: basement, first floor or living area, crawl space (feet and inches) | Flood depth | Intake bands; field app | Partly covered; add three locations with feet/inches in field app (DEC-17) |
| Cause / peril | Cause | Intake | Covered |
| Damaged components (roof, walls, floors, windows) | Roof/foundation observations, component notes | Intake picture choices; photos | Covered |
| Photographs of damage | Evidence (D08) | Resident and field photos | Covered |
| Date of assessment; assessor name and phone | Assessment date, assessor (FR-10.01) | Automatic from field app | Covered |
| Tribal: home owned by tribe or privately | Ownership type | Not captured | Add for tribal tenants (DEC-17) |

## Totals and summaries

| FEMA output | Built from | Status |
| --- | --- | --- |
| Summary sheet and tick sheet: counts by degree of damage, total damaged, insured and uninsured counts, percent insured, percent low income | Approved, verified records; low income from ACS | Covered (DEC-11) |
| Counts split owner, renter and secondary residence, per structure type; inaccessible totals | Approved records | Covered |
| Multi-family counted per unit | Unit count (DEC-17) | Needs the new unit field |
| Estimated loss in dollars | Estimated cost, flagged estimate vs verified (FR-10.05) | Covered |
| Evacuated, displaced, sheltered, injured, missing, deceased | Displacement answers; shelter census (FR-14); casualty counts from authorized staff only (DEC-08) | Covered |
| Disaster-related unemployment | Optional post-submission question (DEC-01) | Covered |
| Businesses and industrial units: count, size, employees affected, expected time out of work; major employers | Organization reports (ORG-01) | Partly covered; add business fields (DEC-17) |
| Special populations: elderly, disabled, children | ACS profile (DEC-06) plus consented access-needs counts | Covered as aggregates |
| Households without electricity, estimated restoration | Utility outage feed (CON-14) | Covered |

## Narrative report and community impacts

| FEMA narrative item | Built from |
| --- | --- |
| Source of the damage information | Automatic: channels and verification levels used |
| Event type, damage trends, areas of concentrated damage, remote areas, urban or rural | Map clusters and event record |
| Inaccessible areas and reasons; private roads or bridges blocking assessment | "Can't reach" records with reasons (DEC-17) |
| Sewer backup issues | Insurance rider and resident words, extracted by AI and confirmed |
| Utilities out with projected restoration | Outage log (DEC-07) |
| Mobile homes and mobile home parks | Structure type |
| Open shelters, maximum and current population; displaced households and where they stay | Shelter census (CON-16); displacement answers |
| Sufficiency of rental housing for displaced residents | Staff entry; HUD fair market rent reference |
| Local and VOAD activities and resources committed | Needs board and partner records (DEC-09) |
| Need for counseling | Count of emotional and spiritual care requests (contact log only) |
| Impact on special populations | ACS profile and consented access-needs counts |
| Fatalities and injuries | Authorized staff entry only |
| Agricultural impact; tax base; other factors | Staff entry |
| Prior declared and undeclared disasters; other federal agency activity | Staff entry |

The console drafts the narrative from these sources; a named person edits and approves it (RPT-01).

## Public Assistance (site sheet and PDA form)

| FEMA field | Data element | Status |
| --- | --- | --- |
| Applicant (county, municipality, agency) and contact | Tenant and organization records | Covered |
| Site location and description | Public damage site record (DEC-10) | Covered |
| Category of work A–G: debris, emergency protective measures, roads and bridges, water control, buildings and equipment, utilities, parks and other | Category | Covered |
| Estimated cost; percent work complete | Cost estimate; percent complete | Add percent complete (DEC-17) |
| Insured? (yes, no, unknown) | Insurance flag | Add (DEC-17) |
| Responsibility of another federal agency? (yes, no, unknown) | Other-agency flag | Add (DEC-17) |
| Debris quantity in cubic yards | Debris load tickets (FR-05) | Covered |
| Photos and supporting documentation | Evidence (D08) | Covered |

## Declaration request (Form 010-0-13)

| Box | Built from | Status |
| --- | --- | --- |
| 7: incident period and type | Event record | Covered (DEC-14) |
| 8: damage description, about 3,000 characters | Drafted from the narrative above | Covered |
| 9: resources committed, about 3,000 characters | Partner and county resource records | Covered |
| 10: joint PDA dates and areas | Joint assessment schedule (FR-10) | Covered |
| 11: areas and programs requested | Jurisdictions with verified damage | Covered; the state chooses programs |
| Enclosure A (IA) and Enclosure B (PA) data | IA and PA totals above | Covered |

## New requirement from the mapping

- **DEC-17 (Must)** Capture the fields FEMA asks for that the product did not yet have: units per multi-family building; condominium, manufactured home and sewer backup rider insurance types; per-home utilities out; flood depth at basement, first floor and crawl space in feet and inches (field app; residents keep simple bands); reason a home is inaccessible, including private road or bridge; business details (employees affected, expected time out of work); Public Assistance percent complete, insured, and other-federal-agency flags; and tribal ownership type for tribal tenants.

## Decisions

- **No state mapping for the first pilot.** All outputs follow FEMA's formats. If the pilot state asks for its own template, add it as an optional mapping (DEC-12).
- **Low income stays aggregate.** FEMA's street sheet has a per-home low-income box, but residents are never asked about income (NED-09). The package reports percent low income per tract from Census data and says so.

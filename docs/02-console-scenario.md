# Exercise WESTWIND: the staff console in a real event

This is a tabletop exercise, not a real event. An EF-3 tornado crosses western St. Charles County on a Saturday evening, and the console carries the response from the first report to the FEMA package. Every place name, person and number is invented for the exercise.

## The cast

Nine roles use the console during WESTWIND. Each has a different question, a different home screen and a different right to see resident details. The console is one product with role-based workspaces, not one screen for everyone.

| Role (exercise name) | The question they bring | Home workspace | Sees resident details? |
| --- | --- | --- | --- |
| County EM Director (Dana) | How bad is it, where, and do we need state and federal help? | Situational awareness: map, key counts, declaration clock | Aggregates; drills to a record when needed |
| Planning / GIS lead (Marcus) | What is the impact footprint and what changed since the last briefing? | Map layers, change log, sitrep builder | Locations, no contact details |
| Damage assessment coordinator (Priya) | Which reports are verified, and where do field teams go next? | Review queue, field team routing | Yes, for review |
| Mass care coordinator, ESF-6 (Luis) | Where do people sleep and eat tonight, and how many? | Mass care board: shelter, feeding, POD and MARC planning | Counts and needs; names only for shelter registration |
| Access and functional needs coordinator (Keisha) | Who needs power for medical equipment, accessible transport or language help? | AFN list, accessibility of every open site | Yes, restricted fields |
| COAD / VOAD chair (Jen) | Which volunteer groups take which jobs without doubling up? | Needs board: claim, assign, release | Consented fields only |
| NGO incident commander, e.g. Salvation Army EDS (Captain Ruth) | Where do my canteens go, what do I bring, how do I staff it? | Partner workspace: assigned needs, recommended stops and setup | Consented fields only |
| Public information officer (Tomás) | What do we tell people, in which languages, and where is help? | Messaging: where-help-is list, language mix, gaps | No |
| State liaison (SEMA), later FEMA validators | Is the damage real and verified, and what is in the package? | Read-only declaration view | No PII, per FEMA PDA guidance |

## The first 30 days at a glance

&#91;embedded content: Exercise WESTWIND · 5 phases × 4 role groups\]

Read down for time and across for who acts. The highlighted Day 1 alert is the turning point: it adds the two hardest-hit areas to the count before the declaration data is built.

## Hour by hour

Each step names what the console shows, the human decision, and the requirements it proves. The console recommends; a named person decides, and the record shows who.

### Saturday 6:42 pm: touchdown (T+0)

An EF-3 tornado tracks 11 miles west to east in about 20 minutes. The path crosses Willow Bend, a manufactured-home community; Cedar Ridge, a 312-unit apartment complex with many Spanish-speaking renters; Prairie Lakes, an owner-occupied subdivision; and a commercial strip. 18,400 utility customers lose power.

- **Console shows:** Dana opens event WESTWIND from a template. The NWS warning polygon and the utility outage area load as map layers. Intake goes live on web, SMS (DAMAGE / DAÑOS), phone and assisted channels.
- **Decision:** Tomás publishes the intake link and keyword in English and Spanish within 20 minutes.
- **Proves:** SCL-02, CHN-03, EQ-06.

### Saturday 10 pm: life safety and tonight's shelter (T+3h)

412 reports are in. 23 people answered yes to "Is anyone in danger right now?" and were shown 911 instructions. 96 households say they have nowhere to stay tonight.

- **Console shows:** a red danger layer for awareness only. It does not dispatch, because CAD and criminal-justice data stay outside the platform for now. The mass care board estimates about 240 people needing shelter (96 households × 2.5 people) and 17 households that depend on powered medical equipment.
- **Recommendation:** three shelter candidates from the facility registry, ranked with reasons:
  1. A high school gym: 14,000 sq ft (room for 350 at 40 sq ft per person), outside the outage area, ADA, showers and kitchen, 2.1 miles from where the need is concentrated. **Recommended.**
  2. A church fellowship hall near Cedar Ridge with a Spanish-language ministry: 2,800 sq ft, too small for overnight use. Suggested as a daytime reception and assisted-reporting point instead.
  3. A community center inside the outage area. **Not recommended:** no power, no generator.
- **Decision:** Luis accepts the gym. The Red Cross liaison confirms staffing. Keisha arranges accessible transport for the 17 power-dependent households first.
- **Proves:** INT-07, NED-01, REC-01 to REC-04, CON-03.

### Sunday 8 am: verify the damage (T+13h)

1,140 reports have arrived: 61% web, 24% SMS, 9% phone, 6% assisted. Duplicate checks merge them into 1,020 homes.

- **Console shows:** Priya's review queue, sorted by need first and AI severity second. 610 homes have usable photos for desktop review; 410 need a field visit.
- **Recommendation:** six field-team routes clustered by area. Routes avoid closed roads and put no-photo reports in high-need areas first.
- **Decision:** Priya sends four teams and keeps two in reserve. Reviewers set the official FEMA degree of damage; the AI suggestion sits beside each record.
- **Proves:** PHO-09 to PHO-15, DEC-02, DEC-03, CON-05.

### Sunday 9 am: the equity alert (T+14h)

The console compares reports with the number of structures inside the damage footprint.

- **Console shows:** Prairie Lakes has reports from 61% of its homes. Cedar Ridge has 22 reports for 312 units (7%). Willow Bend has 14 reports for about 190 homes (7%). Both are flagged as under-reporting, not as low damage.
- **Decision:** Tomás sends Spanish SMS and door hangers with a QR code. Keisha sends an assisted-reporting team with tablets to Willow Bend. Jen asks the church near Cedar Ridge to host a reporting table.
- **Result by 6 pm:** Willow Bend has 141 reports and Cedar Ridge 205. Without the alert, the two hardest-hit, lowest-income areas would have been undercounted in the declaration data.
- **Proves:** EQ-11, EQ-12, CHN-06, CHN-07, CON-07.

### Sunday noon: send the NGOs (T+17h)

610 households asked for food or water, 388 for tarps or cleanup, 31 mentioned pets, and 27 asked for someone to talk with.

- **Captain Ruth asks the partner workspace:** "Where should our two canteens go tomorrow, and what do we load?"
- **Recommendation:** four stops across the two canteens with time windows, estimated meals and setup notes. One example: the Cedar Ridge parking lot, 11 am to 1:30 pm, about 420 meals. Most requests from this area came in Spanish, so the note says to bring a Spanish-speaking volunteer and pet food. A chaplain is suggested at two stops where people asked for emotional or spiritual care.
- **Decision:** Ruth accepts three stops and swaps one for a church lot her team knows. The console records the change and the reason.
- **At the same time:** Jen's needs board shows two volunteer groups trying to claim Prairie Lakes. She assigns one there and sends the other to Willow Bend, so nobody is visited twice and nobody is missed.
- **Proves:** NED-03 to NED-07, REC-05, REC-06, CON-08.

### Monday 10 am: power stays out (T+39h)

The utility estimates three to five more days for 6,200 customers, about 15,500 people.

- **Recommendation:** one Type II drive-through point of distribution (up to 10,000 people a day) on a flat, paved lot with semi-truck access, outside the debris zone and off the hospital route. The console also suggests a walk-up point near Cedar Ridge, because Census data shows 23% of households there have no vehicle. It estimates the first 72 hours' supplies at 1 gallon of water, 6–8 lb of ice and 2 meals per person. It also suggests requesting a partner communications trailer for phone charging and Wi-Fi at the walk-up point.
- **Decision:** Dana approves both sites and submits the resource request to the state.
- **Proves:** REC-07, REC-08, DEC-07.

### Wednesday: plan the one-stop shop (T+4 days)

Reviewers have verified 46 homes destroyed, 118 major, 203 minor and 377 affected. Of the 164 major and destroyed homes, 58% are rented and 47% have no insurance for this damage.

- **Recommendation:** a Multi-Agency Resource Center (MARC) site close to where the major and destroyed homes cluster, on a bus line, ADA-accessible, with parking and room for 14 partner tables. The partner mix follows the top needs: housing, insurance help, legal aid, crisis counseling and disaster loans. It also suggests interpreters for the languages residents reported in, with Spanish first.
- **Decision:** Luis books the site for Thursday through Sunday and invites partners from the console.
- **Proves:** REC-09, CON-09.

### Days 2–6: build the declaration data (T+2 to T+6 days)

- **Console shows:** Dana's declaration view counts down the 30-day window. It shows verified counts split by owner/renter, insured/uninsured and home type, plus the outage log, the Census profile of affected tracts and a public-damage cost estimate. The state liaison has read-only access with no personal details.
- **Recommendation:** a sampling route for the joint state-FEMA damage assessment on day 6. It covers each area and home type in proportion to the verified damage.
- **Decision:** Dana exports the FEMA-format package and the Form 010-0-13 draft data, then hands them to the state. The governor's office, not the county, files the request.
- **Proves:** DEC-01 to DEC-16.

### Day 30: hand-off and after-action review

- The long-term recovery group receives the consented case list. Households that said no to sharing are not included.
- After-action numbers on the review screen:
  - Willow Bend went from 7% to 74% of homes reporting after outreach.
  - The median time to first human review was 9 hours.
  - Reviewers agreed with the AI's damage suggestion 81% of the time overall, but only 74% for manufactured homes. That gap triggers a retraining request to the university partner.
- **Proves:** NED-05, AIG-09, PHO-13, Section 19 metrics.

## How the console recommends places and setups

Recommendations combine live demand from the reports with a facility registry the county builds before any disaster. They follow published planning factors, and every one comes with its reasons. The registry is also what makes the product useful between disasters.

**Inputs**

- **Demand (live):** needs and displacement answers, verified damage clusters, language of reports, pets, access and functional needs.
- **Conditions (live):** damage footprint, utility outage area, road closures entered by staff, debris zones.
- **Places (pre-built registry):** schools, churches, community centers and parking lots, each with square footage, ADA status, generator or transfer switch, kitchen, showers, pet policy, parking, truck access, floodplain status, agreement (MOU) status, contacts, and the communities that trust and use it.
- **Community (Census/ACS):** households without a vehicle, language spoken at home, age 65+, disability and poverty by tract.

**Planning factors the console applies** (tenant-editable defaults)

| Site or setup | Factor | Source |
| --- | --- | --- |
| Short-term shelter (up to 2 weeks) | 40 sq ft per person; more for people who need functional support | [Florida sheltering guidance](https://www.floridadisaster.org/contentassets/54c8e48ffbc848e68d63c4554ddacf3b/sheltering_guidance_aid_october_2010.pdf) |
| Long-term shelter (over 2 weeks) | 60–80 sq ft per person for sleeping, plus 40 sq ft personal space | Same |
| Shelter showers | 1 per 48 people short-term; 1 per 25 long-term | Same |
| Shelter feeding | 2 meals plus snacks and water per person per day, served in two shifts | Same |
| Drive-through POD | Type I up to 20,000 people a day, Type II up to 10,000, Type III up to 5,000 | [Ohio EMA POD guide](https://dam.assets.ohio.gov/image/upload/ema.ohio.gov/Documents/Ohio_POD_FOG.pdf) |
| POD supplies, first 72 hours | Per person: 1 gallon water, 6–8 lb ice, 2 meals; 1 tarp per family | Same |
| POD site | Flat, paved, room to queue off the road, semi-truck access, outside hazards and debris | Same |
| MARC site | Visible, ADA-accessible, parking and traffic control, space for partners and bulk distribution, use agreement | [Missouri SEMA MARC overview](https://sema.dps.mo.gov/programs/documents/2024-sema-conference-marcs.pdf) |

**How a recommendation is made**

1. Hard filters remove sites that fail a must-have: no power and no generator, inside the damage or flood zone, not ADA-accessible, unreachable by road.
2. Remaining sites are scored on coverage of the people who need help, weighted toward those without a vehicle or with access needs. Other factors are capacity against the estimate, travel time, and community trust and language fit.
3. The console sizes the setup from the planning factors: cots, showers, meals, POD type and supplies, partner tables, interpreters.
4. It shows the top three with plain reasons ("2.1 miles from 70% of displaced households; has generator") and why others were excluded.
5. A named person accepts, edits or rejects. The decision and reason are logged.

## New requirements

Sections 22 and 23 continue the numbering from the requirements tab. Every ID cited in the walkthrough is defined here or in Sections 11–20.

**22. Staff console (CON)**

- **CON-01 (Must)** One console with role-based workspaces (the cast table). Role, organization, event, geography and data category decide what each person sees (SEC-06).
- **CON-02 (Must)** Event templates by hazard (tornado, flood, winter storm, wildfire) preset map layers, intake questions, public messages and keywords. A new event can be opened and intake published in under 5 minutes.
- **CON-03 (Must)** Situational awareness map with layers for reports, danger flags, verified damage, needs, outages, road closures, open sites, damage footprint and Census profile. Each layer shows its source and as-of time. Everything on the map has a list equivalent (ACC-07).
- **CON-04 (Must)** A key-counts panel with as-of time: reports, unique homes, verified homes by degree of damage, displaced households, needs open/claimed/done, and sites open.
- **CON-05 (Must)** Review queue plus field-team routing. Field teams use a mobile app that works offline and syncs verification results.
- **CON-06 (Must)** "What changed since the last briefing" view and a sourced situation-report draft (CMD-16).
- **CON-07 (Must)** Reporting-coverage alerts compare reports with the structure inventory inside the damage footprint (for example FEMA's USA Structures data or county parcels). Areas below a tenant threshold are flagged as under-reported, with suggested outreach.
- **CON-08 (Must)** Needs board shared by partners: claim, assign, release and done, with overlap warnings. Partners see only consented fields (NED-04).
- **CON-09 (Must)** Site management: open, update capacity and close shelters, feeding stops, PODs and MARCs. Publishing a site updates the resident "where to get help" list (NED-06).
- **CON-10 (Must)** Danger flags are for awareness only at launch and clearly labeled "Not dispatched" (CMD-19). Decided 2026-10-12: no hand-off to 911 dispatch. When a resident answers yes to danger, they are told on screen, by SMS and on the phone line to call 911 now; the staff flag records "Resident told to call 911" with the time.
- **CON-11 (Should)** Briefing mode for the EOC wall display: large type, auto-refresh, no personal details.
- **CON-12 (Must)** The command window (Section 10) works in every workspace.
- **CON-13 (Must)** The console replaces these EOC functions, so counties need not run WebEOC or a similar system for them: damage and needs tracking; resource requests to the state (ICS 213RR fields, exportable to the state's system); situation reports and briefings (ICS 201-style incident briefing); and a significant events log with ICS 214 activity logs and ICS 213 general messages. Every record exports to PDF and CSV, and an API lets a state system that still runs WebEOC receive them.
- **CON-14 (Must)** Live conditions from three sources, each labeled with source and age: utility outage and state DOT road-closure feeds where available; Waze for Cities (two-way: receive closures and hazards, publish county closures) and Google Maps Platform for routing and travel times; and staff entry as the fallback and override.
- **CON-15 (Must)** Needs-board visibility is configurable by role, agency or individual person: who sees which partners' claims, statuses and details. Defaults follow consent rules (NED-04), and an administrator can override per event.
- **CON-16 (Must)** Shelter registration in the console for county- and NGO-run shelters (household, access needs, pets, check-in/out), plus import of shelter counts from the Red Cross system without personal details.
- **CON-17 (Must)** The field app works offline, uses the FEMA damage matrices, and syncs both ways with Esri ArcGIS (Survey123, Field Maps) and FEMA field validation tools.

**23. Recommendations (REC)**

- **REC-01 (Must)** Facility registry, maintained year-round, with the attributes listed in "How the console recommends." County EM approves entries; facility owners update their own details; the COAD can propose entries; facilities can self-register through a public form that goes to an approval queue. Remind owners to recheck each entry every 12 months and flag stale entries.
- **REC-02 (Must)** Hard filters run first: no power and no generator, inside damage or flood zone, not ADA-accessible, not reachable.
- **REC-03 (Must)** Scoring is deterministic and explainable, with tenant-adjustable weights and documented defaults. Show what would change the top pick.
- **REC-04 (Must)** Show the top three with reasons and the excluded sites with why. A named person accepts, edits or rejects; log the decision and reason.
- **REC-05 (Must)** Feeding recommendations: stops, time windows, meal estimates, and setup notes on language, pets and emotional or spiritual care.
- **REC-06 (Must)** Partner setup uses each partner's declared assets and limits from its profile (e.g. two canteens, meals per hour, staff).
- **REC-07 (Must)** POD recommendations: type, site and first-72-hour supply estimates from the planning factors.
- **REC-08 (Must)** Suggest walk-up points where Census data shows high shares of households without a vehicle.
- **REC-09 (Must)** MARC recommendations: site, partner mix from the top needs, and interpreter languages from the reports.
- **REC-10 (Must)** Never invent capacity or availability. Show the age of every input and warn when it is stale.
- **REC-11 (Must)** Equity guardrail: report each recommendation's coverage by tract income, renter share and language, and flag recommendations that leave a high-need area uncovered.
- **REC-12 (Must)** Recommendations come from rules and optimization, not from a language model. AI may only draft the plain-language explanation, which must match the computed reasons (AIG-07).
- **REC-13 (Must)** Proactive resource discovery: on a tenant-set schedule (default weekly, daily during an active event), AI searches public sources for possible new resources (community centers, places of worship, schools, cooling and warming centers, food pantries, clinics, large parking lots) and for changes to registered ones (closed, moved, new hours). It drafts each candidate with its source links, fills in what it can confirm, marks what is unknown, and pre-checks it against the registry criteria. Candidates go to the administrator's review queue to qualify in or out; nothing is added, changed or removed without a human decision. Rejected candidates are remembered so they are not proposed again unless something changes.
- **REC-14 (Should)** A digest of new candidates and registry changes goes to the administrator by email or in the console; during an active event, high-value candidates near unmet need are raised immediately.

## Console decisions (answered 2026-10-10)

| Question | Decision | Requirement |
| --- | --- | --- |
| Relationship to WebEOC or similar | Replace parts of it: damage and needs tracking, resource requests to the state, situation reports and briefings, significant events log and ICS forms | CON-13 |
| Who keeps the facility registry current | All of them: county EM approves, facility owners update their own details, the COAD contributes, facilities can self-register. AI also finds new resources proactively and brings them to the administrator to qualify in or out | REC-01, REC-13 |
| Outage and road-closure data | Utility and state DOT feeds plus staff entry, plus Waze and Google Maps integrations | CON-14 |
| Who sees partner claims on the needs board | Configurable by role, agency or person | CON-15 |
| Shelter registration | Both: in the console for county and NGO shelters, with counts imported from the Red Cross system | CON-16 |
| Field team tools | This product's offline app, syncing with Esri and FEMA field tools | CON-17 |
| Danger flags to 911 dispatch | Later, through the CJIS enclave; awareness only at launch | CON-10 |

## Sources

- [Florida Division of Emergency Management, Sheltering Guidance Aid (2010)](https://www.floridadisaster.org/contentassets/54c8e48ffbc848e68d63c4554ddacf3b/sheltering_guidance_aid_october_2010.pdf)
- [Ohio EMA, Point of Distribution Field Operations Guide](https://dam.assets.ohio.gov/image/upload/ema.ohio.gov/Documents/Ohio_POD_FOG.pdf)
- [Missouri SEMA, Multi-Agency Resource Centers (2024)](https://sema.dps.mo.gov/programs/documents/2024-sema-conference-marcs.pdf)
- [FEMA Preliminary Damage Assessment Guide (July 2025)](https://www.fema.gov/sites/default/files/documents/fema_rd_pda-guide_07012025.pdf)

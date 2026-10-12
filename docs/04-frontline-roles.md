# Frontline roles

A frontline worker's job is with the survivor, not on a screen. The app documents everything anyway, by capturing work as it happens instead of asking people to fill in forms afterward.

## The principle

Every feature here passes one test: does it let the worker keep their eyes on the survivor? The phone stays in a pocket or on a lanyard most of the time; work is recorded by scanning, tapping, speaking or simply arriving.

- **Capture, don't type.** Time, place, worker, agency and the survivor's record attach automatically. Scans, one-tap counters and voice replace typing.
- **The survivor tells their story once.** With consent, everyone who helps sees what was already said, so nobody asks again.
- **Review takes seconds.** AI drafts the note; the worker confirms it after the conversation, not during it.
- **Some conversations stay private.** Counseling and spiritual care record only that contact happened and any follow-up, never what was said.
- **Everything is still documented.** Every action is logged with who, when and where, and feeds ICS 214, case files, FEMA packages and cost-share records.

## 26. Features every frontline worker gets (FL)

**26.1 Finding the survivor's record without paperwork**

- **FL-01 (Must)** Every survivor gets a reference code and QR code: on their SMS confirmation, a printed card, or a shelter wristband. Scanning it opens their record for any worker the survivor has consented to. No ID is ever required. The code is always printed and sent as text too, so the QR code is never the only way in (ACC-50).
- **FL-02 (Must)** Without a code, a worker finds the record by phone number plus a one-time code sent to the survivor, or by address plus name, and the survivor confirms it is them.
- **FL-03 (Must)** One shared survivor record ("tell it once"): damage, needs, household, access needs, help received, referrals and appointments. Each organization sees only the sections the survivor consented to share with it (NED-03).

**26.2 Documenting without looking at the screen**

- **FL-04 (Must)** Conversation scribe: with the survivor's spoken or tapped consent, the app listens during a conversation and drafts a structured note: needs heard, help given, follow-ups and referrals. A visible "listening" indicator shows the whole time; the survivor can say stop. The worker reviews the draft afterward in under 30 seconds. Audio is deleted once the note is confirmed; only the confirmed note is kept.
- **FL-05 (Must)** The scribe is off by default for counseling, spiritual care, legal aid and anything involving a child, and cannot be turned on for counseling or spiritual care.
- **FL-06 (Must)** One-tap service logging: meal served, water case given, tarp installed, voucher issued, cot assigned, ride given. Counters work from a lock-screen widget and with gloves.
- **FL-07 (Must)** Voice commands for common actions ("log two meals," "refer to case management," "I'm done here"), always confirmed on screen before saving.
- **FL-08 (Should)** Smartwatch support for counters, check-in timers and help alerts.
- **FL-09 (Must)** Photos of documents a survivor chooses to share (lease, ID, insurance letter) go straight into their record with consent, never into the camera roll.

**26.3 Hand-offs between people and organizations**

- **FL-10 (Must)** Warm referrals: with the survivor's consent, a worker refers them to another organization or role in two taps. The receiver is notified, the referral shows open, accepted or done, and the referrer sees when it closes.
- **FL-11 (Must)** The survivor gets plain-language SMS updates in their language ("A cleanup crew is scheduled for Tuesday morning") and can reply, so fewer people call the EOC.
- **FL-12 (Must)** Shift hand-over: when a worker checks out, AI drafts a summary of what happened and what is still open for the next shift, which the worker confirms.
- **FL-13 (Must)** Help received is logged with source, type and dollar value, so case managers can check for duplication of benefits before FEMA, SBA or other aid is given.

**26.4 Language, safety and wellbeing**

- **FL-14 (Must)** Live conversation translation between worker and survivor in the launch languages, labeled as machine translation, with one tap to bring in a human interpreter by phone or video. Consent, legal and medical conversations always use a human interpreter.
- **FL-15 (Must)** Offline job aids per role: checklists, FEMA damage matrices, shelter standards, food safety, child safeguarding and safety briefings.
- **FL-16 (Must)** Worker wellbeing: hours on shift, rest reminders after a tenant-set limit, and a private way to ask for peer support.
- **FL-17 (Must)** Volunteer hours and donated equipment are logged automatically from check-in and assignments, so the county can claim them as credit toward its share of FEMA Public Assistance costs.
- **FL-18 (Must)** Scribe launch safeguards: each tenant and each partner organization can turn the scribe on or off; the survivor's consent (spoken or tapped, in their language) is stored with the note; the scribe never runs in the background or without the indicator; audio is processed under the AI provider terms in AIG-06 and deleted after the note is confirmed; extraction accuracy is measured per language and the scribe turns itself off for a language whose correction rate crosses the tenant threshold (AIG-09).

## One survivor, twelve hand-offs

In the WESTWIND exercise, a renter at Cedar Ridge meets at least twelve people from seven organizations in two weeks. Each step below is a hand-off the app has to carry, so she never repeats her story.

1. **She texts DAÑOS.** Intake creates her record and reference code (resident flow).
2. **A firefighter searching the block** taps "searched, occupied, no injuries" on her building. Search status shows on the map so the block isn't searched twice.
3. **A canvasser** finds her Sunday, scans her code, adds photos and her family's needs by voice with her consent.
4. **A damage assessor** verifies the damage from photos; **a building inspector** posts a yellow placard. She gets an SMS in Spanish explaining what yellow means for her.
5. **A shelter worker** scans her code at the door, assigns cots and records her son's inhaler need in the restricted health section.
6. **A shelter nurse** sees the need, arranges a replacement inhaler and logs it.
7. **A canteen crew** logs two meals at the Cedar Ridge stop with one tap.
8. **A chaplain** talks with her; the record shows only "emotional and spiritual care contact, follow-up Thursday."
9. **A case worker** opens her record at the one-stop recovery center (MARC) and sees everything above. She does not repeat her story. The case worker refers her to legal aid about her lease.
10. **A legal aid attorney** accepts the referral at the next table.
11. **A cleanup crew** gets a work order to remove the tree; the landlord's right-of-entry form is signed on the phone. Before and after photos close the need.
12. **A long-term recovery case manager** receives her consented file at Day 30 and sees every dollar of help already given, so nothing is duplicated.

## 27. Every frontline role and what the app does for them (FR)

The roles below are the people who could be in the field during an event like WESTWIND. Each row is a requirement on top of the shared features in Section 26. EOC and dispatch staff are covered in Sections 22, 23 and 25.

**Local government**

| Role | What the app does for them | ID |
| --- | --- | --- |
| Firefighters and rescue teams | Digital search marking per structure (searched, time, team, occupants, hazards), mirroring the spray-painted marks; a "searched" map layer so no block is searched twice | FR-01 |
| EMS crews | Log only "medical assist given" and access needs found; patient care records stay in their own system | FR-02 |
| Law enforcement at perimeters | Scan resident re-entry passes and approved contractor and volunteer credentials at checkpoints; log entries. No criminal-justice data (SEC-12) | FR-03 |
| Building inspectors and code officials | Record the safety placard posted (inspected, restricted use, unsafe) with a photo; the resident gets an SMS explaining what it means in their language | FR-04 |
| County damage assessors | Field app routes, parcel snap and street sweep (Section 24) | FLD |
| Public works and road crews | One-tap road status that also updates Waze; debris pickup requests from resident reports; digital debris load tickets for FEMA Public Assistance records | FR-05 |
| Public health and environmental health | Inspection checklists for shelters and feeding sites; illness counts from shelters, aggregated only; targeted boil-water and safety notices | FR-06 |
| County human services caseworkers | Shared case management with NGOs (FR-18) | FR-07 |
| Animal services | Pet intake with a photo linked to the owner's code; lost-and-found matching; shelter pet census | FR-08 |
| School and facility hosts | Walk-through photos of the building before and after use as a shelter, key holders and facility issues | FR-09 |

**State and federal**

| Role | What the app does for them | ID |
| --- | --- | --- |
| State emergency management liaison | Read-only declaration view without personal details (DEC) | DEC |
| FEMA and state joint damage assessment teams | Joint assessment mode: the sample route, verified records without personal details, mark each as validated | FR-10 |
| FEMA door-to-door survivor assistance teams | See which homes already reported, and with consent the survivor's basics, to help them apply to FEMA faster. Never replaces FEMA's own registration | FR-11 |
| SBA disaster loan representatives | MARC queue and warm hand-off from other tables | FR-12 |
| National Guard | Missions assigned through the dispatch board as units (traffic control, debris, welfare checks) | FR-13 |

**Nonprofit and faith-based organizations**

| Role | What the app does for them | ID |
| --- | --- | --- |
| Shelter workers | Wristband scan at the door; cot assignment; live census to the EOC; dietary, access and pet needs; quiet incident log; check-out | FR-14 |
| Shelter nurses and Medical Reserve Corps | Restricted health section seen only by health roles; medication and medical-equipment replacement requests; every view logged | FR-15 |
| Crisis counselors and chaplains | Contact log only: when, follow-up date, referral. No content is recorded, and the scribe cannot be used | FR-16 |
| Feeding and canteen crews | Meal counter; stop check-in and check-out; supplies left; allergen notes; route to the next stop | FR-17 |
| Caseworkers and disaster case managers | Shared survivor record; recovery plan with unmet needs; help received with dollar values; document capture; appointments by SMS; referrals | FR-18 |
| Cleanup crews (chainsaw, tarp, muck-out) | Work orders; right-of-entry and release signed on the phone by the owner, with landlord consent for renters; before and after photos; hours and equipment logged | FR-19 |
| Volunteer reception center staff | Walk-up volunteers register by QR; waivers; skills; background check status where required (status only, never the report); badges; team assignment | FR-20 |
| Donations and warehouse staff | Inventory by photo or barcode; requests from sites; delivery runs | FR-21 |
| Distribution point and food pantry staff | Car or person counter; supplies per car; how fast stock is running down; resupply request drafted automatically. No ID required to receive help | FR-22 |
| Legal aid attorneys | Accept referrals; their notes stay outside the shared record to protect confidentiality; only "accepted" and "service given" are shared | FR-23 |
| Interpreters | Request queue by language; join a conversation remotely; language support logged | FR-24 |
| Disability and independent-living advocates | Consented access-needs list; medical equipment loans; accessible transport requests | FR-25 |
| Child-friendly space staff | Child check-in and check-out with a guardian pickup code; minimal child data; no photos of children by default | FR-26 |
| Long-term recovery group | Day-30 hand-off; rebuild projects; volunteer construction scheduling; funds committed per household | FR-27 |

**Community volunteers**

| Role | What the app does for them | ID |
| --- | --- | --- |
| CERT members | Hazard reports, welfare checks and canvassing in the field app | FLD |
| ARES and RACES operators | Net control mode on the dispatch board | DSP-10 |
| Canvassers | Assisted intake for residents, door hangers with QR codes, and "no one home" logging that schedules a revisit | FR-28 |
| Walk-up volunteers | Registered and assigned through the volunteer reception center | FR-20 |

**Private partners**

| Role | What the app does for them | ID |
| --- | --- | --- |
| Utility crews and liaisons | With consent, the list of power-dependent households for priority restoration and welfare checks | FR-29 |
| Home health and hospice agencies | Welfare-check list of their own clients and a way to report each one's status | FR-30 |
| Property managers | Unit-by-unit status for their buildings and right-of-entry consent for cleanup | FR-31 |
| Insurance adjusters | No access. Survivors can send their own photos and summary to their insurer from the app | FR-32 |

## Questions to settle next

- [ ] Conversation scribe (FL-04): decided 2026-10-12, ships at launch for all organizations, with the launch safeguards in FL-18.
- [ ] Which partner case-management systems must receive the shared record first?
- [ ] Should survivors get a portal (web and SMS) to see their own record, update it and manage consent themselves?
- [ ] Which roles need smartwatch support at launch, if any?

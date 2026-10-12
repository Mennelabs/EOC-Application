# Field app and dispatch

Volunteers enter data and locations through one field app, and coordinators see and direct every checked-in person and team on a live dispatch board. This is volunteer and resource dispatch, not 911 dispatch.

## Decisions (2026-10-12)

| Question | Decision |
| --- | --- |
| Devices | Both volunteers' own phones and county- or NGO-issued devices |
| Launch personas | All of them: damage assessment teams, canvassers and assisted-reporting volunteers, NGO crews, site leads, hazard spotters |
| Data relay over amateur radio (Winlink) | Out of scope |
| Dispatcher / coordinator function | Required: a live map of volunteers and teams, with assignment, status and safety tracking |

## 24. Field app (FLD)

One offline-first mobile app serves every field role. What a volunteer sees depends on the credential and assignment they checked in with.

**24.1 Roles and devices**

- **FLD-01 (Must)** Role home screens: damage assessment teams (routes and FEMA matrix), canvassers and assisted-reporting volunteers (resident intake on the resident's behalf, CHN-06), NGO crews (assigned needs and completion), site leads (shelter, feeding stop or POD census and capacity), and hazard spotters (quick reports).
- **FLD-02 (Must)** Works on volunteers' own phones and on issued devices. Issued devices are enrolled in device management with optional single-app mode. On personal phones, the app protects only its own data: encrypted app storage, PIN or biometric unlock, screenshots blocked on screens with personal details, and remote wipe of app data without touching anything else on the phone.
- **FLD-03 (Must)** Check-in by scanning a QR code at staging or entering an event code. Check-in records the person, agency, team, credentials and start time; check-out ends the shift. This feeds accountability and the ICS 214 activity log automatically.

**24.2 Location without addresses**

- **FLD-04 (Must)** GPS drops a pin and snaps it to the nearest parcel or structure from county parcel data cached on the device, then asks "Is this the property?" with the parcel outline and address of record.
- **FLD-05 (Must)** The volunteer can drag the pin, pick a different parcel, or add a landmark note. Records keep GPS accuracy, the parcel ID and a US National Grid coordinate, so search and rescue and FEMA teams can find the spot without an address.
- **FLD-06 (Should)** Show cached pre-disaster imagery under the pin so a volunteer can match a destroyed home to its lot.

**24.3 Fast entry**

- **FLD-07 (Must)** Photo-first capture: take photos, then tag them. Photos keep location and time internally and are stripped of metadata on export (PHO-06).
- **FLD-08 (Must)** FEMA degree of damage chosen from pictures and short descriptions for the home type, never from definitions alone.
- **FLD-09 (Must)** Voice notes: the AI drafts fields from what the volunteer said, and the volunteer confirms each one (INT-13).
- **FLD-10 (Must)** Street sweep mode: walking a block, one tap per property (no damage, affected, minor, major, destroyed, can't reach), and the pin advances to the next parcel.
- **FLD-11 (Must)** Quick report from any screen: hazard (downed line, gas, blocked road, unsafe structure), site status, or resource seen, as a pin, a photo and a category.
- **FLD-12 (Must)** NGO crews mark a need done with a photo and note; canteen crews log meals served per stop; site leads update census and capacity in two taps.

**24.4 Offline, privacy, safety**

- **FLD-13 (Must)** Before deployment, the app downloads maps, parcels and assignments for the volunteer's area. Every record shows "On this phone," "Sending" or "Received"; sync happens on any connection; two records for the same property are flagged for a reviewer, never overwritten.
- **FLD-14 (Must)** Volunteers see only their own assignments. Resident personal details are cleared from the device after sync and at check-out.
- **FLD-15 (Must)** Built for field use: targets usable with gloves, high-contrast mode for sunlight, one-handed operation, and a battery saver that lowers location frequency.
- **FLD-16 (Must)** Safety: a help button sends location and team to dispatch; warnings when entering a hazard area marked on the map; a check-in timer reminds the team lead (DSP-07).
- **FLD-17 (Must)** No data relay over amateur radio. Positions or status heard on a radio net are entered by net control on the dispatch board (DSP-10).

## 25. Dispatch and field coordination (DSP)

Coordinators see where every checked-in team and volunteer is, what they are doing, and what still needs someone, on one live map, and assign work from it. It covers county staff, CERT, ARES, VOAD groups and NGO crews; it never dispatches police, fire or EMS.

**25.1 The board**

- **DSP-01 (Must)** Live operations map: checked-in people and teams by status (available, en route, on task, break, out of service, overdue), plus open needs, field routes, hazards, closures and open sites. A list view and filters by agency, skill, team and status sit beside it.
- **DSP-02 (Must)** Resource roster: people, teams and units (e.g. Canteen 2, Chainsaw Team B) with agency, skills and credentials (damage assessor, chainsaw certified, Spanish speaker, chaplain, ham operator), equipment, shift times and hours worked.
- **DSP-03 (Must)** Unassigned work queue: needs, verification routes, outreach tasks and site staffing gaps, sorted by priority.

**25.2 Assigning and tracking**

- **DSP-04 (Must)** Assign by dragging work onto a team or using the command window ("send the nearest chainsaw team to Willow Bend lot 41"). The console suggests the nearest qualified available team with reasons; a dispatcher confirms. Assignments go to the field app and need acknowledgement; unacknowledged after 10 minutes (tenant-set) raises an alert.
- **DSP-05 (Must)** Status changes with one tap in the field app. The board suggests "arrived" or "left" from location, for the team to confirm.
- **DSP-06 (Must)** Messages to a person, team, agency or map area, with templates and read receipts, and SMS fallback for people not using the app.
- **DSP-07 (Must)** Safety: a check-in timer per team (default 60 minutes); a missed check-in turns the team "overdue" and alerts the dispatcher, then the safety officer. Help-button alerts take over the screen until acknowledged. Teams heading into a newly marked hazard area are warned.

**25.3 Location privacy and multi-agency rules**

- **DSP-08 (Must)** Location is shared only while checked in, and the volunteer always sees that it is on. Positions are visible only to dispatch and safety roles, at a precision the tenant sets. Live position trails are kept 30 days by default; positions tied to incident records stay with the record.
- **DSP-09 (Must)** Each agency dispatcher sees and assigns its own people; the county coordinator sees everyone; visibility is configurable by role, agency or person (CON-15).

**25.4 Radio, records and replay**

- **DSP-10 (Must)** Net control mode: a radio operator logs status and positions heard on ARES, RACES or agency nets against the right team, with an ICS 309-style communications log.
- **DSP-11 (Must)** Every assignment, status change and message feeds the significant events log and each team's ICS 214 activity log.
- **DSP-12 (Should)** Timeline replay of the board for briefings and after-action review.
- **DSP-13 (Must)** The board is labeled as volunteer and resource coordination, not emergency dispatch. Anything that needs 911 goes to 911 (CON-10).

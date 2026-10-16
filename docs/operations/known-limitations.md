# Known limitations

What the platform does not do yet, what needs a person before a county relies on it, and what the platform assumes. For county administrators, the help desk and anyone writing training or public guidance (BRD:FR-18.03).

**Status:** draft of 2026-10-16, built from the open notes in `docs/traceability.md`; to be reviewed by Adam before it is shared with a county. Update it with the traceability table: when a row there changes, its line here changes too.

## Not built yet

| What                                                                                                                                                                                                                              | Why, and where it is decided                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case management on the shared record: help received with its value, appointments, the SBA queue, warm hand-offs between recovery-centre tables, the day-30 hand-off to the long-term recovery group (FL-13, FL:FR-07, 12, 18, 27) | After layer 8 (`docs/decisions.md`, 2026-10-15). Documents a survivor chooses to share are captured with consent (FL-09).                                                                 |
| Sharing with legal aid, insurers, utilities and other partner types beyond the four a resident can choose today (FL:FR-11, 25, 29, 30)                                                                                            | Each needs a consent kind with English and Spanish wording, and a decision on which health-adjacent fields that partner sees. Waiting on Adam.                                            |
| Unit-by-unit status for a property manager (FL:FR-31)                                                                                                                                                                             | Not built. An organization can report each of its places (ORG-01).                                                                                                                        |
| ICS forms and EOC functions (layer 8)                                                                                                                                                                                             | Planned in `docs/plans/layer-8.md`; not started until Adam approves layer 7.                                                                                                              |
| Pre-disaster imagery (FLD-06), smartwatch support (FL-08)                                                                                                                                                                         | Need an approved imagery licence and a decision on which roles need a watch.                                                                                                              |
| CAD, NCIC and records-management feeds (BRD:INT-07)                                                                                                                                                                               | Only under separately approved contracts (2026-10-13). The CJIS enclave holds no real criminal-justice data until it is in an authorized government cloud and has passed the state audit. |
| Releasing a person's open assignments when they go off duty (AC-05C)                                                                                                                                                              | The policy (BRD:DEC-07) is open.                                                                                                                                                          |
| The field app on iPhone                                                                                                                                                                                                           | Built and tested for Android and the web build; an iOS build has not been made or tested.                                                                                                 |
| Printing straight to badge and wristband printers (FL-01, FL:FR-14, BRD:FR-13.05)                                                                                                                                                 | Badges, re-entry passes and sign-up codes print from the browser; a wristband code is written on the band. The Brother label printers chosen on 2026-10-15 are later work, after layer 8. |
| An interpreter joining a conversation from inside the platform (FL:FR-24)                                                                                                                                                         | Live translation hands over to an interpreter, who calls in by phone or video outside the platform.                                                                                       |

## Needs a person before a county relies on it

- **Screen-reader passes.** Every released screen has automated accessibility checks (axe, keyboard-only journeys, 320 px reflow). The manual pass with NVDA and VoiceOver is recorded as pending in each screen's record under `docs/a11y/screens/` (check 2).
- **Spanish.** Every resident and public string is in Spanish, but the translations are reviewed drafts. A professional review is the EQ-07 gate.
- **Moderated testing.** Task completion and assistive-technology task success (MET-01, MET-03) come from moderated sessions with residents and staff, not platform data.
- **Imagery review.** Community members review the images and icons before go-live (EQ-04).
- **Launch ownership.** Content and support owners, training and incident handling are set up before launch (GATE-10).
- **The county's own content.** Shipped exercise job aids (the FEMA damage matrix and the shelter standards) are drafts for the exercise county; a county reviews and approves its own before a real event. Question wording, safety messages and public resources are published only after a person reviews them.

## AI

- The provider is OpenAI for every AI function until a cloud provider is chosen (`docs/decisions.md`, 2026-10-15). The live evaluation (`packages/ai/test/live.test.ts`) needs the county's key and has not been run against the real provider here; the automated suite runs against the test double.
- The damage severity suggestion is labelled as an unverified AI suggestion. A credentialed reviewer always decides.
- When an AI function is unhealthy, the platform alerts its owner but keeps the feature on, and every resident path still works by typing.

## Assumptions the platform makes

- **Relay calls.** Resident pages say to text the county help line or call it through relay by dialling 711. That works only if the county's help line answers relay calls.
- **One API instance per limit.** The per-address lookup limit and the per-contact limit on resending a lost reference number are kept in each API instance's memory. Several instances allow a few more tries in total.
- **Feeds a county must switch on.** The Waze closure feed is off until the county enrols with Waze for Cities. Single sign-on through the county's identity provider is off until two administrators approve it.
- **Uploaded photos.** Photos are decoded and saved again as new images, which drops anything that is not a picture; there is no antivirus scan of uploads (BRD:INT-03).
- **Offline maps.** A phone works offline only in areas whose map packages were cut and downloaded before it went out.
- **Data on laptops.** Every stack outside an authorized government cloud holds synthetic or exercise data only.

## Where to look

- What each requirement does today, with its tests: `docs/traceability.md`.
- A check that help text never claims what is listed here as not built: `tools/checks/test/help-claims.test.ts` (AC-18C). When a feature is built, remove its line here and its rule there together.
- Decisions and their dates: `docs/decisions.md`.
- Security threats and controls per feature: `docs/security/threat-models.md`.

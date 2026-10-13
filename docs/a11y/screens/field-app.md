# Field app (web build and phone) — accessibility record

Screens: PIN, check-in, home with the help button and the check-in timer, messages, "On this phone", settings, locate, damage assessment, street sweep, quick report, counters, census, the role modules (`record/[kind]`), child check-in and release, the shelter door, stock, interpreters, checkpoint, people involved. Layer 4, 2026-10-13.

| #   | Check                                  | Result                                                                                                                       | Evidence                                           |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Keyboard and switch access (web build) | pass (automated on the journey screens); signing works by typing and confirming a name as well as drawing (WCAG 2.1.1)       | `tests/e2e/field.spec.ts`, `src/signature.tsx`     |
| 2   | TalkBack and VoiceOver on a device     | **pending a person** on a real phone                                                                                         | a tester records the pass here                     |
| 3   | Phone width, no horizontal scroll      | pass (automated, Pixel 7 viewport; local smokes at 320 px)                                                                   | `field.spec.ts`                                    |
| 4   | Contrast, high-contrast mode           | pass (axe); the high-contrast setting for sunlight checked with axe in the local smoke                                       | axe, `src/theme.ts`                                |
| 5   | Large targets for gloves               | pass: 48 px minimum, a larger setting, one-handed layout                                                                     | `src/ui.tsx`, settings                             |
| 6   | Not by colour alone                    | pass: record states are words ("On this phone", "Received", "Needs a decision")                                              | `src/i18n.ts`                                      |
| 7   | Offline                                | pass (automated): a quick report saved without signal shows "On this phone" and is received later (FLD-13)                   | `field.spec.ts`                                    |
| 8   | Help button                            | pass (automated): one tap and one confirmation, always reachable from home (FLD-16)                                          | `field.spec.ts`                                    |
| 9   | Spanish                                | pass: every string in English and Spanish; the language switch sets `lang` (EQ-06)                                           | `src/i18n.ts`, `test/records.test.ts`              |
| 10  | Gloves, sunlight, real GPS and camera  | **pending a person** on a device in the field                                                                                | a tester records the pass here                     |
| 11  | Shared-device privacy                  | pass (automated): check-out ends the shift and clears resident details; a remote wipe clears the app's data (FLD-02, FLD-14) | `field.spec.ts`, `packages/field-core` purge tests |

Open: checks 2 and 10 need a person with a device.

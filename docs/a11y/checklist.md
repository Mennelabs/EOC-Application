# Manual accessibility checklist (per released screen)

Automated axe checks (`pnpm test:e2e`) catch roughly a third of WCAG 2.2 AA failures. Every released screen also gets this manual pass, recorded in `docs/a11y/screens/<screen>.md` with date, tester and tooling. Any failure blocks the layer (GATE-03, finding G-06). Requirement IDs: NFR-01, FR-A01–A10, ACC-01–53, AC-A01–A09.

| #   | Check                                                                                                                                                         | Requirement              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | Complete the whole task with keyboard only; focus order follows reading order; focus is always visible                                                        | ACC-10, ACC-08           |
| 2   | Complete the whole task with a screen reader (NVDA + Firefox, VoiceOver + Safari on iOS); every control has an accessible name; status messages are announced | ACC-04–06, AC-A01        |
| 3   | 200% browser zoom and 320 px width: no clipped controls, no horizontal scroll (maps excepted)                                                                 | ACC-07, AC-A02           |
| 4   | Text and non-text contrast ≥ 4.5:1 / 3:1 in every theme and high-contrast mode                                                                                | ACC-08                   |
| 5   | Meaning never by colour alone (status, errors, map legends)                                                                                                   | ACC-09                   |
| 6   | No time limits, precise gestures or drag-only interactions; touch targets ≥ 24 px (we use 44 px)                                                              | ACC-12, AC-A03           |
| 7   | Errors: identified in text, associated with the field, input preserved, plain recovery steps                                                                  | ACC-26–28, FR-00.07      |
| 8   | Plain language at or below grade 5 (resident) / plain professional (staff); unfamiliar terms explained                                                        | INT-08, ACC-22           |
| 9   | Spanish: every string, error, consent and confirmation translated; `lang` attribute correct; no truncation                                                    | EQ-06/07, AC-A05         |
| 10  | Reduced motion respected; no flashing content                                                                                                                 | ACC-16                   |
| 11  | Essential task works with camera, GPS and AI denied or unavailable                                                                                            | AC-A06, AC-A08, FR-00.09 |
| 12  | Shared-device privacy: nothing personal remains after finishing or 2 minutes idle                                                                             | ACC-41, AC-A07           |
| 13  | Non-map alternative for every location task                                                                                                                   | ACC-07, AC-03C           |
| 14  | PDF/CSV exports: tagged, reading order verified; essential guidance also available as HTML                                                                    | NFR-12, ACC-49           |

## Screens released so far

| Screen                   | Layer    | Automated | Manual                                           | Record |
| ------------------------ | -------- | --------- | ------------------------------------------------ | ------ |
| Resident welcome (EN/ES) | scaffold | pass      | not yet (manual pass is done at layer-2 release) | —      |
| Console shell            | scaffold | pass      | not yet                                          | —      |

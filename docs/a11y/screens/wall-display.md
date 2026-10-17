# Console Wall display: accessibility record

Screen: the console's **Wall display** (`/console/wall`, `apps/web-console/src/screens/wall.tsx`), shown in briefing mode (large type, navigation and command bar hidden; ADR-0045). It holds:

- the event's name, the time the figures are from and the refresh interval, in a status line;
- six tiles: homes with verified damage (by degree), reports awaiting review, open needs, people in shelters, missions under way, resource requests open;
- shelters open with occupancy, the objectives of the operational period, the last six hours of the event log, and live conditions with their source and age, each a captioned table or a list.

CON-11, 2026-10-17.

| #   | Check                        | Result                                                                                                                                                      | Evidence                                                 |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Keyboard only, focus visible | pass: nothing to operate but the event choice (shown only when there is more than one event) and the table regions                                          | `tests/e2e/console-screens.spec.ts`                      |
| 2   | Screen reader                | **pending a person**. One h1; h2 per panel; tiles name their figure; the status line is `aria-live="polite"` so a refresh is announced without interrupting | axe; a tester records the pass here                      |
| 3   | 200 % zoom / 320 px          | pass (automated): tiles wrap and tables scroll inside their region at the phone width; the wall itself is the large case                                    | `console-screens.spec.ts` (phone project), briefing mode |
| 4   | Contrast                     | pass (automated: axe, both themes; body ink 7:1 by the token test)                                                                                          | axe, `packages/ui/test/tokens.test.ts`                   |
| 5   | Not by colour alone          | pass: every figure has its label; the warn tone on a tile is accompanied by the number itself                                                               | screen source                                            |
| 6   | Time limits                  | pass: the refresh replaces figures in place; nothing times out and nothing moves                                                                            | screen source                                            |
| 7   | Errors                       | pass: a failed load keeps the last figures and says what failed in the error line                                                                           | screen source                                            |
| 8   | Plain professional language  | pass (hand review): "Homes with verified damage", "People in shelters", times on the county's clock                                                         | screen source                                            |
| 9   | Spanish                      | not applicable: staff screen                                                                                                                                | plan                                                     |
| 10  | Reduced motion, no flashing  | pass: no animation; the refresh does not scroll or flash                                                                                                    | `styles.css`                                             |
| 11  | Authentication (WCAG 3.3.8)  | pass: a display account signed in once on the wall's device; no re-authentication on the wall                                                               | plan §13 question 4, `briefing_display` template         |
| 12  | Shared-device privacy        | pass: counts, place names and the event log only; the payload is tested to carry no personal key or content                                                 | `briefing.db.test.ts`                                    |
| 13  | Non-map alternative          | pass: the wall has no map; places are named                                                                                                                 | screen source                                            |

Open: check 2 (screen reader), and a look at the wall itself at its real size and distance.

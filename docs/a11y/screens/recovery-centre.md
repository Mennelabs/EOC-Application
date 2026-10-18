# Console Recovery centre screen: accessibility record

Screen: the console's **Recovery centre** workspace (`/console/recovery-centre`, `apps/web-console/src/screens/recovery-centre.tsx`). It holds:

- a choice of recovery centre, a table filter and a "show visits that ended" checkbox;
- the door's check-in form: the name given at the door (a first name or the reference code) and the tables to see, one per line;
- a captioned queue table: survivor, arrival and wait, status, the table they are at, the ordered list of tables with each hand-off's one-line why, and per visit a "why" field with "Hand … to the next table" and "… left".

FL:FR-12, 2026-10-18.

| #   | Check                        | Result                                                                                                                            | Evidence                                  |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Keyboard only, focus visible | pass: native controls; the hand-off field and buttons name the survivor's label                                                   | `tests/e2e/console-screens.spec.ts`       |
| 2   | Screen reader                | **pending a person**. One h1; h2 for the check-in form; the queue has a caption and headers; tables per visit are an ordered list | axe; a tester records the pass here       |
| 3   | 200 % zoom / 320 px          | pass (automated): no sideways page scrolling at the phone width                                                                   | `console-screens.spec.ts` (phone project) |
| 4   | Contrast                     | pass (automated: axe, both themes)                                                                                                | axe                                       |
| 5   | Not by colour alone          | pass: a stop is "now", "to see", "done" or "skipped" in words; "(yours)" marks a partner's own table                              | screen source                             |
| 6   | Time limits                  | pass: none; waits are computed when the queue is read                                                                             | screen source                             |
| 7   | Errors                       | pass: a hand-off without a why, or from a table that is not the current one, says so in the status line                           | `appointments-marc.db.test.ts`            |
| 8   | Plain professional language  | pass (hand review): "hand … to the next table", "left early"                                                                      | screen source                             |
| 9   | Spanish                      | not applicable: staff screen                                                                                                      | plan                                      |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                | `styles.css`                              |
| 11  | Authentication (WCAG 3.3.8)  | not applicable: the console session                                                                                               | —                                         |
| 12  | Shared-device privacy        | pass: the label given at the door and the tables, never an address or a dollar; a partner sees its own visits and notes only      | `appointments-marc.db.test.ts`            |
| 13  | Non-map alternative          | not applicable: no map                                                                                                            | —                                         |

Open: check 2 (screen reader).

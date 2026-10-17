# Console Live conditions screen: accessibility record

Screen: the console's **Live conditions** workspace (`/console/live-conditions`, `apps/web-console/src/screens/live-conditions.tsx`). It holds:

- a captioned table of conditions most severe first: kind, condition, severity, source (feed, or staff entry with who), as-of time with age and a stale mark, status (in force, lapsed, cleared) and a clear action for staff entries;
- a "show cleared items" checkbox;
- a form to enter a condition (kind, severity, what and where, road, latitude, longitude, lapses at);
- the county's feeds in a captioned table with how the last pull went and items in force, with switch on or off, pull now and import actions, an import form and a form to add a feed.

CON-14, 2026-10-17.

| #   | Check                        | Result                                                                                                                                | Evidence                                    |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | Keyboard only, focus visible | pass: native controls throughout; every action button names its feed or condition                                                     | `tests/e2e/console-screens.spec.ts`         |
| 2   | Screen reader                | **pending a person**. One h1; h2 for feeds, h3 per form; tables have captions and headers; the import textarea has a hint             | axe; a tester records the pass here         |
| 3   | 200 % zoom / 320 px          | pass (automated): no sideways page scrolling at the phone width                                                                       | `console-screens.spec.ts` (phone project)   |
| 4   | Contrast                     | pass (automated: axe, both themes)                                                                                                    | axe                                         |
| 5   | Not by colour alone          | pass: severity, source, age and staleness are words ("50 min ago; stale", "Failed, …: connect ECONNREFUSED")                          | screen source                               |
| 6   | Time limits                  | pass: none; ages are computed when the list is read                                                                                   | screen source                               |
| 7   | Errors                       | pass: a feed that cannot be pulled shows its failure on its row; a file that is not JSON says so; an http address is refused in words | screen source, `live-conditions.db.test.ts` |
| 8   | Plain professional language  | pass (hand review): "A feed that has not spoken for two of its periods is marked stale"; kinds in words                               | screen source                               |
| 9   | Spanish                      | not applicable: staff screen                                                                                                          | plan                                        |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                    | `styles.css`                                |
| 11  | Authentication (WCAG 3.3.8)  | not applicable: the console session                                                                                                   | —                                           |
| 12  | Shared-device privacy        | pass: roads, areas and counts; a staff entry names the staff member who entered it, never a resident; Waze items keep no reporter     | `live.test.ts` (no reporter kept)           |
| 13  | Non-map alternative          | pass: the list is the primary view; the situation map's "Live conditions" layer is the alternative, with the same items               | `situation.tsx`                             |

Open: check 2 (screen reader).

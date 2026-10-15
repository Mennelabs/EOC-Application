# Console shared declaration figures (state liaison) — accessibility record

Screen: the console's **Shared declaration figures** workspace (`/console/shared-declarations`, `apps/web-console/src/screens/shared-declarations.tsx`): an event picker grouped by county (`optgroup`), then the county's figures read-only, reusing the Declaration screen's sections (filing deadline, verified damage, people in the area, confirmed outages, casualties, public damage by category, donated hours) and the joint assessment's progress as a definition list. Layer 6, task F, 2026-10-15.

| #   | Check                        | Result                                                                                                                                | Evidence                                               |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Keyboard only, focus visible | pass (automated for the journey): one native select; everything else is read                                                          | `tests/e2e/console-l6.spec.ts` (state liaison journey) |
| 2   | Screen reader                | **pending a person**: sections under their own headings; every table captioned; the county named above the figures                    | axe; a tester records the pass here                    |
| 3   | 200 % zoom / 320 px          | pass (automated): tables scroll inside their own labelled regions; no sideways page scrolling                                         | `console-l6.spec.ts` (phone project)                   |
| 4   | Contrast                     | pass (automated: axe on the loaded figures)                                                                                           | axe                                                    |
| 5   | Not by colour alone          | pass: as the Declaration screen (words for over 72 hours, overdue, unknown)                                                           | `screens/declaration.md`                               |
| 6   | Time limits                  | pass: none                                                                                                                            | —                                                      |
| 7   | Errors                       | pass: no county shared yet is said in words; a figure that cannot be read shows the reason                                            | screen source                                          |
| 8   | Plain professional language  | pass: says what is shown (counts only, read-only, same totals as the county) and that each view is recorded in the county's audit log | screen source                                          |
| 9   | Spanish                      | not applicable: staff screen                                                                                                          | plan                                                   |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                    | `styles.css`                                           |
| 11  | Authentication (WCAG 3.3.8)  | not applicable here                                                                                                                   | —                                                      |
| 12  | Shared-device privacy        | pass: counts only; no names, contact details, addresses or individual sites (DEC-13)                                                  | `services/api/test/joint-pda.db.test.ts`               |
| 13  | Non-map alternative          | pass: tables only                                                                                                                     | —                                                      |

Open: check 2 (screen reader).

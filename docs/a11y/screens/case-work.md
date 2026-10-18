# Console Case work screen: accessibility record

Screen: the console's **Case work** workspace (`/console/cases`, `apps/web-console/src/screens/cases.tsx`). It holds:

- a form to open a case by the reference code on the report;
- a filter by status and a captioned table of cases (report, status, lead organization, opened, help entries, unmet items) with an "Open" button per row;
- a detail panel: the case's facts as a definition list; the duplication-of-benefits tiles (for roles with the financial category); the help-received table with standing or voided and a void action; the recovery plan table with start, met and drop actions; the appointments table with kept, missed and cancel actions; forms to log help, add an unmet need and schedule an appointment; close with a reason.

FL-13, FL-03, FL:FR-07, FL:FR-18, FL:FR-27, 2026-10-18.

| #   | Check                        | Result                                                                                                                                                                  | Evidence                                   |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | Keyboard only, focus visible | pass: every control is a native button, input, select or textarea; every action button names its case, entry, item or appointment; reasons go through the shared dialog | `tests/e2e/console-screens.spec.ts`        |
| 2   | Screen reader                | **pending a person**. One h1; h2 per form and the detail; h3 per section of the case; tables have captions and headers; the facts are a definition list                 | axe; a tester records the pass here        |
| 3   | 200 % zoom / 320 px          | pass (automated): no sideways page scrolling at the phone width; wide tables scroll inside their named region                                                           | `console-screens.spec.ts` (phone project)  |
| 4   | Contrast                     | pass (automated: axe, both themes)                                                                                                                                      | axe                                        |
| 5   | Not by colour alone          | pass: status, standing ("Voided … by …: reason"), the survivor's channel ("Text sent; reminder queued") and "Not shown" for hidden dollars are words                    | screen source                              |
| 6   | Time limits                  | pass: none                                                                                                                                                              | screen source                              |
| 7   | Errors                       | pass: an unknown code, a missing time or a refused action say so in the status line in words                                                                            | screen source, `cases.db.test.ts`          |
| 8   | Plain professional language  | pass (hand review): "help received", "what is still unmet", "duplication of benefits" explained in the lead paragraph                                                   | screen source                              |
| 9   | Spanish                      | not applicable: staff screen (the survivor's texts are in their language)                                                                                               | `appointments-marc.db.test.ts`             |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                                                      | `styles.css`                               |
| 11  | Authentication (WCAG 3.3.8)  | not applicable: the console session                                                                                                                                     | —                                          |
| 12  | Shared-device privacy        | pass: the reference code, never the address; dollars only for the financial category; the appointment's purpose is marked "never texted"                                | `cases.db.test.ts` (director sees no sums) |
| 13  | Non-map alternative          | not applicable: no map                                                                                                                                                  | —                                          |

Open: check 2 (screen reader).

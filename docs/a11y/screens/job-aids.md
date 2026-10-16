# Console Job aids screen: accessibility record

Screen: the console's **Job aids** workspace (`/console/job-aids`, `apps/web-console/src/screens/job-aids.tsx`). It holds:

- a short explanation of who approves and what reaches phones;
- the form to write or change a job aid: short name and language (new ones only), title, the role it is for, kind, and the text with its plain-text rules as the hint;
- the job aids in a captioned table: title, role, language, status in words, who changed it last and when, and the actions (change, approve, retire), each naming its job aid.

FL-15, BRD:FR-18.03, 2026-10-16.

| #   | Check                        | Result                                                                                                                                                    | Evidence                                    |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | Keyboard only, focus visible | pass: native inputs, selects, text area and buttons; every button names its job aid ("Approve Roof check …")                                              | screen source                               |
| 2   | Screen reader                | **pending a person**. Labels and hints are tied to their fields; outcomes are a status line; approval asks for a reason in the shared confirmation dialog | axe; a tester records the pass here         |
| 3   | 200 % zoom / 320 px          | pass (automated): no sideways page scrolling at the phone width; the table scrolls in its own focusable region                                            | `tests/e2e/console-screens.spec.ts` (phone) |
| 4   | Contrast                     | pass (automated: axe with the exercise job aids listed)                                                                                                   | axe                                         |
| 5   | Not by colour alone          | pass: status is words ("Draft: not on phones until someone else approves it", "Approved: on phones", "Exercise draft: …", "Retired")                      | screen source                               |
| 6   | Time limits                  | pass: none                                                                                                                                                | —                                           |
| 7   | Errors                       | pass: the server's field errors come back in the status line; refusing an approval by the last editor says who may approve                                | `services/api/test/job-aids.db.test.ts`     |
| 8   | Plain professional language  | pass (hand review): what an approval does and when phones get it, in words                                                                                | screen source                               |
| 9   | Spanish                      | not applicable to the screen (staff); a job aid is written per language, and the phone shows Spanish aids to Spanish-speaking volunteers                  | `apps/field/src/i18n.ts`                    |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                                        | `styles.css`                                |
| 11  | Authentication (WCAG 3.3.8)  | not applicable                                                                                                                                            | —                                           |
| 12  | Shared-device privacy        | pass: no personal information on the screen                                                                                                               | screen source                               |
| 13  | Non-map alternative          | not applicable: no map                                                                                                                                    | —                                           |

Open: check 2 (screen reader).

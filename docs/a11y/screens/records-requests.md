# Records requests: accessibility record

Recorded 2026-10-15 with the public-records release (SEC-13). One screen:

- **Records requests** (`/console/public-records`, `apps/web-console/src/screens/public-records.tsx`):
  - a paragraph saying what is withheld and that a person reviews the file before it is released;
  - a form with labelled controls: event, request reference (with its hint), optional from and to dates, and a fieldset "Kinds of record" with one checkbox per kind;
  - "Prepare the release…" opens the console's confirmation dialog, which asks for a reason (RULE-14);
  - a table captioned "Releases prepared for this event": when it was asked for, the request, the rows per kind, how many columns were withheld, and the file. The file is "Download release <reference>" when ready, "Being made…" while queued, or the failure in words.

| #   | Check                        | Result                                                                                                                                        | Evidence                                             |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Keyboard only, focus visible | pass (automated): every control is native (select, inputs, checkboxes, buttons); the journey fills and sends the form and confirms the dialog | `tests/e2e/console-l7.spec.ts` (SEC-13 journey)      |
| 2   | Screen reader                | **pending a person**: the checkboxes sit in a fieldset with a legend; outcomes are announced in the status line; the table has a caption      | axe; a tester records the pass here                  |
| 3   | 200 % zoom / 320 px          | pass (automated): on the phone project the screen reflows without sideways scrolling                                                          | `console-l7.spec.ts` (`expectReflow`, phone project) |
| 4   | Contrast                     | pass (automated: axe on the empty form and on the list with a ready release)                                                                  | axe                                                  |
| 5   | Not by colour alone          | pass: the file's state is in words                                                                                                            | screen source                                        |
| 6   | Time limits                  | pass: none; the list checks again every few seconds while a release is being made and says so                                                 | `fema-package.tsx` `useExports`                      |
| 7   | Errors                       | pass: a refusal (a kind the person may not read, no kind chosen, a period that ends before it starts) is shown with its reason                | `exports.db.test.ts` (SEC-13), screen source         |
| 8   | Plain professional language  | pass (hand review)                                                                                                                            | screen source                                        |
| 9   | Spanish                      | not applicable: a staff screen; the console is English                                                                                        | —                                                    |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                            | `styles.css`                                         |

Open: check 2 (a screen-reader pass by a person).

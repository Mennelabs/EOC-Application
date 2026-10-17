# Console ICS forms screen: accessibility record

Screen: the console's **ICS forms** workspace (`/console/ics-forms`, `apps/web-console/src/screens/ics-forms.tsx`). It holds:

- the event choice;
- the objectives of the operational period (ICS 202) in a captioned table, with "met" and "drop" actions and a form to add one;
- general messages (ICS 213) in a captioned table with approve, send, reply and cancel actions, a reply form and a draft form;
- a form to pick a form (201, 213, 213 RR, 214, 309) and its scope (period, message, request, team or net), preview it block by block (a definition list and tables), and issue it;
- the issued forms in a captioned table with PDF and CSV downloads.

CON-13, 2026-10-17.

| #   | Check                        | Result                                                                                                                                                                             | Evidence                                               |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Keyboard only, focus visible | pass: native controls throughout; the scope fields change with the form chosen and each is labelled                                                                                | `tests/e2e/console-screens.spec.ts` (preview step)     |
| 2   | Screen reader                | **pending a person**. One h1; h2 per panel, h3 per form; the preview is a definition list for value and text blocks and captioned tables for table blocks, each named by its block | axe; a tester records the pass here                    |
| 3   | 200 % zoom / 320 px          | pass (automated): no sideways page scrolling at the phone width                                                                                                                    | `console-screens.spec.ts` (phone project)              |
| 4   | Contrast                     | pass (automated: axe on the screen and on the preview)                                                                                                                             | axe                                                    |
| 5   | Not by colour alone          | pass: status is words ("Draft: waiting for a second person to approve it", "Replied", "Met")                                                                                       | screen source                                          |
| 6   | Time limits                  | pass: none                                                                                                                                                                         | —                                                      |
| 7   | Errors                       | pass: a form whose scope is missing (no message, no team) answers in the status line; approving one's own message says why                                                         | screen source, `ics-forms.db.test.ts`                  |
| 8   | Plain professional language  | pass (hand review): forms named by number and title, the edition shown as a hint, blocks named in words                                                                            | screen source                                          |
| 9   | Spanish                      | not applicable: staff screen                                                                                                                                                       | plan                                                   |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                                                                 | `styles.css`                                           |
| 11  | Authentication (WCAG 3.3.8)  | not applicable: the console session                                                                                                                                                | —                                                      |
| 12  | Shared-device privacy        | pass: staff names and positions only on every form; no resident                                                                                                                    | screen source, `ics.test.ts` (no resident on any form) |
| 13  | Non-map alternative          | pass: the 201's sketch block is a table of places, with the situation map as the drawing                                                                                           | `forms.ts`                                             |

The PDFs are tagged (PDF/UA-1) and checked by veraPDF in CI (`packages/reporting/src/samples.ts`).

Open: check 2 (screen reader).

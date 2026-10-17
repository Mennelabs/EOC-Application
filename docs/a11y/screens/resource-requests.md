# Console Resource requests screen: accessibility record

Screen: the console's **Resource requests** workspace (`/console/resource-requests`, `apps/web-console/src/screens/resource-requests.tsx`). It holds:

- a form to draft a request in the ICS 213 RR blocks: event, priority, delivery location, position, lines (count, unit, kind, type, description), cost, substitutes, sources, notes;
- filters by event and status, and a captioned table of requests most urgent first with their status, source and last change;
- per row: show, change, submit, approve, finance reply, place, en route, received, cancel (each only for the role that may);
- a place form (with the state or locally, the state's number, supplier, order number, ETA) and a finance reply form;
- a detail panel: the request's blocks, its lines and its history with who and when.

CON-13, 2026-10-17.

| #   | Check                        | Result                                                                                                                                                             | Evidence                                      |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 1   | Keyboard only, focus visible | pass: every control is a native button, input, select or textarea; line groups are labelled "Line n"; confirmations open the shared dialog                         | `tests/e2e/console-screens.spec.ts`           |
| 2   | Screen reader                | **pending a person**. One h1; h2 per form and the detail; tables have captions and headers; the detail is a definition list; every action button names its request | axe; a tester records the pass here           |
| 3   | 200 % zoom / 320 px          | pass (automated): no sideways page scrolling at the phone width; wide tables scroll inside their region                                                            | `console-screens.spec.ts` (phone project)     |
| 4   | Contrast                     | pass (automated: axe, both themes in the preview)                                                                                                                  | axe, `tools/preview/console-preview.mjs`      |
| 5   | Not by colour alone          | pass: status is words ("Submitted: waiting for approval", "Placed with the state (SEMA-EX-4471)", "finance has not replied")                                       | screen source                                 |
| 6   | Time limits                  | pass: none                                                                                                                                                         | —                                             |
| 7   | Errors                       | pass: a line without a count, a missing event or a refused approval say so in the status line in words ("A second person approves a request as section chief…")    | screen source, `resource-requests.db.test.ts` |
| 8   | Plain professional language  | pass (hand review): the 213 RR blocks are named in words, no block numbers on the screen; reasons are asked for in the dialog                                      | screen source                                 |
| 9   | Spanish                      | not applicable: staff screen                                                                                                                                       | plan                                          |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                                                 | `styles.css`                                  |
| 11  | Authentication (WCAG 3.3.8)  | not applicable: the console session                                                                                                                                | —                                             |
| 12  | Shared-device privacy        | pass: staff names and positions only; a line is a count of things, never a resident                                                                                | screen source, plan §12                       |
| 13  | Non-map alternative          | not applicable: no map                                                                                                                                             | —                                             |

Open: check 2 (screen reader).

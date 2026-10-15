# Console resource discovery screen: accessibility record

Screen: the console's **Resource discovery** workspace (`/console/discovery`, `apps/web-console/src/screens/discovery.tsx`). Layer 7, task F4, 2026-10-15. It has:

- "Find now" and "Refresh";
- a "Show" select (waiting, qualified in, set aside);
- the table of places found, each name a button that opens the place;
- the place itself, as one labelled region with a heading:
  - what it is and where it came from;
  - whether it is near unmet need;
  - where it is;
  - what the source states and what is unknown;
  - the source links (new tab, said in words);
  - the pre-check as a table;
  - the decision form;
- recent runs;
- for those who manage discovery, the county's sources: a table with "Switch on/off" buttons naming the source, and a form to add one.

| #   | Check                        | Result                                                                                                                                                                                                                                                                             | Evidence                                           |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Keyboard only, focus visible | pass (automated for the journey): native buttons, selects and inputs. Each place is a button with its name. Wide tables scroll in focusable regions.                                                                                                                               | `tests/e2e/console-l7.spec.ts` (discovery journey) |
| 2   | Screen reader                | **pending a person**: the place is a region named by its heading. Tables are captioned with column headers. Outcomes come in status lines. Links that open a new tab say so in hidden text.                                                                                        | axe; a tester records the pass here                |
| 3   | 200 % zoom / 320 px          | pass (automated): no sideways page scrolling.                                                                                                                                                                                                                                      | `console-l7.spec.ts` (phone project)               |
| 4   | Contrast                     | pass (automated: axe on the queue and on an open place)                                                                                                                                                                                                                            | axe                                                |
| 5   | Not by colour alone          | pass: "Near unmet need" and each pre-check result are words                                                                                                                                                                                                                        | screen source                                      |
| 6   | Time limits                  | pass: none; the queue refreshes only when asked                                                                                                                                                                                                                                    | screen source                                      |
| 7   | Errors                       | pass: "Record the decision" stays off until a reason is given, and "Add the source" until a name and address are given. The server's refusals are shown with their reason: a feed address that is not public https, a second web search, a stale version, a decision already made. | `services/api/test/discovery.db.test.ts`           |
| 8   | Plain professional language  | pass (hand review): "Qualify in", "Set aside", "Needs information first", and the reasons from the recommendation rules                                                                                                                                                            | screen source                                      |
| 9   | Spanish                      | not applicable: staff screen. The digest and alert emails are in English and Spanish.                                                                                                                                                                                              | `services/worker/src/jobs/templates.ts`            |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                                                                                                                                                                 | `styles.css`                                       |
| 11  | Authentication (WCAG 3.3.8)  | not applicable here                                                                                                                                                                                                                                                                | none                                               |
| 12  | Shared-device privacy        | pass: public places only; no resident's details; partner contacts are not shown                                                                                                                                                                                                    | `services/worker/src/jobs/discovery.ts`            |
| 13  | Non-map alternative          | pass: each place's address and coordinates are text                                                                                                                                                                                                                                | screen source                                      |

Open: check 2 (screen reader).

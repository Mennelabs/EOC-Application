# Console Subscription screen: accessibility record

Screen: the console's **Subscription** workspace (`/console/subscription`, `apps/web-console/src/screens/subscription.tsx`). Read only. It holds:

- a short explanation: annual contracts per jurisdiction, tiered by population served, and state or coalition contracts that cover member jurisdictions;
- a panel headed "Resident reports are never counted or capped";
- one sentence saying whether a subscription is in force today;
- the contracts in a captioned table: whose contract, tier, population served, term, status and what it covers.

SCL-10, 2026-10-16.

| #   | Check                        | Result                                                                                                                                                       | Evidence                                  |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 1   | Keyboard only, focus visible | pass: nothing to operate but the table region, which takes focus so the arrow keys scroll it on a phone                                                      | `tests/e2e/console-screens.spec.ts`       |
| 2   | Screen reader                | **pending a person**. One h1, two h2, the table has a caption and column headers; the in-force sentence is plain text                                        | axe; a tester records the pass here       |
| 3   | 200 % zoom / 320 px          | pass (automated): no sideways page scrolling at the phone width                                                                                              | `console-screens.spec.ts` (phone project) |
| 4   | Contrast                     | pass (automated: axe with the exercise contracts shown)                                                                                                      | axe                                       |
| 5   | Not by colour alone          | pass: status is words ("In force", "Expired", "Cancelled", "Signed; starts …", "Term ended …")                                                               | screen source                             |
| 6   | Time limits                  | pass: none                                                                                                                                                   | —                                         |
| 7   | Errors                       | pass: a failed load says what failed in the error line; a role without the subscription is told so in words                                                  | screen source, `license.db.test.ts` (403) |
| 8   | Plain professional language  | pass (hand review): dates in words ("July 1, 2026"), populations with separators, "Covered by …" rather than ids; other jurisdictions are counted, not named | screen source                             |
| 9   | Spanish                      | not applicable: staff screen                                                                                                                                 | plan                                      |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                                           | `styles.css`                              |
| 11  | Authentication (WCAG 3.3.8)  | not applicable: nothing to sign or enter                                                                                                                     | —                                         |
| 12  | Shared-device privacy        | pass: nothing personal is on the screen                                                                                                                      | screen source                             |
| 13  | Non-map alternative          | not applicable: no map                                                                                                                                       | —                                         |

Open: check 2 (screen reader).

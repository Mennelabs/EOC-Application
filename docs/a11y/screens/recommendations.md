# Console recommendations screen: accessibility record

Screen: the console's **Recommendations** workspace (`/console/recommendations`, `apps/web-console/src/screens/recommendations.tsx`). Layer 7, task E3, 2026-10-15. It has:

- the event picker;
- "Ask for a recommendation": one labelled select (shelter, feeding stops, POD and walk-up points, MARC) and "Work it out";
- the answer, as one labelled region with a heading. It holds:
  - the demand in a sentence;
  - the places recommended, as a table with reasons and unknowns;
  - for feeding, the canteens and the stops; for a POD, the supplies and walk-up points; for a MARC, the partner mix and the interpreters;
  - what would change the answer;
  - the places set aside and why;
  - the inputs and their age;
  - the equity check;
- the decision form (decision, the place or stop, the reason, an optional note);
- the list of recommendations for the event, each with a "Show" button.

| #   | Check                        | Result                                                                                                                                                                                                                                                               | Evidence                                                         |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Keyboard only, focus visible | pass (automated for the journey): native selects, inputs and buttons. Each "Show" button names its recommendation and time. Wide tables scroll in focusable regions.                                                                                                 | `tests/e2e/console-l7.spec.ts` (recommendations journey)         |
| 2   | Screen reader                | **pending a person**: the answer is a region named by its heading, and each part has its own heading. Every table is captioned and has column headers. Reasons are lists. Outcomes come in status lines.                                                             | axe; a tester records the pass here                              |
| 3   | 200 % zoom / 320 px          | pass (automated): no sideways page scrolling. Tables scroll inside their own labelled regions.                                                                                                                                                                       | `console-l7.spec.ts` (phone project)                             |
| 4   | Contrast                     | pass (automated: axe on each of the four kinds and on the decision form)                                                                                                                                                                                             | axe                                                              |
| 5   | Not by colour alone          | pass: "Stale: check it" and "Unknown" are words, and high-need areas left out are listed in text                                                                                                                                                                     | screen source                                                    |
| 6   | Time limits                  | pass: none                                                                                                                                                                                                                                                           | none                                                             |
| 7   | Errors                       | pass: "Record the decision" stays off until a reason (3 characters or more) is given and, for an edit, a place. The server's refusals are shown with their reason: a stale version, an already decided recommendation, a place not in the registry, an unknown stop. | `services/api/test/recommendations.db.test.ts`                   |
| 8   | Plain professional language  | pass (hand review): reasons read as sentences with their numbers ("14,000 sq ft at 40 sq ft each", "23% of households in Cedar Ridge have no vehicle")                                                                                                               | screen source, `packages/reporting/test/recommend-sites.test.ts` |
| 9   | Spanish                      | not applicable: staff screen                                                                                                                                                                                                                                         | plan                                                             |
| 10  | Reduced motion, no flashing  | pass: no animation, no map                                                                                                                                                                                                                                           | `styles.css`                                                     |
| 11  | Authentication (WCAG 3.3.8)  | not applicable here                                                                                                                                                                                                                                                  | none                                                             |
| 12  | Shared-device privacy        | pass: counts and places only; no resident's name, contact or address                                                                                                                                                                                                 | `recommend-load.ts`                                              |
| 13  | Non-map alternative          | pass: every place is named in text with its distance and reasons; there is no map to replace                                                                                                                                                                         | screen source                                                    |

Open: check 2 (screen reader).

Planning factors (ADM-01, 2026-10-16): a table with a caption and column headers. Each row's header is the factor in plain words, with its unit, and is the label of that row's field. The default is in its own column and also in the field's placeholder, so it is never only a hint that disappears. A value that is not a number above zero is named next to the field, which is marked invalid; Save stays off until it is fixed. Saving opens the confirmation dialog for a reason. `tests/e2e/console-screens.spec.ts` (ADM-01, REC-12) runs axe and reflow on desktop and phone.

Event templates (ADM-01, CON-02, 2026-10-16): each template's Edit button names the template. The form has a heading, labelled fields, the keyword rule as a hint tied to the field and a wrong keyword named in an alert, map layers as a checkbox group with a legend, and each message in its own fieldset with its English and Spanish fields marked with their language. `tests/e2e/console-screens.spec.ts` (ADM-01, CON-02) runs axe and reflow on desktop and phone.

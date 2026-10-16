# Console Single sign-on screen: accessibility record

Screen: the console's **Single sign-on** workspace (`/console/sso`, `apps/web-console/src/screens/sso.tsx`). It holds:

- what to give the county's identity provider: entity ID, reply address and our metadata address, in a description list;
- the provider in force, with whether it is on the sign-in page yet, and the switch-off button;
- a provider waiting for approval, with Approve and Decline for a second administrator;
- the proposal form: the kind (SAML or OpenID Connect) as radio buttons in a fieldset, the sign-in button text, and either the metadata text area or the OpenID Connect addresses, client ID and client secret;
- earlier settings in a captioned table.

SEC-07, 2026-10-16.

| #   | Check                        | Result                                                                                                                                                                                            | Evidence                            |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | Keyboard only, focus visible | pass (automated for the journey): native radio buttons, inputs, text area and buttons; the buttons say what they do ("Approve single sign-on", "Switch off single sign-on")                       | `tests/e2e/sso.spec.ts`             |
| 2   | Screen reader                | **pending a person**. Values are a description list, outcomes are a status line, and the client secret is a labelled password field with its handling as the hint.                                | axe; a tester records the pass here |
| 3   | 200 % zoom / 320 px          | pass (automated): long addresses wrap inside their code elements; no sideways page scrolling at 320 px                                                                                            | `sso.spec.ts` (320 px viewport)     |
| 4   | Contrast                     | pass (automated: axe on the empty form with metadata pasted, and on the provider in force)                                                                                                        | axe                                 |
| 5   | Not by colour alone          | pass: status is words ("In force", "Waiting for a second administrator", "On the sign-in page since …")                                                                                           | screen source                       |
| 6   | Time limits                  | pass: none                                                                                                                                                                                        | —                                   |
| 7   | Errors                       | pass: a missing button name, missing metadata, an address that is not https and a missing client ID or secret are named next to their fields; the server's metadata checks come back on the field | `services/api/test/sso.db.test.ts`  |
| 8   | Plain professional language  | pass (hand review): what single sign-on changes, that the passkey stays, and that only invited people get in, in words; why an approval is refused (a second administrator)                       | screen source                       |
| 9   | Spanish                      | not applicable: staff screen                                                                                                                                                                      | plan                                |
| 10  | Reduced motion, no flashing  | pass: no animation                                                                                                                                                                                | `styles.css`                        |
| 11  | Authentication (WCAG 3.3.8)  | pass: metadata and addresses are pasted, not typed from memory; the county's own sign-in page and the passkey replace remembering a password                                                      | screen source, `sso.spec.ts`        |
| 12  | Shared-device privacy        | pass: the client secret is never shown again (a password field, cleared after sending); nothing personal is on the screen                                                                         | `sso.db.test.ts`                    |
| 13  | Non-map alternative          | not applicable: no map                                                                                                                                                                            | —                                   |

Open: check 2 (screen reader).

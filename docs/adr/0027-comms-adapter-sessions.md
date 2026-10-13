# ADR-0027: Text and voice on the same graph through a signed-webhook adapter with a local simulator

- Status: accepted
- Date: 2026-10-12
- Requirements: CHN-01, CHN-03, CHN-04, CHN-05, CHN-09, INT-05, INT-06, SEC-10, SEC-17, BRD:FR-17.05, SCL-11, SCL-12, docs/06

## Decision

Texts and calls run the same question graph as the web app through one numbered dialogue (`packages/intake/dialogue.ts`): a node renders as a short prompt with numbered choices, a reply (digits, number words, option words, yes/no) parses back into the same answer shape, and the keywords in `docs/06` (DAMAGE/DAÑOS, HELP/AYUDA, STOP/ALTO and the carrier words, BACK, SKIP) always work. Session state lives in `cg.intake_session` with the answers encrypted; each inbound text or call step loads it, applies the reply, saves it and answers. A finished session goes through the one submission path (`submitIntake`) the web route uses, so one report record exists whatever the channel (CHN-01); the channel's own reply carries the reference code and the worker sends no second confirmation.

Carrier traffic arrives through Twilio webhooks under `/api/webhooks/twilio/*`. Every request must carry a valid `X-Twilio-Signature` for the account's auth token; without a configured token nothing is accepted. The tenant is the county whose verified number the message was sent to (`cg.channel_number`, admitted to a public lookup by a transaction-local setting, as slugs are). Outbound texts go through the `SmsSender` adapter: the simulator locally, Twilio's REST API when the account is configured; delivery receipts update the message row. On synthetic data the API also exposes a simulator (`/api/webhooks/simulator/sms` and `/voice`) that plays the phone, so the whole flow runs on a laptop without a carrier and the test suite drives it end to end.

## Alternatives considered

| Option                                  | Why not                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Twilio Studio flows for the dialogue    | The questions would live in a vendor console, outside the graph, its versioning and the reading-level lint. |
| A second question set written for texts | Two sets drift; CHN-01 wants one record and INT-01 one configurable graph.                                  |
| The Twilio Node SDK                     | One REST call and one HMAC are all that is needed; fewer dependencies to scan and no SDK pinning.           |
| Accepting webhooks by IP allow-list     | Twilio's addresses change; the signature proves the account, the allow-list only the network.               |
| Resuming voice sessions by call id      | A dropped call would lose the answers; the number keeps them, as it does for texts.                         |

## Why it fits SCL-11 and the government-cloud move

The carrier is configuration (two secrets and one number per county); the simulator is the local stand-in and disappears on production data (SCL-12). Webhooks reach a laptop only through a secured tunnel (CLAUDE.md rule 3). Nothing in the containers changes between Docker Desktop and the cloud.

## Consequences

Residents can start by text and finish on the web with their reference code (CHN-09, with the resident app in G). Spanish texts cost more segments (UCS-2); the fixed phrases are kept short and tested against a segment budget. A voice caller presses 0 or says "agent" to reach the county line, star for "don't know", and hears the reference code twice. Real Twilio numbers need toll-free verification before go-live (docs/06, CHN-04).

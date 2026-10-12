# ADR-0016: Twilio behind a `comms` adapter, with a local simulator

- Status: proposed
- Date: 2026-10-12
- Requirements: CHN-03/04/05, PUB-08/09, FL-11, DSP-06, BRD:FR-17.05, docs/06

## Decision
The `comms` adapter exposes `sendSms`, `startCall`, `parseInbound` and `parseStatus`. The Twilio implementation uses one verified toll-free number per county (fixed decision), validates `X-Twilio-Signature` on every webhook, and records provider evidence for each delivery state. IVR flows run in Twilio Studio and call back into our API. Locally a simulator implements the same interface and has a page in the console where a developer can "text" or "call" the system. Keywords and templates come from docs/06 and live in tenant config.

## Alternatives considered
| Option | Why not |
| --- | --- |
| Vonage, Bandwidth, AWS Pinpoint/End User Messaging | Twilio is the fixed decision; the adapter keeps a switch possible. |

## Why it fits SCL-11 and the government-cloud move
Only credentials and the public webhook URL change. In development, webhooks reach a laptop only through a secured tunnel (SCL-12).

## Consequences
Message wording is linted in CI against docs/06 rules (no "emergency alert" phrasing, STOP/HELP footer present).

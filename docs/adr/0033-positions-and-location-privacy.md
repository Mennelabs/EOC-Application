# ADR-0033: Positions only while checked in, seen only by dispatch and safety roles, kept 30 days

- Status: accepted
- Date: 2026-10-13
- Requirements: DSP-08, DSP-07, FLD-16, FLD-03, SEC-13, SEC-05, SEC-18, ADM-05, CON-03, PUB-05, RULE-03, DSP-05

## Decision

The phone shares its location only while the responder is checked in, shows a sharing indicator the whole time, and stops at check-out; the server refuses a position from someone not checked in (`409 not_checked_in`). Positions are append-only facts in `cg.position`, partitioned by day, and whole days older than 30 are dropped by the worker with the deletion logged per tenant (SEC-13). Net control can record a position heard on the radio against a team (DSP-10); it is marked as such.

Only roles that hold `position.read` see positions (dispatch, safety, the field coordinator, an agency's dispatcher for its own teams); the tenant-wide `*` grant never reaches it. The tenant sets a precision (`field.position_precision_m`, default exact for those roles); the board, the latest positions and the situation map snap to it. A help alert always carries the exact position whatever the precision, because someone may need to be found (plan §12.1). "Arrived" and "left" are suggested from location and confirmed by the team, never set automatically (RULE-03, DSP-05).

On the situation map (`GET /situation`) each layer is checked on its own read action. Report and need points are rounded to about a kilometre unless the role holds the exact-location category, and exact reads are audited (SEC-18); confidential sites never appear (PUB-05). A county shelter can be run by a partner (`site.operator_tenant_id`, migration 0039): the operator reads and updates that one site and confirms its census, the county keeps ownership and sees the confirmed occupancy, not the households (ADM-05). Flagged for Adam in the layer-4 status.

## Alternatives considered

| Option                                           | Why not                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Always-on tracking while the app is open         | Location of volunteers off shift is not needed for safety and is a privacy harm; Q-07 asked for shift-only. |
| Rounding in the client                           | The exact point would still cross the wire; rounding is server-side.                                        |
| One retention for all field data                 | Trails are the most sensitive and least needed later; SEC-13 sets 30 days for them.                         |
| Showing partner shelter households to the county | The partner holds its guests' details; a share would need an agreement like the needs board's.              |

## Why it fits SCL-11 and the government-cloud move

Partitioning and the drop are plain PostgreSQL; the precision is tenant configuration. Nothing depends on a location service outside the stack.

## Consequences

Dispatch sees where teams are while they work and nobody sees them afterwards. A role without position reads gets a board with teams but no points. Help alerts are always findable. Tests: `field.db.test.ts`, `siteoperator.db.test.ts`, `tests/integration/layer4.int.test.ts`.

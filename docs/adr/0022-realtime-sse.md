# ADR-0022: Server-Sent Events for live console updates

- Status: proposed
- Date: 2026-10-12
- Requirements: NFR-07, CON-03/04, DSP-01, CON-08, finding G-05

## Decision

Live updates reach the console as Server-Sent Events from the API, fed by a RabbitMQ fan-out exchange per tenant/event. Each event carries record type, ID and version; clients refetch through the normal authorized API, so live updates never bypass authorization.

## Alternatives considered

| Option                          | Why not                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| WebSockets                      | Two-way is not needed for these views; SSE works through standard proxies and reconnects automatically. |
| Polling                         | Simple, but wasteful at surge and slower.                                                               |
| Postgres LISTEN/NOTIFY directly | Couples API instances to DB connections; fine as a source for the exchange, not for fan-out.            |

## Why it fits SCL-11 and the government-cloud move

Plain HTTP; works behind ALB/ingress with idle-timeout tuning.

## Consequences

Every live view shows "as of" time and a reconnecting state.

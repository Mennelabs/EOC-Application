# ADR-0034: The live stream reads the change feed; RabbitMQ only wakes it

- Status: accepted
- Date: 2026-10-13
- Requirements: NFR-07, DSP-01, DSP-02, DSP-07, DSP-09, DSP-12, FLD-16, SEC-05, SCL-06, ADR-0022

## Decision

ADR-0022 chose Server-Sent Events. Layer 4 fixes how they are fed. Every write leaves a row in `cg.change_feed` (a trigger, inside the writing transaction) naming the record type, id, version, tenant and scope, and nothing else. The worker relays new rows to a RabbitMQ fan-out exchange as small notices; each API instance listens and wakes the open streams whose tenant subtree covers the row. A woken stream reads the feed itself, under the caller's row security, and sends `change` frames with the feed position as the event id. A browser that reconnects sends `Last-Event-ID` and resumes from there; a stream with no broker falls back to polling the feed every two seconds (SCL-06). A frame carries only identifiers; the screen fetches the record through the normal API, so the stream never bypasses authorization or field protection. A partner's stream carries only its own subtree (DSP-09).

The console reads the stream with `fetch` rather than `EventSource`, so the token goes in a header, never in the URL. Board replay (`GET /dispatch/replay`, DSP-12) is built from the same facts.

## Alternatives considered

| Option                                | Why not                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Push full records over the broker     | Records would bypass row security and field protection; the broker would hold resident details. |
| PostgreSQL LISTEN/NOTIFY per stream   | One connection per open screen; does not fan out across API instances.                          |
| WebSockets                            | Two-way is not needed; SSE resumes by id for free and passes every proxy.                       |
| `EventSource` with a token in the URL | Tokens in URLs end up in logs.                                                                  |

## Why it fits SCL-11 and the government-cloud move

RabbitMQ is the stack's queue (ADR-0007) and has managed equivalents; the notices are tiny and can be lost without harm because the feed is the record. API instances scale out behind the gateway with no sticky sessions.

## Consequences

A help alert reaches every dispatcher's screen within the wake interval (the stack suite measures it). A lost notice delays a screen by at most the poll floor. The feed grows with every write and is not pruned yet; a worker job that drops rows older than the longest resume window (and older than the field app's sync cursor horizon) is a known follow-up in the layer-4 status. Load profile: `tests/load/field.js`.

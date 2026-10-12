# ADR-0026: Filing submissions with one idempotent function behind a queue consumer and a stored-row sweep

- Status: accepted
- Date: 2026-10-12
- Requirements: BRD:FR-11.01, BRD:FR-11.04, AC-11B, SCL-03, SCL-06, INT-22, PHO-06, PHO-07, PHO-15, SEC-10, CHN-03

## Decision

The API accepts a submission by publishing an encrypted message to the `intake.submissions` quorum queue with publisher confirms and writing the same encrypted payload to `cg.intake_submission` (status `queued`, or `stored` when the queue is down). The worker files submissions through one function, `fileSubmission`, keyed on the execution id: the queue consumer calls it for each message, and a ten-second sweep calls it for stored rows and for queued rows nobody filed within two minutes. Filing is a single transaction that writes the party, location, report, needs, consent, after-saving answers and photo bindings, binds the reference code, enqueues the confirmation through the outbox and records the audit event. A duplicate execution id is a no-op; a unique-violation race ends the same way. Rows that keep failing are kept with their error for a person; nothing is deleted.

Photos are processed by the worker with `sharp`: the original stays under a restricted prefix, derivatives carry no metadata, the image interface is asked for sensitive regions, and when the provider has no detector the status says so and the derivatives stay restricted. Messages to residents are rows in `cg.message` (recipient and body encrypted) sent through the mail adapter or the SMS adapter (simulator locally), idempotent by outbox id, and texts go only to numbers that opted in, except the one-time code the resident asked for.

What a reviewer must know about a filed report (same answers, same address or same photo bytes as another report; verification suggested by the abuse score; AI-assisted answers) is recorded as flags on the report, never as a state change: a person decides.

## Alternatives considered

| Option                                           | Why not                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| File the report synchronously in the API request | A database hiccup would fail a resident submission (rule 8); the queue path stays fast under SCL-03 load.    |
| Queue only, no database copy                     | A lost message would lose a report; the row is the durable fallback and the sweep its retry.                 |
| Database only, polled by the worker              | Polling at 50,000 submissions per hour is a load the queue is built for; the row path stays as the fallback. |
| Mark duplicates as `duplicate` automatically     | A machine judgement would close a resident's report (BRD:FR-12.04); flags inform, reviewers decide.          |
| Store photo derivatives public once blurred      | No validated detector exists yet (PHO-07); until one does, nothing public shows a resident photo (PHO-08).   |

## Why it fits SCL-11 and the government-cloud move

The queue, the database and the object store are the layer-1 adapters; the image library is a Node dependency with prebuilt binaries for the Alpine image; the SMS sender is an interface with the simulator as the local stand-in. Nothing changes between Docker Desktop and the cloud but configuration.

## Consequences

The resident has a reference code the moment the API answers, and the record follows within seconds (queue) or within the sweep interval (fallback). Every report has exactly one filing audit event. Reviewers see flags with reasons and the reports they point to. HEIC photos are converted on the device before upload (the prebuilt image library has no HEIF decoder); a file that cannot be decoded is marked failed and the report stands without it.

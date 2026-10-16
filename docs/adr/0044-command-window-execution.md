# ADR-0044: The command window runs catalogued actions through the console's own operations, bound to a confirmed plan

- Status: accepted (Section 30.2 defaults approved by Adam 2026-10-15; phases 1 and 2 on by default)
- Date: 2026-10-15
- Requirements: CMD-01–CMD-38, BRD:FR-C01–C11, AC-C01–C12, BP-05, NFR-06, NFR-10, NFR-11, RULE-05, RULE-14, RULE-15, RULE-18, AC-02C, AC-08C, AC-12B, GATE-08, BRD:DEC-16

## Decision

- **The action catalog becomes the command catalog** (`packages/authz/src/actions.ts`). Each command entry adds:
  - a version and an argument schema (zod);
  - target and scope rules, and prerequisites;
  - a confirmation class: none, one tap, full review or second person;
  - side effects, idempotency behaviour and a result schema;
  - a reversal policy: undo within 15 minutes, a compensating action, or none.
- **Only catalogued actions run.** Anything else is answered as unsupported.
- **Two ways in, one plan.**
  - Shorthand is parsed without a model, so it works with AI off.
  - Natural language goes to the language model, which may only return a plan in the catalog's schema.
  - The server resolves names to stable ids among records the person may see, asks when more than one matches, and shows the interpretation.
- **A plan is confirmed, then executed.**
  - The confirmation is bound to the plan's hash, the record versions, the person and the scope. Any material change prepares the plan again and asks again.
  - Authorization is checked when the plan is prepared and again at confirmation.
- **The executor calls the same HTTP operations the console calls**, in process (Fastify `inject`), with the person's own credentials, the execution id as the idempotency key, and the expected versions. Validation, authorization, locks, versions, idempotency and audit are the manual path's own.
- **Results come from each operation's response.** A multi-step plan reports every step and never claims a rollback it did not do.
- **Executions are kept.** `command_execution` holds the full record for the audit retention. Personal conversations are kept 30 days and can be cleared.

## Alternatives considered

| Option                                                            | Why not                                                                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A tool-calling agent that calls the database or services directly | A second implementation of every action: validation, locks and audit would drift from the console's (NFR-11).                     |
| Let the model choose and execute without a stored plan            | Nothing to bind a confirmation to; a change between preview and confirm would go unnoticed (AC-C04, AC-C05).                      |
| Call the API over the network from a separate command service     | Same effect as in-process calls, plus another container, another credential path and network latency against the 2-second target. |

## Why it fits SCL-11 and the government-cloud move

The executor lives in the API process and adds no service. The language model sits behind the provider interface (ADR-0043), so the command window's model changes with configuration when the provider moves.

## Consequences

- A command can never do what the person could not do by hand.
- Each new console operation becomes a command by adding a catalog entry, not code in the executor.
- The executor depends on operations returning precise results, so routes that answer vaguely are fixed as they are catalogued.
- In-process calls must carry the person's identity exactly, including emergency access and the enclave link, and are tested for it.

## Addendum 2026-10-15: batches (CMD-30)

- A batch is a catalog entry with a filter, not a new kind of operation. The executor lists the records through the console's own list route as the person may see them, puts their ids, versions and labels in the plan (so the confirmation is bound to exactly those records), and then calls the single-record operation once per record, each with its own idempotency key derived from the execution and the record.
- Batches are phase 4, so they are off until a county turns that phase on, and they need the explicit action `command.bulk` as well as each record's own action. The shipped templates grant it to the county EM director, mass care coordinator, NGO incident commander and COAD chair.
- Limits follow Section 30.2. Up to 50 records take one confirmation. From 51 to 500, the person must also type the count. Over 500 is refused, so the person narrows the filter or uses the screen. The limit of 30 confirmed commands a minute counts a batch as one command.
- The result names every record that was not changed and why. The execution ends as succeeded, partially succeeded (migration 0075) or failed. It is never "rolled back", because each change that succeeded stands, and the reverse batch (release) is the compensating action.

## Addendum 2026-10-16: exports (CMD-16)

- Section 30.2 places exports with neither lookups nor drafts. The window treats them as confirmed changes: the IDA package and an issued report's file are phase 3 with one tap, and a public-records release is phase 4 with the full review and a reason (RULE-14), which its route also demands. All are off until a county turns their phase on.
- The plan states the scope and the period: the IDA package covers every jurisdiction and the whole event; a report is named by its kind and number (or the latest issued one) and shows its own period; a release names its request, the kinds of record and the dates.
- Reports are a target kind of their own, listed through the console's route and narrowed to issued or superseded ones, so a draft is never found (RULE-10).
- An export is answered as queued, never done. The answer names the screen that lists the file once the worker builds it, and nothing is sent anywhere.
- The request reference of a release is free text (it may carry a requester's name), so the execution keeps only its digest once the command has run (CMD-37).

## Addendum 2026-10-16: report review (CMD-15)

- A reviewer can take a report into review (phase 3, one tap), approve or reject it, or ask the resident for more information (phase 4, the full review with a reason). Approvals and outbound messages are phase 4 in Section 30.2.
- The decision's own reason and evidence references go to the review decision row, as on the review screen. The reason and the question are free text, so the execution keeps only their digests once run (CMD-37).
- A decision never changes the verification level, and the plan says so. A public observation stays an observation until someone verifies it.
- The author of a report never reviews it (A7). The route's guardrail refuses it, from the window as from the screen.

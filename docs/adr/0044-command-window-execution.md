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

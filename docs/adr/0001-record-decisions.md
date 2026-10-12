# ADR-0001: Record technology decisions as ADRs

- Status: accepted
- Date: 2026-10-12
- Requirements: SCL-15

## Decision

Every technology choice (language, framework, database access, queue, identity, React Native libraries, map servers, test tools) gets a short record in `docs/adr/` using `0000-template.md`. Records are numbered, never deleted, and superseded by a newer record when a choice changes.

## Alternatives considered

| Option                          | Why not                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| Decisions in the README or wiki | Not versioned with the code; SCL-15 asks for records in the repository. |

## Why it fits SCL-11 and the government-cloud move

GovRAMP/NIST 800-53 assessors ask for configuration-management evidence (CM-3, SA-8). ADRs give them a dated trail.

## Consequences

A pull request that adds a dependency of architectural weight must add or update an ADR.

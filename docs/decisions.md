# Decision log

Dated record of decisions made during the build, so no decision lives only in a chat transcript. Requirement-level decisions already in `docs/0*` are not repeated; this log covers how the build is run and answers to the open questions in `docs/requirements-index.md` (Q-01–Q-07) and `docs/plans/layer-1.md` §8.

| Date | Decision | By | Where it applies |
| --- | --- | --- | --- |
| 2026-10-12 | Stack choice delegated ("you decide and proceed"); ADRs 0002–0023 recorded as *proposed* until reviewed in PR #1 | Adam | `docs/adr/` |
| 2026-10-12 | Repository default branch `claude/determined-gates-zd5i8m`; `main` created at the hand-off commit as the PR base; layer work continues on the designated branch and appears in PR #1 | Adam | git |
| 2026-10-12 | Start layer 1 with the plan's §8 defaults pending confirmation: second administrator = any other tenant-admin account, never the requester or a break-glass session; break-glass read-only, default 4 h, max 24 h; audit retention floor 7 years; staff MFA fallback TOTP only by audited tenant exception, never SMS; hierarchy reads only through signed agreements | Adam ("start L1") | `packages/authz`, migrations 0005–0007 |
| 2026-10-12 | Coordination: `docs/plans/layer-N-status.md` is the resume record; one task per commit; `docs/decisions.md` is the decision record; single session unless Adam enables the fan-out described in the status file | Adam ("Go") | this repository |

## Open (defaults in force until answered)

| ID | Question | Default in force |
| --- | --- | --- |
| Q-01 | PHO-09/13 built but switched off pending a validated model: acceptable for release 1? | built, off |
| Q-02 | Email provider | Mailpit locally only |
| Q-03 | Google Maps Platform (CON-14) or self-hosted router | self-hosted router behind an adapter |
| Q-04 | Waze for Cities per-tenant integration | adapter + file stand-in; staff entry fallback |
| Q-05 | Legacy system for migration (no ARK relationship) | generic tenant import only |
| Q-06 | Web-search source for REC-13 resource discovery | tenant-supplied source list |
| Q-07 | Paid background-GPS library for the field app | `expo-location` |
| §8 | Layer-1 ambiguities 1–5 | as listed above |

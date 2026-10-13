# Layer 4 status: missions, dispatch board, React Native field app

Resume record for layer 4 (plan: [`layer-4.md`](layer-4.md)). Chat history is not the record; this file is.

## Resume checklist

1. `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name` green before new work.
2. Stack for integration work: `scripts/init-env.sh` (or `scripts\init-env.ps1`) then `docker compose up -d --wait`; `COMPOSE_PROFILES=maps` for the tiles and geocoder.
3. Pick the first task below that is not `done`, finish it to green, commit citing requirement IDs, update this file, push.
4. Decisions from Adam go into `docs/decisions.md` before the code that depends on them.

## Tasks

| #   | Task                                                                                                                                   | State | Commits | Verified by | Notes               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ----------- | ------------------- |
| 0   | Layer-3 follow-up: partner administrators in the seed, partner workspace browser journey                                               | todo  |         |             | decision 2026-10-13 |
| A   | Migrations: people, teams, credentials, check-ins, devices, positions (partitioned), parcels; actions and role templates; seed         | todo  |         |             |                     |
| B   | Migrations: missions, assignments, hazards, messages, reminders, badges, logs, alerts, service logs, role records, sync; seed missions | todo  |         |             |                     |
| C   | Missions and assignments API, CALL-01 intake                                                                                           | todo  |         |             |                     |
| D   | Personnel, teams, credentials, check-in, devices, positions, team status, timers, safety alerts                                        | todo  |         |             |                     |
| E   | Hazards, messages and receipts, F09 reminders, badges and checkpoint verify, net control, activity and significant events              | todo  |         |             |                     |
| F   | Live stream, board snapshot, suggestions, replay; field sync API and area packages                                                     | todo  |         |             |                     |
| G   | `packages/field-core`                                                                                                                  | todo  |         |             |                     |
| H   | `apps/field` foundation                                                                                                                | todo  |         |             |                     |
| I   | Field modules 1                                                                                                                        | todo  |         |             |                     |
| J   | Field modules 2                                                                                                                        | todo  |         |             |                     |
| K   | Console screens                                                                                                                        | todo  |         |             |                     |
| L   | Tests: stack, browser (console and field web build), Android build, load smoke                                                         | todo  |         |             |                     |
| M   | Docs: ADRs 0032–0035, traceability, report, README, accessibility records                                                              | todo  |         |             |                     |

## Known issues and deferred items

- See `layer-4.md` §11 for deferred IDs, §12 for the readings taken in favour of safety and privacy, §14 for Adam's open questions and the defaults in force.

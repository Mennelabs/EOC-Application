# Subscriptions (SCL-10)

Each contract is an annual subscription for a jurisdiction, tiered by the population it serves. A state or coalition contract can cover its member jurisdictions. This page is for the platform's operators (the vendor's account team) and for county administrators.

## What never depends on a contract

**Resident reports are never metered or capped.** Web, text and phone reports are accepted whatever the plan, the tier or the term, and whether or not any contract is in force: intake never reads a contract. Two tests hold this:

- `services/api/test/license.test.ts` fails if any code but the Subscription view and the operator command names the contract table;
- `services/api/test/license.db.test.ts` sends a surge of reports to a county whose contracts are cancelled and expired, and every one is accepted.

Nothing else in the platform switches off when a contract ends either. A lapsed contract is a matter for the account team, not a switch.

## What a county sees

The console's **Subscription** screen (tenant administrators and emergency management directors) lists:

- the county's own contracts, with what each covers;
- contracts held above it (a state or coalition) that cover it. The county sees who holds it, the tier, term and status, and which of its own jurisdictions are on it. Other members are counted, not named.

It says in words whether a subscription is in force today, and always that resident reports are never counted or capped. Nothing on the screen can be changed.

## Recording a contract (operators)

Contracts are the vendor's record. No county role can write one: `license.write` is never reached by a wildcard grant and no shipped role holds it. Operators use the worker's command with the worker database role:

```bash
DATABASE_URL=postgres://cg_worker:…@host:5432/cg pnpm --filter @cg/worker license list state
DATABASE_URL=… pnpm --filter @cg/worker license add --holder state \
  --tier "State coalition" --population 6100000 \
  --start 2026-07-01 --end 2027-06-30 --covers region,county,city \
  --by "Your name" --reason "Signed renewal, contract reference"
DATABASE_URL=… pnpm --filter @cg/worker license status <contract id> expired \
  --by "Your name" --reason "Term ended without renewal"
```

- `--holder` and `--covers` take organization keys (slugs). A contract can cover only organizations below its holder, each once; the database refuses anything else, so a county cannot be put on another state's contract by mistake.
- The term ends after it starts. Population served is a whole number, or left out.
- Every change is in the holder's audit log with the operator's name and the reason.
- Status is `active`, `expired` or `cancelled`. "In force" on the screen means active and within the term, on the county's own calendar.

Tier names and population breakpoints are not decided yet (Section 21, deferred 2026-10-12), so the tier is stored as the contract states it.

## Exercise data

The synthetic seed gives the exercise state a coalition contract covering the region, Westwind County and Harmon City, and gives Westwind its own earlier contract, now expired. Both are invented.

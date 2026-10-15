# Partner work status (before layer 7)

Resume record for the partner work Adam ordered on 2026-10-15, before layer 7. Chat history is not the record; this file is.

## Start here (a fresh session)

1. Read `CLAUDE.md`, then this file, then `docs/decisions.md` (the 2026-10-15 rows from Adam's interview).
2. Run `pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm check:product-name`. Do not build on a red tree.
3. The plan is [`partners-before-layer-7.md`](partners-before-layer-7.md). Work the tasks below in order, one per pull request into `main`, each merged when CI is green and recorded here. Layer 7 ([`layer-7.md`](layer-7.md)) starts after task B.

## Tasks

| Task | What                                                                                                                                                                                                                             | State | Commits   | Notes                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------- | ---------------------------------------------------- |
| A    | Partners publish their own services: migration 0052, `site.post` and `site.post_publish`, `/partner/sites` routes, "Our services" screen, "Posted by" on the county's Sites and publication log, notices naming the organization | done  | (this PR) | As-built notes in the plan §A; one harness fix below |
| B    | Partner counts on the declaration view and official reports: roll up all, or choose partners and categories; counts-only function                                                                                                | next  |           | DCL:DEC-09, F15, RULE-10                             |

## Task A in detail

- **Data:** `cg.site.posted_by_tenant_id` (0052) with a check that it equals the operator; in the data dictionary (SEC-11).
- **Actions:** `site.post` (draft and change the organization's own services; explicit, not consequential) and `site.post_publish` (publish and withdraw them; explicit, consequential: dialog and reason, PUB-06). Both in the NGO incident commander template only; no wildcard reaches them.
- **API** (`services/api/src/routes/sites.ts`): `GET /partner/sites` (every site the partner runs), `POST /partner/sites`, `PATCH /partner/sites/:id`, `POST /partner/sites/:id/publish` and `/unpublish`. Only accounts of partner organizations; the county is the partner's parent; an event must be the county's; writes run in the county's context after authorization and touch only sites the partner posted; audit in the county's chain, attributed to the partner's account. Publish refuses a confidential site (PUB-05), a post with neither an address nor a map point, and alert-style wording in the name, notes or directions (docs/06); a change to a live post must still pass those checks.
- **Notices** (`services/worker/src/jobs/reminders.ts`): the publication row records the organization and the approver's name; the PIO's and publishers' notice says "by <approver> of <organization>".
- **Screens:** `apps/web-console/src/screens/our-services.tsx` (list, post, edit, publish, withdraw; confirm, full and open on every site the partner runs); `sites.tsx` gains the "Posted by" column and the publication log names the organization.
- **Tests:**
  - `services/api/test/siteoperator.db.test.ts` (partner posting: only the approver posts; foreign event refused; 428 without confirmation; live in the public view at once; publication in the county's log with the partner's approver; county sees "Posted by"; partner edits its own post only; other partners and county accounts refused; confidential refused; location and alert wording refused, also on a change to a live post; county withdraws; every step audited in the county's chain).
  - `services/worker/test/reminders.db.test.ts` (the notice names the organization and approver; a withdrawal names the organization).
  - `tests/integration/layer3.int.test.ts` (on the page, in the SHELTER reply and in both feeds within two minutes; the PIO's notice; the partner withdraws).
  - `tests/e2e/console-l3.spec.ts` (desktop and phone, axe on every screen: the partner posts and publishes, the county is told, sees who posted it and withdraws it).
  - `packages/authz/test/templates.test.ts` (only the NGO incident commander holds the two actions; no wildcard reaches them).
- **Harness fix:** `invitationLink` (`tests/e2e/support/console.ts`) read only the newest message to an invited address. Staff notices now reach invited accounts too, so a publication notice could land before the invitation was read; it now reads every message to the address.
- **Harness fix:** the layer-6 declaration journey (`tests/e2e/console-l6.spec.ts`) read the newest package row before the list had reloaded, so an earlier "Whole event" package of the same event (left by the database suites on the shared database) could be taken for the new one. It now waits for the new row before reading it.

## Open items

- REC-13 (partner posts as resource discovery's first source) is layer 7 and is built there.
- The county's own publish route has no wording filter or location requirement; the partner's has both. Whether the county's should gain them is a question for Adam, not changed here.

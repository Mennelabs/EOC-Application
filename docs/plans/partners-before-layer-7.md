# Partner self-posting and partner counts on reports (before layer 7)

Written 2026-10-15 from Adam's answers in the interview of that day (`docs/decisions.md`). This work comes before layer 7. It extends layer 3 (public information, partner workspace) and layer 6 (declaration and official reports). Everything from layers 1 to 6 keeps applying: RLS, audit of every write, idempotency, versions, the confirmation dialog with a reason (RULE-14), synthetic data only (SCL-12).

Adam's point: the agencies are already in the system. When the Salvation Army opens a shelter or a feeding site, it should reach the community at once, from the agency itself, because it is probably not posted anywhere on the internet yet.

## A. Partners publish their own services

**Requirements:** PUB-01, PUB-03, PUB-06, PUB-10, PUB-17, CON-16, NED-06, ADM-02, ADM-05, SEC-05, and REC-13 (partner posts are discovery's first source).

**How it works.** A partner organization's named approver posts a shelter, feeding site, POD, cooling or warming centre or other service. It goes live on the county's Find help page, feeds and widget immediately. The partner's approver is the named person PUB-06 requires; the post needs the confirmation dialog with a reason.

The site belongs to the county, with the partner as its operator: the existing `operator_tenant_id` (migration 0039). So one county page lists every service, and the county can always edit, close or withdraw it.

The county is notified at once through the publication notices (the PIO and the publishers, as confirmed 2026-10-15) and sees "Posted by <organization>" in the publication log.

As built: the partner's approver has no account in the county, so the publication row records the organization and the approver's name with what went public, and the notice says "by <approver> of <organization>" (a withdrawal by the partner says "someone at <organization>").

**The same checks as a county post:**

- the required fields (name, kind, address or area, hours, accessibility, pets, languages, contact);
- the safe-wording filter;
- a site marked confidential (for example a domestic-violence shelter) is never public, whoever posts it;
- the status window (PUB-03): a posted site must be confirmed by its operator within the county's window or it hides until confirmed.

As built: the county's own publish route has no wording filter or location requirement, so the partner's publish adds two checks of its own. A post needs an address or a map point, and its name, notes and directions must not read like an emergency alert ("emergency alert", "alerta de emergencia"), because they reach the SHELTER text replies and carriers reject alert wording (docs/06). Name and kind are required by the form; hours, pets, accessibility and languages have defaults the partner sets on the form. A contact is not asked for: the county keeps the lead contact.

**Data and rules (migration 0052):**

- `cg.site` gains `posted_by_tenant_id`, which records who posted it. A check constraint keeps it equal to the operator: a partner posts only as the site's operator.
- A partner may update and publish only sites it operates and posted. It may confirm status and census on any site it operates, as now.
- The dictionary covers the new column.
- As built: the partner's writes run in the county's context after the API has authorized them, as the partner's mission and need work already does (`request.txAs`), and every write is scoped to `posted_by_tenant_id` = the partner. The county is always the partner's parent tenant, read from the partner's own tenant row; an event must be one of that county's. No new row policy was needed; the operator's read policy (0039) already lets the partner see the sites it runs.

**Actions and roles:**

- As built, two explicit actions so a partner can separate drafting from its named approver (PUB-06):
  - `site.post`: draft and change the organization's own services. Not consequential: drafting needs no dialog.
  - `site.post_publish`: publish and withdraw them. Consequential: the confirmation dialog with a reason.
- Both are in the NGO incident commander template. (The plan also named the "partner coordinator" template; that is a county role that invites partner organizations, so it does not get them.)
- Existing partner tenants get them only through a role change approved by a second administrator in the partner organization (ADM-05). Tenants seeded after this change have them in the template's role.

**API:**

- `POST /partner/sites` (draft), `PATCH /partner/sites/:id`, `POST /partner/sites/:id/publish` and `/unpublish`, `GET /partner/sites`.
- The county's existing `/sites` routes see these sites like any other.

**Screens:**

- **Partner workspace, "Our services":** list, post, edit, publish, withdraw; status and census confirmation.
- **County console:** the posting organization shown on sites and in the publication log, and the notice.

**Tests:**

- **Database suite:**
  - a partner can post only into its own county and only as operator;
  - it cannot touch a county-owned site beyond confirmation;
  - a confidential site never reaches the public views;
  - the county can withdraw a partner post;
  - every post and publication is audited.
- **Stack suite:** a partner post appears on Find help, in both feeds and in the SHELTER reply within two minutes (PUB-08/10/17).
- **Browser journey with axe**, desktop and phone: a partner posts and publishes a service, the county sees the notice and withdraws it.

## B. Partner counts on the report: roll up, or choose

**Requirements:** DCL:DEC-09, F15, RULE-10.

**How it works.** The declaration view and every official report gain a **"Roll up all partner counts"** checkbox for the county. It is ticked by default.

When it is unticked, the county chooses:

- which partner organizations are included;
- which categories, out of meals served, people and households sheltered, households helped (needs met), teams checked in, and donated equipment and hours.

The report states exactly what was included. An issued report freezes the choice with its facts (RULE-10).

**Counts only.** The counts come from each partner's own records through a counting function that returns numbers, never rows. No name, household or record crosses tenants. That closes the "counts only what the county can read" gap recorded for DEC-09 in layer 6.

**Data and rules:**

- `declaration.partner_rollup` and an `official_report.partner_rollup` setting (all, or the chosen partners and categories), versioned like the rest.
- A security-definer function `cg.partner_counts(county, event, period)` returns counts per partner organization and category for partner tenants under that county only. It is callable by the application role only, and the authorization check comes first (`declaration.read`).

**Tests:**

- The counts equal what each partner's own screens show.
- Unticking a partner or a category removes exactly that from the figures and from the CSV and PDF.
- The issued snapshot keeps the choice.
- No row-level data crosses tenants (a database test checks the function returns only numbers).

## C. Queued for later (Adam's answers, 2026-10-15)

| Item                                                                                                                                                                                                                                 | When                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| **CJIS mutual aid:** the owning agency grants helping agencies access to a record per mission, for a set period, to CJIS-qualified users only, every read audited, ending automatically (replaces the layer-5 default of no sharing) | After layer 7               |
| **Brother badge printing:** QL-820NWB (62 mm) and QL-1110NWB (4 in), from the console through the Brother driver with a label layout for each, and from the field app through Brother's mobile SDK                                   | After layer 7               |
| **iOS field app:** the project made ready for Adam to build on his Mac (bundle id, permission texts for location, camera and microphone, background location); needs an Apple Developer membership in Mennelabs' name                | When the field app is ready |
| **Case management on the shared record** (FL-13 and the related FL:FR rows)                                                                                                                                                          | After layer 8               |

Then each item goes through its pull request into `main`, merged when CI is green.

# Partner self-posting and partner counts on reports (before layer 7)

Written 2026-10-15 from Adam's answers in the interview of that day (`docs/decisions.md`). This work comes before layer 7. It extends layer 3 (public information, partner workspace) and layer 6 (declaration and official reports). Everything from layers 1 to 6 keeps applying: RLS, audit of every write, idempotency, versions, the confirmation dialog with a reason (RULE-14), synthetic data only (SCL-12).

Adam's point: the agencies are already in the system. When the Salvation Army opens a shelter or a feeding site, it should reach the community at once, from the agency itself, because it is probably not posted anywhere on the internet yet.

## A. Partners publish their own services

**Requirements:** PUB-01, PUB-03, PUB-06, PUB-10, PUB-17, CON-16, NED-06, ADM-02, ADM-05, SEC-05, and REC-13 (partner posts are discovery's first source).

**How it works.** A partner organization's named approver posts a shelter, feeding site, POD, cooling or warming centre or other service. It goes live on the county's Find help page, feeds and widget immediately. The partner's approver is the named person PUB-06 requires; the post needs the confirmation dialog with a reason.

The site belongs to the county, with the partner as its operator: the existing `operator_tenant_id` (migration 0039). So one county page lists every service, and the county can always edit, close or withdraw it.

The county is notified at once through the publication notices (the PIO and the publishers, as confirmed 2026-10-15) and sees "Posted by <organization>" in the publication log.

**The same checks as a county post:**

- the required fields (name, kind, address or area, hours, accessibility, pets, languages, contact);
- the safe-wording filter;
- a site marked confidential (for example a domestic-violence shelter) is never public, whoever posts it;
- the status window (PUB-03): a posted site must be confirmed by its operator within the county's window or it hides until confirmed.

**Data and rules (migration 0052):**

- `cg.site` gains `posted_by_tenant_id`, which records who posted it.
- Row security lets a partner insert a site only into its parent county, only with itself as operator.
- A partner may update and publish only sites it operates and posted. It may confirm status and census on any site it operates, as now.
- The dictionary covers the new column.

**Actions and roles:**

- `site.post`: explicit and consequential. It is added to the NGO incident commander and partner coordinator templates.
- Existing partner tenants get it only through a role change approved by a second administrator in the partner organization (ADM-05).

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

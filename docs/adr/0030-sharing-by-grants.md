# ADR-0030: Partners see residents' records only through share grants that carry a minimum-field projection

- Status: accepted
- Date: 2026-10-13
- Requirements: NED-03, NED-04, NED-05, AC-17C, FL-03, SEC-05, SEC-06, SEC-18, ADM-02, BRD:RULE-12, BRD:FR-00.06

## Decision

A partner organization never reads the county's report or need tables. The worker derives one `cg.share_grant` row per partner per report (or per need of a needs-only submission) whenever a report is filed, late answers arrive, consent changes, a report is corrected or withdrawn, or an agreement changes. A grant exists only when two things hold at once: the resident consented to that organization type, and the county holds a signed data-sharing agreement with that partner naming the type, the service and the data categories. The grant carries the sections the service is allowed by the fixed NED-04 table (`packages/authz/src/sharing.ts`: cleanup gets name, contact, contact preference, exact address and the need; feeding gets the area, a household-size band and the need; shelter gets contact, the need and, only when shelter was asked for, access needs; counseling a contact method; legal aid name and contact; coordination nothing). The projection is materialised on the grant: the sensitive part in clear JSON, the restricted part encrypted with the county's key, so a partner read is a read of the grant, in the partner's own tenant context, masked again by the partner role's data categories and audited with the grant id (SEC-18). Protected categories such as access needs come from the role template alone, never from the grant.

Withdrawal is immediate: a consent withdrawn on the web or by the NOSHARE text revokes the grant in the same worker transaction and queues a recall notice to the partner's role holders (or its security contact) naming what was shared and since when; the grant records the notice's message id. Exports already taken are the partner's obligation under the agreement. A full-records agreement (layer 1) is the only thing that opens another tenant's tables, and no layer-3 agreement is one. Partner actions on the board (claim, release, done) run inside the county's RLS context through `request.txAs` only after the grant is verified in the partner's context and only for that need, and are audited in the county's log with the partner account as actor.

## Alternatives considered

| Option                                               | Why not                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Row-level security letting partners read report rows | Column-level minimum fields per service cannot be expressed in a row policy; a bug would leak whole records.           |
| Computing the projection at read time                | Every read would re-derive consent, agreement and sections; the grant is the audited fact of what was shared and when. |
| Partner-chosen field lists in the agreement          | NED-04 fixes the minimum per service; a partner that needs more asks the resident through a referral.                  |
| Deleting grants on withdrawal                        | The revocation and the recall notice are the record a resident may ask about; the row stays, revoked.                  |
| County accounts with a "partner" role                | Partners are tenants with their own realm, users and audit (layer 1 tenancy, ADM-02).                                  |

## Why it fits SCL-11 and the government-cloud move

Grants are rows under the same RLS and the same per-tenant keys as every other table; nothing is shared through storage or a message bus. The notices go through the one message pipeline (ADR-0027), so delivery evidence is kept wherever the stack runs.

## Consequences

The county's audit log shows grants created, updated and revoked, and the partner's log shows each read; a county-side ledger of partner reads is a layer-4 addition with the field app's read receipts. The NED-04 table is code, reviewed with the requirements, not configuration. A partner's export is bounded by what the grant held at the time; the recall notice says so.

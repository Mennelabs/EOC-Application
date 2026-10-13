/**
 * Share grants (NED-04, NED-05, AC-17C, FL-03, SEC-05/06, SEC-18, ADR-0030):
 * the only path a partner organization reads a resident's record through.
 * One job keeps the grants in step with the facts: it runs after a report
 * or a needs-only submission is filed, after late answers are merged, after
 * a consent change (web or the NOSHARE text keyword), after a correction and
 * after a withdrawal.
 * Each run derives what should exist from the signed agreements and the
 * resident's consents, writes or refreshes the projection the partner may
 * see, revokes what no longer applies and queues a recall notice to the
 * partner (the agreement obliges deletion of what was shared). A rerun with
 * nothing changed writes nothing (BRD:FR-00.06).
 */
import {
  deriveGrants,
  isSharingService,
  project,
  type SharingAgreement,
  type SharingFacts,
  type SharingSection,
} from '@cg/authz';
import type { Database } from '@cg/db';
import type { Transaction } from 'kysely';
import { enqueueOutbox, systemAudit } from '../system.ts';
import { staffRecipients } from './recipients.ts';
import type { JobContext } from './types.ts';

export type SyncReason = 'filed' | 'after_answers' | 'consent' | 'corrected' | 'withdrawn';

export interface SyncResult {
  granted: number;
  updated: number;
  revoked: number;
}

/** Templates whose holders could have seen a shared record, so they get the recall notice. */

const REASON_TEXT: Record<SyncReason, string> = {
  filed: 'the report was filed',
  after_answers: 'the resident added answers',
  consent: 'the resident withdrew consent',
  corrected: 'the resident corrected the report',
  withdrawn: 'the resident withdrew the report',
};

type Answer = { kind?: string; value?: unknown } | undefined;
const answerValue = (a: unknown): unknown =>
  a && typeof a === 'object' && (a as Answer)?.kind === 'value' ? (a as Answer)?.value : undefined;

async function facts(
  ctx: JobContext,
  trx: Transaction<Database>,
  tenantId: string,
  report: {
    id: string | null;
    reporter_party_id: string | null;
    subject_party_id: string | null;
    location_id: string | null;
  },
  needs: readonly { id: string; category: string; status: string }[],
): Promise<SharingFacts> {
  const decrypt = (b: Buffer | null) =>
    b ? ctx.crypto.decrypt(tenantId, b) : Promise.resolve(null);
  const reporter = report.reporter_party_id
    ? await trx
        .selectFrom('cg.party')
        .select(['display_name_enc', 'contact_enc'])
        .where('id', '=', report.reporter_party_id)
        .executeTakeFirst()
    : undefined;
  const subject =
    report.subject_party_id && report.subject_party_id !== report.reporter_party_id
      ? await trx
          .selectFrom('cg.party')
          .select(['display_name_enc'])
          .where('id', '=', report.subject_party_id)
          .executeTakeFirst()
      : undefined;
  const address = report.location_id
    ? await trx
        .selectFrom('cg.location')
        .select(['line1', 'unit', 'city', 'state', 'postal', 'landmark', 'note'])
        .where('id', '=', report.location_id)
        .executeTakeFirst()
    : undefined;
  const after = report.id
    ? await trx
        .selectFrom('cg.post_submission_answers')
        .select(['aggregate_answers', 'restricted_answers_enc'])
        .where('report_id', '=', report.id)
        .executeTakeFirst()
    : undefined;
  const restrictedAfter = after?.restricted_answers_enc
    ? (JSON.parse((await decrypt(after.restricted_answers_enc)) ?? '{}') as Record<string, unknown>)
    : {};
  const aggregate = (after?.aggregate_answers ?? {}) as Record<string, unknown>;
  const size = answerValue(aggregate['household_size']);
  const access = answerValue(restrictedAfter['access_needs']);
  const contactJson = await decrypt(reporter?.contact_enc ?? null);
  return {
    name: (await decrypt(subject?.display_name_enc ?? reporter?.display_name_enc ?? null)) ?? null,
    contact: contactJson
      ? (JSON.parse(contactJson) as { phone?: string; email?: string; preferred?: string })
      : null,
    address: address ?? null,
    householdSize: typeof size === 'number' ? size : null,
    needs,
    accessNeeds: Array.isArray(access)
      ? access.filter((v): v is string => typeof v === 'string' && v !== 'none')
      : null,
  };
}

/** Who at a partner organization hears about its shared records: role holders who could read them and the administrators, else the security contact. */
export async function partnerRecipients(
  trx: Transaction<Database>,
  partnerTenantId: string,
): Promise<{ partnerName: string; emails: string[] }> {
  const r = await staffRecipients(trx, partnerTenantId, ['shared.read'], { includeAdmins: true });
  return { partnerName: r.tenantName, emails: r.emails };
}

export type SharingSubject = { reportId: string } | { executionId: string };

interface Target {
  reportId: string | null;
  needId: string | null;
  needs: { id: string; category: string; status: string }[];
}

/**
 * Brings the grants for one report, or for the needs of one needs-only
 * submission (NED-02), in line with the consents and the county's agreements.
 * A report carries one grant per partner; a standalone submission one grant
 * per need per partner. Runs inside the county tenant's system transaction.
 */
export async function syncShareGrants(
  ctx: JobContext,
  trx: Transaction<Database>,
  tenantId: string,
  subject: SharingSubject,
  reason: SyncReason,
): Promise<SyncResult> {
  const now = ctx.now ?? (() => new Date());
  const result: SyncResult = { granted: 0, updated: 0, revoked: 0 };

  // 1. The record: who, where, which needs, the code, whether it still stands.
  let partyIds: { reporter: string | null; subject: string | null };
  let locationId: string | null;
  let referenceCode: string;
  let executionId: string;
  let withdrawn: boolean;
  let targets: Target[];
  let needs: { id: string; category: string; status: string }[];
  if ('reportId' in subject) {
    const report = await trx
      .selectFrom('cg.report')
      .select([
        'id',
        'reference_code',
        'execution_id',
        'reporter_party_id',
        'subject_party_id',
        'location_id',
        'withdrawn_at',
      ])
      .where('id', '=', subject.reportId)
      .executeTakeFirst();
    if (!report) return result;
    needs = await trx
      .selectFrom('cg.need')
      .select(['id', 'category', 'status'])
      .where('report_id', '=', report.id)
      .where('status', '<>', 'withdrawn')
      .orderBy('created_at')
      .execute();
    partyIds = { reporter: report.reporter_party_id, subject: report.subject_party_id };
    locationId = report.location_id;
    referenceCode = report.reference_code;
    executionId = report.execution_id;
    withdrawn = report.withdrawn_at !== null;
    targets = [{ reportId: report.id, needId: null, needs }];
  } else {
    const rows = await trx
      .selectFrom('cg.need')
      .select(['id', 'category', 'status', 'contact_party_id', 'location_id', 'reference_code'])
      .where('execution_id', '=', subject.executionId)
      .where('report_id', 'is', null)
      .orderBy('created_at')
      .execute();
    if (rows.length === 0) return result;
    needs = rows
      .filter((n) => n.status !== 'withdrawn')
      .map((n) => ({ id: n.id, category: n.category, status: n.status }));
    partyIds = { reporter: rows[0]!.contact_party_id, subject: rows[0]!.contact_party_id };
    locationId = rows[0]!.location_id;
    referenceCode = rows[0]!.reference_code ?? '';
    executionId = subject.executionId;
    withdrawn = needs.length === 0;
    targets = needs.map((n) => ({ reportId: null, needId: n.id, needs: [n] }));
  }

  const agreementRows = await trx
    .selectFrom('cg.data_sharing_agreement')
    .select(['id', 'to_tenant_id', 'data_categories', 'terms', 'status', 'scope'])
    .where('from_tenant_id', '=', tenantId)
    .where('status', '=', 'signed')
    .where('scope', 'in', ['consented_records', 'full_records'])
    .orderBy('created_at')
    .execute();
  const agreements: SharingAgreement[] = [];
  for (const a of agreementRows) {
    const terms = (a.terms ?? {}) as { orgType?: unknown; service?: unknown };
    if (typeof terms.orgType !== 'string' || !isSharingService(terms.service)) continue;
    agreements.push({
      id: a.id,
      toTenantId: a.to_tenant_id,
      orgType: terms.orgType,
      service: terms.service,
      dataCategories: a.data_categories,
      signed: a.status === 'signed',
    });
  }
  let consentQuery = trx.selectFrom('cg.consent').select(['id', 'org_type as orgType', 'granted']);
  consentQuery =
    'reportId' in subject
      ? consentQuery.where('report_id', '=', subject.reportId)
      : consentQuery
          .where('party_id', '=', partyIds.reporter ?? '00000000-0000-0000-0000-000000000000')
          .where('report_id', 'is', null);
  const consents = await consentQuery.execute();
  const derived = deriveGrants(agreements, consents, {
    needs: needs.map((n) => n.category),
    withdrawn,
  });

  let existingQuery = trx.selectFrom('cg.share_grant').selectAll().where('revoked_at', 'is', null);
  existingQuery =
    'reportId' in subject
      ? existingQuery.where('report_id', '=', subject.reportId)
      : existingQuery.where(
          'need_id',
          'in',
          targets.map((t) => t.needId!).concat(['00000000-0000-0000-0000-000000000000']),
        );
  const existing = await existingQuery.execute();

  // 2. What should exist: one grant per partner (× need for standalone needs), cut to its sections.
  const f =
    derived.length > 0 && !withdrawn
      ? await facts(
          ctx,
          trx,
          tenantId,
          {
            id: 'reportId' in subject ? subject.reportId : null,
            reporter_party_id: partyIds.reporter,
            subject_party_id: partyIds.subject,
            location_id: locationId,
          },
          needs,
        )
      : null;
  const keep = new Set<string>();
  for (const d of derived) {
    for (const target of targets) {
      const projection = project(d.sections, { ...f!, needs: target.needs });
      const clear = { ...projection.clear, referenceCode };
      const restricted =
        Object.keys(projection.restricted).length > 0
          ? JSON.stringify(projection.restricted)
          : null;
      const current = existing.find(
        (g) =>
          g.to_tenant_id === d.toTenantId &&
          g.org_type === d.orgType &&
          g.report_id === target.reportId &&
          g.need_id === target.needId,
      );
      const auditFields = [
        { name: 'org_type', to: d.orgType },
        { name: 'to_tenant_id', to: d.toTenantId },
        ...(target.reportId ? [{ name: 'report_id', to: target.reportId }] : []),
        ...(target.needId ? [{ name: 'need_id', to: target.needId }] : []),
      ];
      if (current) {
        keep.add(current.id);
        const currentRestricted = current.projection_enc
          ? await ctx.crypto.decrypt(tenantId, current.projection_enc)
          : null;
        const same =
          JSON.stringify(current.sections) === JSON.stringify(d.sections) &&
          JSON.stringify(current.projection) === JSON.stringify(clear) &&
          currentRestricted === restricted &&
          current.consent_id === d.consentId &&
          current.agreement_id === d.agreementId;
        if (same) continue;
        await trx
          .updateTable('cg.share_grant')
          .set({
            sections: d.sections,
            projection: JSON.stringify(clear),
            projection_enc: restricted ? await ctx.crypto.encrypt(tenantId, restricted) : null,
            consent_id: d.consentId,
            agreement_id: d.agreementId,
          })
          .where('id', '=', current.id)
          .execute();
        result.updated++;
        await systemAudit(trx, tenantId, 'sharing.sync', {
          action: 'share_grant.updated',
          targetType: 'share_grant',
          targetId: current.id,
          executionId,
          reason: REASON_TEXT[reason],
          changes: {
            fields: [{ name: 'sections', from: current.sections, to: d.sections }, ...auditFields],
          },
        });
        continue;
      }
      const inserted = await trx
        .insertInto('cg.share_grant')
        .values({
          tenant_id: tenantId,
          to_tenant_id: d.toTenantId,
          org_type: d.orgType,
          report_id: target.reportId,
          need_id: target.needId,
          party_id: partyIds.reporter,
          consent_id: d.consentId,
          agreement_id: d.agreementId,
          sections: d.sections,
          projection: JSON.stringify(clear),
          projection_enc: restricted ? await ctx.crypto.encrypt(tenantId, restricted) : null,
          granted_at: now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      keep.add(inserted.id);
      result.granted++;
      await systemAudit(trx, tenantId, 'sharing.sync', {
        action: 'share_grant.granted',
        targetType: 'share_grant',
        targetId: inserted.id,
        executionId,
        reason: REASON_TEXT[reason],
        changes: { fields: [{ name: 'sections', to: d.sections }, ...auditFields] },
      });
    }
  }

  // 3. What no longer applies: revoke and recall (NED-05: within the hour; the job does it now).
  for (const g of existing) {
    if (keep.has(g.id)) continue;
    await trx
      .updateTable('cg.share_grant')
      .set({ revoked_at: now(), revoke_reason: reason })
      .where('id', '=', g.id)
      .execute();
    result.revoked++;
    await systemAudit(trx, tenantId, 'sharing.sync', {
      action: 'share_grant.revoked',
      targetType: 'share_grant',
      targetId: g.id,
      executionId,
      reason: REASON_TEXT[reason],
      changes: {
        fields: [
          { name: 'sections', from: g.sections, to: [] },
          { name: 'to_tenant_id', to: g.to_tenant_id },
          ...(g.report_id ? [{ name: 'report_id', to: g.report_id }] : []),
          ...(g.need_id ? [{ name: 'need_id', to: g.need_id }] : []),
        ],
      },
    });
    // Exports already taken cannot be pulled back, so the notice names what was shared and since when.
    const { partnerName, emails } = await partnerRecipients(trx, g.to_tenant_id);
    if (emails.length === 0) {
      await systemAudit(trx, tenantId, 'sharing.sync', {
        action: 'share_grant.recall_unsent',
        targetType: 'share_grant',
        targetId: g.id,
        reason: `no recipient at partner ${g.to_tenant_id}`,
      });
      continue;
    }
    for (const email of emails) {
      await enqueueOutbox(
        trx,
        tenantId,
        'message.send',
        {
          template: 'sharing_recall',
          channel: 'email',
          toEnc: (await ctx.crypto.encrypt(tenantId, email)).toString('base64'),
          language: 'en',
          ...(g.report_id ? { reportId: g.report_id } : {}),
          shareGrantId: g.id,
          variables: {
            referenceCode,
            partner: partnerName,
            sections: (g.sections as SharingSection[]).join(', '),
            sharedSince: g.granted_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
            why: REASON_TEXT[reason],
          },
        },
        executionId,
      );
    }
  }
  return result;
}

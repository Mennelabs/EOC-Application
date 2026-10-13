/**
 * Share grants (NED-04, NED-05, AC-17C, FL-03, SEC-05/06, SEC-18, ADR-0030):
 * the only path a partner organization reads a resident's record through.
 * One job keeps the grants in step with the facts: it runs after a report
 * is filed, after late answers are merged, after a consent change (web or
 * the NOSHARE text keyword), after a correction and after a withdrawal.
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
  roleTemplates,
  type SharingAgreement,
  type SharingFacts,
  type SharingSection,
} from '@cg/authz';
import type { Database } from '@cg/db';
import type { Transaction } from 'kysely';
import { enqueueOutbox, systemAudit } from '../system.ts';
import type { JobContext } from './types.ts';

export type SyncReason = 'filed' | 'after_answers' | 'consent' | 'corrected' | 'withdrawn';

export interface SyncResult {
  granted: number;
  updated: number;
  revoked: number;
}

/** Templates whose holders could have seen a shared record, so they get the recall notice. */
const RECALL_ROLE_TEMPLATES = [
  'tenant_admin',
  ...roleTemplates
    .filter((t) => t.grants.some((g) => g.action === 'shared.read' || g.action === '*'))
    .map((t) => t.key),
];

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
    id: string;
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
  const after = await trx
    .selectFrom('cg.post_submission_answers')
    .select(['aggregate_answers', 'restricted_answers_enc'])
    .where('report_id', '=', report.id)
    .executeTakeFirst();
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

/** Who at the partner gets the recall notice: role holders who could read shared records, else the security contact. */
async function recallRecipients(
  trx: Transaction<Database>,
  partnerTenantId: string,
): Promise<{ partnerName: string; emails: string[] }> {
  const partner = await trx
    .selectFrom('cg.tenant')
    .select(['name', 'security_contact_email'])
    .where('id', '=', partnerTenantId)
    .executeTakeFirstOrThrow();
  const accounts = await trx
    .selectFrom('cg.account as a')
    .innerJoin('cg.role_assignment as ra', 'ra.account_id', 'a.id')
    .innerJoin('cg.role as r', 'r.id', 'ra.role_id')
    .select('a.email as email')
    .distinct()
    .where('a.tenant_id', '=', partnerTenantId)
    .where('a.status', 'in', ['active', 'invited'])
    .where('ra.status', '=', 'active')
    .where('r.template_key', 'in', RECALL_ROLE_TEMPLATES)
    .execute();
  const emails = accounts.map((a) => a.email);
  if (emails.length === 0 && partner.security_contact_email)
    emails.push(partner.security_contact_email);
  return { partnerName: partner.name, emails };
}

/**
 * Brings the grants for one report in line with its consents and the county's
 * agreements. Runs inside the county tenant's system transaction.
 */
export async function syncShareGrants(
  ctx: JobContext,
  trx: Transaction<Database>,
  tenantId: string,
  reportId: string,
  reason: SyncReason,
): Promise<SyncResult> {
  const now = ctx.now ?? (() => new Date());
  const result: SyncResult = { granted: 0, updated: 0, revoked: 0 };
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
    .where('id', '=', reportId)
    .executeTakeFirst();
  if (!report) return result;

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
  const consents = await trx
    .selectFrom('cg.consent')
    .select(['id', 'org_type as orgType', 'granted'])
    .where('report_id', '=', reportId)
    .execute();
  const needs = await trx
    .selectFrom('cg.need')
    .select(['id', 'category', 'status'])
    .where('report_id', '=', reportId)
    .where('status', '<>', 'withdrawn')
    .orderBy('created_at')
    .execute();
  const derived = deriveGrants(agreements, consents, {
    needs: needs.map((n) => n.category),
    withdrawn: report.withdrawn_at !== null,
  });
  const existing = await trx
    .selectFrom('cg.share_grant')
    .selectAll()
    .where('report_id', '=', reportId)
    .where('revoked_at', 'is', null)
    .execute();

  const f = derived.length > 0 ? await facts(ctx, trx, tenantId, report, needs) : null;
  const keep = new Set<string>();
  for (const d of derived) {
    const projection = project(d.sections, f!);
    const clear = { ...projection.clear, referenceCode: report.reference_code };
    const restricted =
      Object.keys(projection.restricted).length > 0 ? JSON.stringify(projection.restricted) : null;
    const current = existing.find(
      (g) => g.to_tenant_id === d.toTenantId && g.org_type === d.orgType,
    );
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
        executionId: report.execution_id,
        reason: REASON_TEXT[reason],
        changes: {
          fields: [
            { name: 'sections', from: current.sections, to: d.sections },
            { name: 'to_tenant_id', to: d.toTenantId },
            { name: 'report_id', to: report.id },
          ],
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
        report_id: report.id,
        party_id: report.reporter_party_id,
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
      executionId: report.execution_id,
      reason: REASON_TEXT[reason],
      changes: {
        fields: [
          { name: 'sections', to: d.sections },
          { name: 'org_type', to: d.orgType },
          { name: 'to_tenant_id', to: d.toTenantId },
          { name: 'report_id', to: report.id },
        ],
      },
    });
  }

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
      executionId: report.execution_id,
      reason: REASON_TEXT[reason],
      changes: {
        fields: [
          { name: 'sections', from: g.sections, to: [] },
          { name: 'to_tenant_id', to: g.to_tenant_id },
          { name: 'report_id', to: report.id },
        ],
      },
    });
    // NED-05: the partner hears within the hour; the job does it now. Exports already taken
    // cannot be pulled back, so the notice names what was shared and since when.
    const { partnerName, emails } = await recallRecipients(trx, g.to_tenant_id);
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
          reportId: report.id,
          shareGrantId: g.id,
          variables: {
            referenceCode: report.reference_code,
            partner: partnerName,
            sections: (g.sections as SharingSection[]).join(', '),
            sharedSince: g.granted_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
            why: REASON_TEXT[reason],
          },
        },
        report.execution_id,
      );
    }
  }
  return result;
}

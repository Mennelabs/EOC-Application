/**
 * Records shared with a partner organization (NED-04, NED-05, AC-17C, FL-03,
 * SEC-05/06, SEC-18, BRD:RULE-12, ADR-0030). A partner never reads the
 * county's report; it reads the share grant the worker cut for it: the
 * sections its service may see, while the resident's consent stands. The
 * grant's own row policy lets the partner tenant select it; nothing else of
 * the county's is visible. The role's data categories mask on top of the
 * sections (the stricter rule wins), and every read is audited with the
 * grant id and the categories read.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { FieldDescriptor } from '@cg/authz';
import type { Database } from '@cg/db';
import { errors } from '../errors.ts';
import { iso, listQuery, uuidParam } from './helpers.ts';

type GrantRow = Selectable<Database['cg.share_grant']>;

/** The sections of a shared record as fields the policy engine can mask (RULE-16). */
const FIELDS: FieldDescriptor[] = [
  { name: 'name', category: 'basic', classification: 'restricted' },
  { name: 'contact', category: 'contact', classification: 'restricted' },
  { name: 'contactPreference', category: 'contact', classification: 'sensitive' },
  { name: 'address', category: 'location_exact', classification: 'sensitive' },
  { name: 'area', category: 'basic', classification: 'internal' },
  { name: 'householdBand', category: 'household', classification: 'sensitive' },
  { name: 'needs', category: 'basic', classification: 'internal' },
  { name: 'accessNeeds', category: 'access_needs', classification: 'restricted' },
];

const needOut = z.object({ id: z.uuid(), category: z.string(), status: z.string() });
const sharedOut = z.object({
  grantIds: z.array(z.uuid()),
  reportId: z.uuid(),
  referenceCode: z.string().nullable(),
  orgTypes: z.array(z.string()),
  sections: z.array(z.string()),
  /** Sections the grant carries that this role may not see (masked by data category). */
  maskedSections: z.array(z.string()),
  grantedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  name: z.string().nullable(),
  contact: z.object({ phone: z.string().optional(), email: z.string().optional() }).nullable(),
  contactPreference: z.string().nullable(),
  address: z
    .object({
      line1: z.string().optional(),
      unit: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postal: z.string().optional(),
      landmark: z.string().optional(),
      note: z.string().optional(),
    })
    .nullable(),
  area: z.object({ city: z.string().optional(), postal: z.string().optional() }).nullable(),
  householdBand: z.string().nullable(),
  needs: z.array(needOut).nullable(),
  accessNeeds: z.array(z.string()).nullable(),
});
type SharedOut = z.infer<typeof sharedOut>;

/** Grant section → response field. */
const SECTION_FIELD: Record<string, keyof SharedOut> = {
  name: 'name',
  contact: 'contact',
  contact_preference: 'contactPreference',
  address_exact: 'address',
  area: 'area',
  household_band: 'householdBand',
  need: 'needs',
  access_needs: 'accessNeeds',
};

export const sharedRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** Merges the partner's active grants for one report into what this role may see. */
  async function render(
    request: FastifyRequest,
    grants: GrantRow[],
  ): Promise<{ out: SharedOut; restrictedRead: string[] }> {
    const sections = [...new Set(grants.flatMap((g) => g.sections))];
    const fields = FIELDS.filter((f) => sections.some((s) => SECTION_FIELD[s] === f.name));
    const decision = await request.authorize('shared.read', {
      type: 'share_grant',
      id: grants[0]!.id,
      tenantId: grants[0]!.to_tenant_id,
      fields,
    });
    const can = (field: keyof SharedOut) => decision.fields.includes(field);
    const clear: Record<string, unknown> = {};
    const restricted: Record<string, unknown> = {};
    for (const g of grants) {
      Object.assign(clear, g.projection);
      if (g.projection_enc)
        Object.assign(
          restricted,
          JSON.parse(await app.fieldCrypto.decrypt(g.tenant_id, g.projection_enc)) as Record<
            string,
            unknown
          >,
        );
    }
    const pick = <T>(field: keyof SharedOut, from: Record<string, unknown>): T | null =>
      can(field) && from[field] !== undefined ? (from[field] as T) : null;
    const out: SharedOut = {
      grantIds: grants.map((g) => g.id),
      reportId: grants[0]!.report_id!,
      referenceCode: typeof clear['referenceCode'] === 'string' ? clear['referenceCode'] : null,
      orgTypes: [...new Set(grants.map((g) => g.org_type))],
      sections: sections.filter((s) => can(SECTION_FIELD[s] ?? 'needs')),
      maskedSections: sections.filter((s) => !can(SECTION_FIELD[s] ?? 'needs')),
      grantedAt: iso(grants.map((g) => g.granted_at).sort((a, b) => a.getTime() - b.getTime())[0])!,
      updatedAt: iso(grants.map((g) => g.updated_at).sort((a, b) => b.getTime() - a.getTime())[0])!,
      name: pick<string>('name', restricted),
      contact: pick<SharedOut['contact']>('contact', restricted),
      contactPreference: pick<string>('contactPreference', clear),
      address: pick<SharedOut['address']>('address', clear),
      area: pick<SharedOut['area']>('area', clear),
      householdBand: pick<string>('householdBand', clear),
      needs: pick<SharedOut['needs']>('needs', clear),
      accessNeeds: pick<string[]>('accessNeeds', restricted),
    };
    return { out, restrictedRead: decision.restrictedRead };
  }

  async function audit(request: FastifyRequest, grants: GrantRow[], restrictedRead: string[]) {
    // SEC-18: every partner read of a resident's record, with the grant and the categories read.
    await request.tx(async (trx) => {
      for (const g of grants)
        await request.audit(trx, {
          action: 'shared.read',
          targetType: 'share_grant',
          targetId: g.id,
          targetVersion: g.version,
          classificationRead: restrictedRead,
          changes: { reportId: g.report_id, countyTenantId: g.tenant_id, sections: g.sections },
        });
    });
  }

  app.get(
    '/shared/reports',
    {
      schema: {
        tags: ['sharing'],
        querystring: listQuery.extend({ orgType: z.string().optional() }),
        response: { 200: z.array(sharedOut) },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('shared.read', { type: 'share_grant', tenantId: s.tenantId });
      const rows = await request.tx((trx) => {
        let q = trx
          .selectFrom('cg.share_grant')
          .selectAll()
          .where('to_tenant_id', '=', s.tenantId)
          .where('revoked_at', 'is', null)
          .where('report_id', 'is not', null)
          .orderBy('granted_at', 'desc')
          .limit(request.query.limit)
          .offset(request.query.offset);
        if (request.query.orgType) q = q.where('org_type', '=', request.query.orgType);
        return q.execute();
      });
      const byReport = new Map<string, GrantRow[]>();
      for (const r of rows) {
        const list = byReport.get(r.report_id!) ?? [];
        list.push(r);
        byReport.set(r.report_id!, list);
      }
      const out: SharedOut[] = [];
      const read = new Set<string>();
      for (const grants of byReport.values()) {
        const rendered = await render(request, grants);
        out.push(rendered.out);
        rendered.restrictedRead.forEach((c) => read.add(c));
      }
      if (rows.length > 0) await audit(request, rows, [...read]);
      return out;
    },
  );

  app.get(
    '/shared/reports/:id',
    { schema: { tags: ['sharing'], params: uuidParam, response: { 200: sharedOut } } },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('shared.read', { type: 'share_grant', tenantId: s.tenantId });
      const grants = await request.tx((trx) =>
        trx
          .selectFrom('cg.share_grant')
          .selectAll()
          .where('to_tenant_id', '=', s.tenantId)
          .where('report_id', '=', request.params.id)
          .where('revoked_at', 'is', null)
          .orderBy('granted_at')
          .execute(),
      );
      if (grants.length === 0) throw errors.notFound(); // never says whether the report exists
      const rendered = await render(request, grants);
      await audit(request, grants, rendered.restrictedRead);
      return rendered.out;
    },
  );
};

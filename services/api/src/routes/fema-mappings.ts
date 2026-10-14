/**
 * FEMA form mappings (layer-6 task F; DCL:DEC-12, DEC-13, DEC-15, RULE-14):
 * which data element fills each field of each FEMA form. Version 1 of every
 * form ships with the platform; a county drafts a later version when FEMA
 * changes a form, and activates it with a confirmed reason, which retires
 * the version it replaces. Fields are checked against the closed vocabulary
 * (no personal details exist in it), so a mapping cannot export something
 * the platform does not hold or must not send. Every export names the form,
 * FEMA form version and mapping version it used (`mappingInForce`).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { FemaFormMappingTable } from '@cg/db';
import {
  ELEMENTS,
  FILTERS,
  FORM_KEYS,
  FORMS,
  SHIPPED,
  mappingInForce,
  validateMapping,
  type FormKey,
  type MappingField,
} from '@cg/reporting';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, iso } from './helpers.ts';

type Row = Selectable<FemaFormMappingTable>;

const formKey = z.enum(FORM_KEYS as [FormKey, ...FormKey[]]);
const fieldIn = z.object({
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(200),
  element: z.string().max(80),
  where: z.record(z.string(), z.string()).optional(),
  section: z.string().trim().max(200).optional(),
  row: z.string().trim().max(200).optional(),
  column: z.string().trim().max(200).optional(),
});
const scopeIn = z.object({ homeType: z.array(z.enum(FILTERS.homeType)).max(5).optional() });

const versionOut = z.object({
  id: z.uuid().nullable(),
  version: z.number().int().nullable(),
  mappingVersion: z.number().int(),
  femaFormVersion: z.string(),
  status: z.enum(['shipped', 'draft', 'active', 'retired']),
  sourceDocument: z.string().nullable(),
  note: z.string().nullable(),
  activatedAt: z.iso.datetime().nullable(),
  activationReason: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
const mappingOut = versionOut.extend({
  form: z.string(),
  scope: z.unknown(),
  fields: z.array(z.unknown()),
});

// Exports use the same lookup from the worker; it lives in packages/reporting.
export { mappingInForce };

const shippedView = (form: FormKey) => ({
  id: null,
  version: null,
  mappingVersion: 1,
  femaFormVersion: SHIPPED[form].femaFormVersion,
  status: 'shipped' as const,
  sourceDocument: SHIPPED[form].sourceDocument,
  note: 'Shipped with the platform from docs/05.',
  activatedAt: null,
  activationReason: null,
  updatedAt: null,
});

const rowView = (r: Row) => ({
  id: r.id,
  version: r.version,
  mappingVersion: r.mapping_version,
  femaFormVersion: r.fema_form_version,
  status: r.status,
  sourceDocument: r.source_document,
  note: r.note,
  activatedAt: iso(r.activated_at),
  activationReason: r.activation_reason,
  updatedAt: iso(r.updated_at),
});

/** Refuses a mapping that names anything outside the vocabulary or the form's grain. */
function check(form: FormKey, fields: MappingField[]) {
  const problems = validateMapping(form, fields);
  if (problems.length)
    throw errors.validation(
      problems.map((p) => ({
        name: p.field === undefined ? 'fields' : `fields[${p.field}]`,
        message: p.message,
      })),
    );
}

export const femaMappingRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  app.get(
    '/fema-mappings',
    {
      schema: {
        tags: ['fema-mappings'],
        response: {
          200: z.array(
            z.object({
              form: z.string(),
              title: z.string(),
              grain: z.string(),
              inForce: versionOut,
              versions: z.array(versionOut),
            }),
          ),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('fema_mapping.read', {
        type: 'fema_form_mapping',
        tenantId: s.tenantId,
      });
      return request.tx(async (trx) => {
        const rows = await trx
          .selectFrom('cg.fema_form_mapping')
          .selectAll()
          .orderBy('mapping_version', 'desc')
          .execute();
        return FORM_KEYS.map((form) => {
          const mine = rows.filter((r) => r.form === form);
          const active = mine.find((r) => r.status === 'active');
          return {
            form,
            title: FORMS[form].title,
            grain: FORMS[form].grain,
            inForce: active ? rowView(active) : shippedView(form),
            versions: [...mine.map(rowView), shippedView(form)],
          };
        });
      });
    },
  );

  app.get(
    '/fema-mappings/:form/versions/:v',
    {
      schema: {
        tags: ['fema-mappings'],
        params: z.object({ form: formKey, v: z.coerce.number().int().min(1) }),
        response: {
          200: mappingOut.extend({
            elements: z.array(
              z.object({ key: z.string(), description: z.string(), filters: z.array(z.string()) }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('fema_mapping.read', {
        type: 'fema_form_mapping',
        tenantId: s.tenantId,
      });
      const { form, v } = request.params;
      const grain = FORMS[form].grain;
      // The elements this form may use, for the editor.
      const elements = Object.entries(ELEMENTS)
        .filter(([, m]) => m.grain === grain)
        .map(([key, m]) => ({
          key,
          description: m.description,
          filters: [...('filters' in m ? m.filters : [])],
        }));
      if (v === 1)
        return {
          ...shippedView(form),
          form,
          scope: SHIPPED[form].scope ?? {},
          fields: SHIPPED[form].fields,
          elements,
        };
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.fema_form_mapping')
          .selectAll()
          .where('form', '=', form)
          .where('mapping_version', '=', v)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      return { ...rowView(row), form, scope: row.scope, fields: row.fields as unknown[], elements };
    },
  );

  app.post(
    '/fema-mappings/:form/versions',
    {
      schema: {
        tags: ['fema-mappings'],
        params: z.object({ form: formKey }),
        body: z.object({
          femaFormVersion: z.string().trim().min(1).max(200),
          sourceDocument: z.string().trim().max(500).optional(),
          note: z.string().trim().max(2000).optional(),
          scope: scopeIn.optional(),
          /** The new version's fields; the version in force is copied when absent. */
          fields: z.array(fieldIn).max(400).optional(),
        }),
        response: { 201: mappingOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('fema_mapping.write', {
        type: 'fema_form_mapping',
        tenantId: s.tenantId,
      });
      const { form } = request.params;
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const current = await mappingInForce(trx, s.tenantId, form);
        const fields = (b.fields as MappingField[] | undefined) ?? current.fields;
        check(form, fields);
        // One draft at a time per form keeps the version numbers meaningful.
        const open = await trx
          .selectFrom('cg.fema_form_mapping')
          .select('mapping_version')
          .where('form', '=', form)
          .where('status', '=', 'draft')
          .executeTakeFirst();
        if (open)
          throw new ApiError(
            409,
            'draft_open',
            `Version ${open.mapping_version} of this form is already a draft; edit or activate it first.`,
          );
        const last = await trx
          .selectFrom('cg.fema_form_mapping')
          .select(sql<number>`coalesce(max(mapping_version), 1)`.as('n'))
          .where('form', '=', form)
          .executeTakeFirstOrThrow();
        const inserted = await trx
          .insertInto('cg.fema_form_mapping')
          .values({
            tenant_id: s.tenantId,
            form,
            fema_form_version: b.femaFormVersion,
            mapping_version: Number(last.n) + 1,
            scope: JSON.stringify(b.scope ?? current.scope ?? {}),
            fields: JSON.stringify(fields),
            source_document: b.sourceDocument ?? null,
            note: b.note ?? null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'fema_mapping.write',
          targetType: 'fema_form_mapping',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(
            null,
            {
              form,
              mapping_version: inserted.mapping_version,
              fema_form_version: b.femaFormVersion,
            },
            classifierFor('fema_form_mapping'),
          ),
        });
        return inserted;
      });
      return reply
        .code(201)
        .send({ ...rowView(row), form, scope: row.scope, fields: row.fields as unknown[] });
    },
  );

  app.put(
    '/fema-mappings/:form/versions/:v',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['fema-mappings'],
        params: z.object({ form: formKey, v: z.coerce.number().int().min(2) }),
        body: z.object({
          femaFormVersion: z.string().trim().min(1).max(200).optional(),
          sourceDocument: z.string().trim().max(500).nullable().optional(),
          note: z.string().trim().max(2000).nullable().optional(),
          scope: scopeIn.optional(),
          fields: z.array(fieldIn).max(400).optional(),
        }),
        response: { 200: mappingOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      await request.authorize('fema_mapping.write', {
        type: 'fema_form_mapping',
        tenantId: s.tenantId,
      });
      const { form, v } = request.params;
      const b = request.body;
      const row = await request.tx(async (trx) => {
        const current = await trx
          .selectFrom('cg.fema_form_mapping')
          .selectAll()
          .where('form', '=', form)
          .where('mapping_version', '=', v)
          .executeTakeFirst();
        if (!current) throw errors.notFound();
        if (current.status !== 'draft')
          throw new ApiError(
            409,
            'not_a_draft',
            'An active or retired mapping is never changed; draft a new version.',
          );
        if (b.fields) check(form, b.fields as MappingField[]);
        const set = {
          ...(b.femaFormVersion !== undefined ? { fema_form_version: b.femaFormVersion } : {}),
          ...(b.sourceDocument !== undefined ? { source_document: b.sourceDocument } : {}),
          ...(b.note !== undefined ? { note: b.note } : {}),
          ...(b.scope !== undefined ? { scope: JSON.stringify(b.scope) } : {}),
          ...(b.fields !== undefined ? { fields: JSON.stringify(b.fields) } : {}),
        };
        const saved = assertUpdated(
          await trx
            .updateTable('cg.fema_form_mapping')
            .set({ ...set, version: sql`version + 1`, updated_by: s.accountId })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          rowView(current),
        );
        await request.audit(trx, {
          action: 'fema_mapping.write',
          targetType: 'fema_form_mapping',
          targetId: saved.id,
          targetVersion: saved.version,
          changes: diffForAudit(current, saved, classifierFor('fema_form_mapping')),
        });
        return saved;
      });
      return { ...rowView(row), form, scope: row.scope, fields: row.fields as unknown[] };
    },
  );

  app.post(
    '/fema-mappings/:form/versions/:v/activate',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['fema-mappings'],
        params: z.object({ form: formKey, v: z.coerce.number().int().min(2) }),
        response: { 200: mappingOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      // RULE-14: every export that follows uses this version; confirmed with a reason.
      await request.authorize('fema_mapping.activate', {
        type: 'fema_form_mapping',
        tenantId: s.tenantId,
      });
      const { reason } = request.confirmation();
      const { form, v } = request.params;
      const row = await request.tx(async (trx) => {
        const current = await trx
          .selectFrom('cg.fema_form_mapping')
          .selectAll()
          .where('form', '=', form)
          .where('mapping_version', '=', v)
          .executeTakeFirst();
        if (!current) throw errors.notFound();
        if (current.status !== 'draft')
          throw new ApiError(409, 'not_a_draft', `Version ${v} is ${current.status}.`);
        if (current.version !== expected) throw errors.conflict(rowView(current));
        check(form, current.fields as MappingField[]);
        await trx
          .updateTable('cg.fema_form_mapping')
          .set({ status: 'retired', version: sql`version + 1`, updated_by: s.accountId })
          .where('form', '=', form)
          .where('status', '=', 'active')
          .execute();
        const saved = await trx
          .updateTable('cg.fema_form_mapping')
          .set({
            status: 'active',
            activated_by: s.accountId,
            activated_at: new Date(),
            activation_reason: reason,
            version: sql`version + 1`,
            updated_by: s.accountId,
          })
          .where('id', '=', current.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'fema_mapping.activate',
          targetType: 'fema_form_mapping',
          targetId: saved.id,
          targetVersion: saved.version,
          changes: { form, mappingVersion: v, status: { from: 'draft', to: 'active' } },
          reason,
        });
        return saved;
      });
      return { ...rowView(row), form, scope: row.scope, fields: row.fields as unknown[] };
    },
  );
};

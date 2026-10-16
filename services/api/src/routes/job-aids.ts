/**
 * Job aids for the field (FL-15, BRD:FR-18.03): checklists, damage matrices,
 * shelter standards and safety briefings per role and language. They are
 * human-reviewed guidance: written as a draft, approved by someone other than
 * the last person to change it (ADM-05 G4), and only then carried to field
 * phones (routes/field-sync.ts). Changing an approved aid makes it a draft
 * again, off the phones until it is approved anew. Retiring takes it off.
 * Each step is audited, approval and retirement with a reason.
 *
 * The text is written plain ("## " heading, "- " list item, blank line between
 * paragraphs) and stored as escaped HTML (job-aid-text.ts): nothing typed
 * becomes markup.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';
import { roleTemplates } from '@cg/authz';
import type { Database, JobAidTable } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { jobAidHtml, jobAidText } from '../job-aid-text.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { iso, uuidParam } from './helpers.ts';

const KINDS = ['checklist', 'matrix', 'standard', 'briefing', 'guidance'] as const;
const STATUSES = ['draft', 'exercise_draft', 'approved', 'retired'] as const;
const ROLE_KEYS = new Set(roleTemplates.map((t) => t.key));

const aidOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  key: z.string(),
  roleKey: z.string().nullable(),
  lang: z.string(),
  kind: z.enum(KINDS),
  title: z.string(),
  text: z.string(),
  status: z.enum(STATUSES),
  onPhones: z.boolean(),
  updatedAt: z.iso.datetime(),
  lastChangedBy: z.string().nullable(),
  lastChangedByYou: z.boolean(),
  approvedBy: z.string().nullable(),
  approvedAt: z.iso.datetime().nullable(),
});

const roleKey = z
  .string()
  .nullable()
  .refine((k) => k === null || ROLE_KEYS.has(k), 'a shipped role, or none for every role');
const draftIn = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,59}$/, 'lowercase letters, digits and hyphens'),
  roleKey,
  lang: z.string().regex(/^[a-z]{2}$/),
  kind: z.enum(KINDS),
  title: z.string().trim().min(3).max(120),
  text: z.string().trim().min(10).max(20_000),
});
const changeIn = draftIn.omit({ key: true, lang: true }).partial();

type Row = Selectable<JobAidTable>;
type Trx = Transaction<Database>;

/**
 * FL-15, BRD:FR-18.03: what field phones carry. Approved aids always; the exercise drafts that
 * ship with the synthetic county only on a synthetic stack, where the phone marks them unreviewed.
 */
export function statusesOnPhones(mode: 'synthetic' | 'production'): Row['status'][] {
  return mode === 'synthetic' ? ['approved', 'exercise_draft'] : ['approved'];
}

export const jobAidRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };
  const one = (trx: Trx, id: string) =>
    trx.selectFrom('cg.job_aid').selectAll().where('id', '=', id).executeTakeFirst();
  const names = async (trx: Trx, ids: (string | null)[]) => {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (!wanted.length) return new Map<string, string>();
    const rows = await trx
      .selectFrom('cg.account')
      .select(['id', 'display_name'])
      .where('id', 'in', wanted)
      .execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  };
  /** Who last changed it: the one who may not approve it (G4). */
  const lastEditor = (r: Row) => r.updated_by ?? r.created_by;
  const view = (r: Row, who: Map<string, string>, me: string) => {
    const editor = lastEditor(r);
    return {
      id: r.id,
      version: r.version,
      key: r.key,
      roleKey: r.role_key,
      lang: r.lang,
      kind: r.kind,
      title: r.title,
      text: jobAidText(r.body_html),
      status: r.status,
      onPhones: statusesOnPhones(app.dataMode).includes(r.status),
      updatedAt: iso(r.updated_at)!,
      lastChangedBy: editor ? (who.get(editor) ?? null) : null,
      lastChangedByYou: editor === me,
      approvedBy: r.approved_by ? (who.get(r.approved_by) ?? null) : null,
      approvedAt: iso(r.approved_at),
    };
  };
  const answer = async (trx: Trx, r: Row, me: string) =>
    view(r, await names(trx, [lastEditor(r), r.approved_by]), me);

  app.get(
    '/job-aids',
    { schema: { tags: ['job aids'], response: { 200: z.array(aidOut) } } },
    async (request) => {
      const s = account(request);
      await request.authorize('job_aid.edit', { type: 'job_aid', tenantId: s.tenantId });
      return request.tx(async (trx) => {
        const rows = await trx
          .selectFrom('cg.job_aid')
          .selectAll()
          .where('tenant_id', '=', s.tenantId)
          .orderBy('status')
          .orderBy('title')
          .execute();
        const who = await names(
          trx,
          rows.flatMap((r) => [lastEditor(r), r.approved_by]),
        );
        return rows.map((r) => view(r, who, s.accountId));
      });
    },
  );

  app.post(
    '/job-aids',
    { schema: { tags: ['job aids'], body: draftIn, response: { 201: aidOut } } },
    async (request, reply) => {
      const s = account(request);
      await request.authorize('job_aid.edit', { type: 'job_aid', tenantId: s.tenantId });
      const b = request.body;
      const out = await request.tx(async (trx) => {
        const tenant = await trx
          .selectFrom('cg.tenant')
          .select('locales')
          .where('id', '=', s.tenantId)
          .executeTakeFirstOrThrow();
        if (!tenant.locales.includes(b.lang))
          throw errors.validation([{ name: 'lang', message: 'one of the county’s languages' }]);
        const taken = await trx
          .selectFrom('cg.job_aid')
          .select('id')
          .where('tenant_id', '=', s.tenantId)
          .where('key', '=', b.key)
          .where('lang', '=', b.lang)
          .executeTakeFirst();
        if (taken)
          throw new ApiError(
            409,
            'job_aid_exists',
            'A job aid with this key and language exists; change that one instead.',
          );
        const r = await trx
          .insertInto('cg.job_aid')
          .values({
            tenant_id: s.tenantId,
            key: b.key,
            role_key: b.roleKey,
            lang: b.lang,
            kind: b.kind,
            title: b.title,
            body_html: jobAidHtml(b.text),
            status: 'draft',
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'job_aid.drafted',
          targetType: 'job_aid',
          targetId: r.id,
          targetVersion: r.version,
          changes: {
            fields: [
              { name: 'title', to: r.title },
              { name: 'key', to: r.key },
            ],
          },
        });
        return answer(trx, r, s.accountId);
      });
      return reply.code(201).send(out);
    },
  );

  app.patch(
    '/job-aids/:id',
    {
      config: { requiresVersion: true },
      schema: { tags: ['job aids'], params: uuidParam, body: changeIn, response: { 200: aidOut } },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('job_aid.edit', { type: 'job_aid', tenantId: s.tenantId });
      const b = request.body;
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const found = await one(trx, request.params.id);
        if (!found || found.tenant_id !== s.tenantId) throw errors.notFound();
        if (found.status === 'retired')
          throw new ApiError(409, 'job_aid_retired', 'This job aid is retired.');
        const set = {
          ...(b.title !== undefined ? { title: b.title } : {}),
          ...(b.text !== undefined ? { body_html: jobAidHtml(b.text) } : {}),
          ...(b.kind !== undefined ? { kind: b.kind } : {}),
          ...(b.roleKey !== undefined ? { role_key: b.roleKey } : {}),
        };
        // A change to approved guidance takes it off the phones until it is approved again.
        const back = found.status === 'approved' || found.status === 'exercise_draft';
        const updated = await trx
          .updateTable('cg.job_aid')
          .set({
            ...set,
            ...(back ? { status: 'draft' as const, approved_by: null, approved_at: null } : {}),
            updated_by: s.accountId,
          })
          .where('id', '=', found.id)
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst();
        assertUpdated(updated, found);
        await request.audit(trx, {
          action: 'job_aid.changed',
          targetType: 'job_aid',
          targetId: found.id,
          targetVersion: updated!.version,
          changes: {
            fields: [
              ...Object.keys(set).map((name) => ({ name })),
              ...(back ? [{ name: 'status', from: found.status, to: 'draft' }] : []),
            ],
          },
        });
        return answer(trx, updated!, s.accountId);
      });
    },
  );

  /** A second person approves (G4: never the last to change it), with a reason. */
  for (const op of ['approve', 'retire'] as const)
    app.post(
      `/job-aids/:id/${op}`,
      {
        config: { requiresVersion: true },
        schema: { tags: ['job aids'], params: uuidParam, response: { 200: aidOut } },
      },
      async (request) => {
        const s = account(request);
        const found = await request.tx((trx) => one(trx, request.params.id));
        if (!found || found.tenant_id !== s.tenantId) throw errors.notFound();
        const editor = lastEditor(found);
        await request.authorize(
          'job_aid.approve',
          {
            type: 'job_aid',
            id: found.id,
            tenantId: found.tenant_id,
            ...(op === 'approve' && editor ? { recordedBy: editor } : {}),
          },
          { asNotFound: true },
        );
        const { reason } = request.confirmation();
        const expected = request.expectedVersion();
        const from =
          op === 'approve' ? ['draft', 'exercise_draft'] : ['draft', 'exercise_draft', 'approved'];
        return request.tx(async (trx) => {
          const updated = await trx
            .updateTable('cg.job_aid')
            .set(
              op === 'approve'
                ? {
                    status: 'approved',
                    approved_by: s.accountId,
                    approved_at: new Date(),
                    updated_by: s.accountId,
                  }
                : { status: 'retired', updated_by: s.accountId },
            )
            .where('id', '=', found.id)
            .where('status', 'in', from as Row['status'][])
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst();
          if (!updated) {
            const current = (await one(trx, found.id))!;
            if (!from.includes(current.status))
              throw new ApiError(
                409,
                'job_aid_state',
                op === 'approve'
                  ? 'Only a draft can be approved.'
                  : 'This job aid is already retired.',
              );
            assertUpdated(updated, current);
          }
          await request.audit(trx, {
            action: op === 'approve' ? 'job_aid.approve' : 'job_aid.retire',
            targetType: 'job_aid',
            targetId: found.id,
            targetVersion: updated!.version,
            ...(reason ? { reason } : {}),
            changes: {
              fields: [{ name: 'status', from: found.status, to: updated!.status }],
            },
          });
          return answer(trx, updated!, s.accountId);
        });
      },
    );
};

/**
 * Resources beyond sites (BRD:FR-16.01–16.05, PUB-06, PUB-18, AC-16A/B/C,
 * ACC-35/49/51): hotlines, programs, deadlines and guidance with per-language
 * text that a person reviewed, accessible HTML checked before publishing, a
 * review date, an expiry date that turns the public page into "expired on",
 * and an outside-link check. Publishing is consequential (a named approver
 * and a reason) and lands in the publication log.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';
import { publicLinkCheck } from '@cg/adapters';
import { diffForAudit } from '@cg/audit';
import type { Database } from '@cg/db';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { checkResourceHtml, safeHref } from '../public/html.ts';
import { classifierFor, iso, listQuery, pickDefined, stamped, uuidParam } from './helpers.ts';

type ResourceRow = Selectable<Database['cg.resource']>;
type TextRow = Selectable<Database['cg.resource_text']>;
type Trx = Transaction<Database>;

const types = ['hotline', 'program', 'deadline', 'guidance', 'link', 'document'] as const;
const statuses = ['draft', 'published', 'expired', 'removed'] as const;

const textIn = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(500).nullable().optional(),
  bodyHtml: z.string().max(20_000).default(''),
  /** The person saving it read this translation (ACC-35); recorded as them. */
  humanReviewed: z.boolean().default(false),
});

const textOut = z.object({
  locale: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  bodyHtml: z.string(),
  humanReviewedBy: z.uuid().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  problems: z.array(z.string()),
});

const resourceOut = z.object({
  ...stamped,
  slug: z.string(),
  type: z.enum(types),
  category: z.string(),
  ordering: z.number().int(),
  ownerAccountId: z.uuid().nullable(),
  status: z.enum(statuses),
  reviewAt: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  referenceUrl: z.string().nullable(),
  linkStatus: z.enum(['unchecked', 'ok', 'broken']),
  linkCheckedAt: z.iso.datetime().nullable(),
  targeting: z.record(z.string(), z.unknown()),
  published: z.boolean(),
  publishedVersion: z.number().int().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  unpublishedAt: z.iso.datetime().nullable(),
  texts: z.array(textOut),
});
type ResourceOut = z.infer<typeof resourceOut>;

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'resource';

export interface ResourceDeps {
  /**
   * The link check; the default reaches only public addresses on web ports,
   * never the stack's own network (OWASP SSRF, ADR-0042).
   */
  checkLink?: (url: string) => Promise<boolean>;
}

export const resourceRoutes =
  (deps: ResourceDeps = {}): FastifyPluginAsync =>
  async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const checkLink = deps.checkLink ?? publicLinkCheck();

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    const toOut = (r: ResourceRow, texts: TextRow[]): ResourceOut => ({
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      slug: r.slug,
      type: r.type,
      category: r.category,
      ordering: r.ordering,
      ownerAccountId: r.owner_account_id,
      status: r.status,
      reviewAt: r.review_at
        ? String(r.review_at instanceof Date ? r.review_at.toISOString().slice(0, 10) : r.review_at)
        : null,
      expiresAt: iso(r.expires_at),
      referenceUrl: r.reference_url,
      linkStatus: r.link_status,
      linkCheckedAt: iso(r.link_checked_at),
      targeting: (r.targeting ?? {}) as Record<string, unknown>,
      published: Boolean(r.published_at && !r.unpublished_at && r.status === 'published'),
      publishedVersion: r.published_version,
      publishedAt: iso(r.published_at),
      unpublishedAt: iso(r.unpublished_at),
      texts: texts.map((t) => ({
        locale: t.locale,
        title: t.title,
        summary: t.summary,
        bodyHtml: t.body_html,
        humanReviewedBy: t.human_reviewed_by,
        reviewedAt: iso(t.reviewed_at),
        problems: checkResourceHtml(t.body_html),
      })),
    });

    async function textsOf(trx: Trx, ids: string[]): Promise<Map<string, TextRow[]>> {
      const out = new Map<string, TextRow[]>();
      if (ids.length === 0) return out;
      const rows = await trx
        .selectFrom('cg.resource_text')
        .selectAll()
        .where('resource_id', 'in', ids)
        .orderBy('locale')
        .execute();
      for (const t of rows) out.set(t.resource_id, [...(out.get(t.resource_id) ?? []), t]);
      return out;
    }

    async function load(
      request: FastifyRequest,
      id: string,
    ): Promise<{ row: ResourceRow; texts: TextRow[] }> {
      const found = await request.tx(async (trx) => {
        const row = await trx
          .selectFrom('cg.resource')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        if (!row) return null;
        return { row, texts: (await textsOf(trx, [row.id])).get(row.id) ?? [] };
      });
      if (!found) throw errors.notFound();
      return found;
    }

    async function saveTexts(
      trx: Trx,
      tenantId: string,
      resourceId: string,
      texts: Record<string, z.infer<typeof textIn>>,
      accountId: string,
    ) {
      for (const [locale, t] of Object.entries(texts)) {
        const existing = await trx
          .selectFrom('cg.resource_text')
          .select('id')
          .where('resource_id', '=', resourceId)
          .where('locale', '=', locale)
          .executeTakeFirst();
        const reviewed = t.humanReviewed
          ? { human_reviewed_by: accountId, reviewed_at: new Date() }
          : { human_reviewed_by: null, reviewed_at: null };
        const values = {
          title: t.title,
          summary: t.summary ?? null,
          body_html: t.bodyHtml,
          ...reviewed,
          updated_by: accountId,
        };
        if (existing)
          await trx
            .updateTable('cg.resource_text')
            .set(values)
            .where('id', '=', existing.id)
            .execute();
        else
          await trx
            .insertInto('cg.resource_text')
            .values({
              tenant_id: tenantId,
              resource_id: resourceId,
              locale,
              created_by: accountId,
              ...values,
            })
            .execute();
      }
    }

    const columnMap = {
      type: 'type',
      category: 'category',
      ordering: 'ordering',
      reviewAt: 'review_at',
      expiresAt: 'expires_at',
      referenceUrl: 'reference_url',
      targeting: 'targeting',
    } as const;

    const fields = {
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
      type: z.enum(types),
      category: z.string().min(1).max(60),
      ordering: z.number().int().min(0).max(10_000),
      reviewAt: z.iso.date().nullable(),
      expiresAt: z.iso.datetime().nullable(),
      referenceUrl: z.string().url().max(500).nullable(),
      targeting: z.record(z.string(), z.unknown()),
      texts: z.record(z.string().min(2).max(10), textIn),
    };

    function columns(body: {
      [K in keyof typeof fields]?: z.infer<(typeof fields)[K]> | undefined;
    }) {
      const out = pickDefined(body as Record<string, unknown>, columnMap);
      if (body.targeting !== undefined) out['targeting'] = JSON.stringify(body.targeting);
      if (
        body.referenceUrl !== undefined &&
        body.referenceUrl !== null &&
        !safeHref(body.referenceUrl)
      )
        throw errors.validation([
          { name: 'referenceUrl', message: 'must be a web, phone or mail link' },
        ]);
      if (body.referenceUrl !== undefined)
        out['link_status'] = body.referenceUrl ? 'unchecked' : 'ok';
      return out;
    }

    // ------------------------------------------------------------------ list
    app.get(
      '/resources',
      {
        schema: {
          tags: ['resources'],
          querystring: listQuery.extend({
            status: z.enum(statuses).optional(),
            category: z.string().max(60).optional(),
          }),
          response: { 200: z.array(resourceOut) },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('resource.read', { type: 'resource', tenantId: s.tenantId });
        const q = request.query;
        return request.tx(async (trx) => {
          let x = trx
            .selectFrom('cg.resource')
            .selectAll()
            .orderBy('ordering')
            .orderBy('slug')
            .limit(q.limit)
            .offset(q.offset);
          if (q.status) x = x.where('status', '=', q.status);
          if (q.category) x = x.where('category', '=', q.category);
          const rows = await x.execute();
          const texts = await textsOf(
            trx,
            rows.map((r) => r.id),
          );
          return rows.map((r) => toOut(r, texts.get(r.id) ?? []));
        });
      },
    );

    app.get(
      '/resources/:id',
      { schema: { tags: ['resources'], params: uuidParam, response: { 200: resourceOut } } },
      async (request) => {
        const s = account(request);
        const found = await load(request, request.params.id);
        await request.authorize(
          'resource.read',
          { type: 'resource', id: found.row.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        return toOut(found.row, found.texts);
      },
    );

    // ---------------------------------------------------------------- create
    app.post(
      '/resources',
      {
        schema: {
          tags: ['resources'],
          body: z.object({
            ...fields,
            slug: fields.slug.optional(),
            category: fields.category.default('general'),
            ordering: fields.ordering.default(100),
            reviewAt: fields.reviewAt.optional(),
            expiresAt: fields.expiresAt.optional(),
            referenceUrl: fields.referenceUrl.optional(),
            targeting: fields.targeting.default({}),
          }),
          response: { 201: resourceOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        await request.authorize('resource.edit', { type: 'resource', tenantId: s.tenantId });
        const b = request.body;
        if (!b.texts['en'])
          throw errors.validation([
            { name: 'texts', message: 'English text is needed (the fallback language)' },
          ]);
        const out = await request.tx(async (trx) => {
          const slug = b.slug ?? slugify(b.texts['en']!.title);
          const taken = await trx
            .selectFrom('cg.resource')
            .select('id')
            .where('slug', '=', slug)
            .executeTakeFirst();
          if (taken)
            throw errors.validation([
              { name: 'slug', message: 'already used by another resource' },
            ]);
          const row = await trx
            .insertInto('cg.resource')
            .values({
              tenant_id: s.tenantId,
              slug,
              type: b.type,
              owner_account_id: s.accountId,
              created_by: s.accountId,
              updated_by: s.accountId,
              ...columns(b),
            } as never)
            .returningAll()
            .executeTakeFirstOrThrow();
          await saveTexts(trx, s.tenantId, row.id, b.texts, s.accountId);
          const texts = (await textsOf(trx, [row.id])).get(row.id) ?? [];
          await request.audit(trx, {
            action: 'resource.create',
            targetType: 'resource',
            targetId: row.id,
            targetVersion: row.version,
            changes: diffForAudit(
              null,
              row as unknown as Record<string, unknown>,
              classifierFor('resource'),
            ),
          });
          return toOut(row, texts);
        });
        return reply.code(201).send(out);
      },
    );

    // ---------------------------------------------------------------- update
    app.patch(
      '/resources/:id',
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['resources'],
          params: uuidParam,
          body: z.object({
            slug: fields.slug.optional(),
            type: fields.type.optional(),
            category: fields.category.optional(),
            ordering: fields.ordering.optional(),
            reviewAt: fields.reviewAt.optional(),
            expiresAt: fields.expiresAt.optional(),
            referenceUrl: fields.referenceUrl.optional(),
            targeting: fields.targeting.optional(),
            texts: fields.texts.optional(),
          }),
          response: { 200: resourceOut },
        },
      },
      async (request) => {
        const s = account(request);
        const expected = request.expectedVersion();
        const current = await load(request, request.params.id);
        await request.authorize(
          'resource.edit',
          { type: 'resource', id: current.row.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        const b = request.body;
        return request.tx(async (trx) => {
          const row = assertUpdated(
            await trx
              .updateTable('cg.resource')
              .set({
                ...columns(b),
                ...(b.slug ? { slug: b.slug } : {}),
                updated_by: s.accountId,
              } as never)
              .where('id', '=', current.row.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            toOut(current.row, current.texts),
          );
          if (b.texts) await saveTexts(trx, s.tenantId, row.id, b.texts, s.accountId);
          const texts = (await textsOf(trx, [row.id])).get(row.id) ?? [];
          await request.audit(trx, {
            action: 'resource.update',
            targetType: 'resource',
            targetId: row.id,
            targetVersion: row.version,
            changes: diffForAudit(
              current.row as unknown as Record<string, unknown>,
              row as unknown as Record<string, unknown>,
              classifierFor('resource'),
            ),
          });
          return toOut(row, texts);
        });
      },
    );

    // --------------------------------------------------------------- publish
    app.post(
      '/resources/:id/publish',
      { schema: { tags: ['resources'], params: uuidParam, response: { 200: resourceOut } } },
      async (request) => {
        const s = account(request);
        const current = await load(request, request.params.id);
        await request.authorize(
          'resource.publish',
          { type: 'resource', id: current.row.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        const problems: { name: string; message: string }[] = [];
        if (current.texts.length === 0)
          problems.push({ name: 'texts', message: 'no text to publish' });
        for (const t of current.texts) {
          if (!t.reviewed_at)
            problems.push({
              name: `texts.${t.locale}`,
              message: 'not human-reviewed (PUB-06, ACC-35)',
            });
          for (const p of checkResourceHtml(t.body_html))
            problems.push({ name: `texts.${t.locale}.bodyHtml`, message: p });
        }
        if (problems.length > 0) throw errors.validation(problems);
        const { reason } = request.confirmation();
        return request.tx(async (trx) => {
          const row = await trx
            .updateTable('cg.resource')
            .set({
              status: 'published',
              published_version: current.row.version + 1,
              published_at: new Date(),
              unpublished_at: null,
              updated_by: s.accountId,
            })
            .where('id', '=', current.row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('cg.publication')
            .values({
              tenant_id: s.tenantId,
              subject_kind: 'resource',
              subject_id: row.id,
              subject_version: row.version,
              snapshot: JSON.stringify(toOut(row, current.texts)),
              approved_by: s.accountId,
              reason: reason ?? 'published',
            })
            .execute();
          await request.audit(trx, {
            action: 'resource.publish',
            targetType: 'resource',
            targetId: row.id,
            targetVersion: row.version,
            reason,
            changes: { fields: [{ name: 'status', from: current.row.status, to: 'published' }] },
          });
          return toOut(row, current.texts);
        });
      },
    );

    app.post(
      '/resources/:id/unpublish',
      { schema: { tags: ['resources'], params: uuidParam, response: { 200: resourceOut } } },
      async (request) => {
        const s = account(request);
        const current = await load(request, request.params.id);
        await request.authorize(
          'resource.publish',
          { type: 'resource', id: current.row.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        const { reason } = request.confirmation();
        return request.tx(async (trx) => {
          const row = await trx
            .updateTable('cg.resource')
            .set({ status: 'removed', unpublished_at: new Date(), updated_by: s.accountId })
            .where('id', '=', current.row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('cg.publication')
            .set({ unpublished_at: new Date(), unpublished_by: s.accountId })
            .where('subject_kind', '=', 'resource')
            .where('subject_id', '=', row.id)
            .where('unpublished_at', 'is', null)
            .execute();
          await request.audit(trx, {
            action: 'resource.publish',
            targetType: 'resource',
            targetId: row.id,
            targetVersion: row.version,
            reason,
            changes: { fields: [{ name: 'status', from: current.row.status, to: 'removed' }] },
          });
          return toOut(row, current.texts);
        });
      },
    );

    // ------------------------------------------------------------ link check
    app.post(
      '/resources/:id/check-link',
      { schema: { tags: ['resources'], params: uuidParam, response: { 200: resourceOut } } },
      async (request) => {
        const s = account(request);
        const current = await load(request, request.params.id);
        await request.authorize(
          'resource.edit',
          { type: 'resource', id: current.row.id, tenantId: s.tenantId },
          { asNotFound: true },
        );
        const url = current.row.reference_url;
        const ok = url && /^https?:\/\//i.test(url) ? await checkLink(url) : !url;
        return request.tx(async (trx) => {
          const row = await trx
            .updateTable('cg.resource')
            .set({
              link_status: ok ? 'ok' : 'broken',
              link_checked_at: new Date(),
              updated_by: s.accountId,
            })
            .where('id', '=', current.row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'resource.update',
            targetType: 'resource',
            targetId: row.id,
            targetVersion: row.version,
            changes: {
              fields: [{ name: 'link_status', from: current.row.link_status, to: row.link_status }],
            },
          });
          return toOut(row, current.texts);
        });
      },
    );
  };

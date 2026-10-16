/**
 * The county's event templates (CON-02: "event templates by hazard (tornado,
 * flood, winter storm, wildfire) preset map layers, intake questions, public
 * messages and keywords. A new event can be opened and intake published in
 * under 5 minutes."). A template names its hazard (which chooses the intake
 * questions), the SMS keywords the event opens with, the situation map's
 * first layers and the public safety messages drafted when the event opens.
 * The shipped four are added on request and are the county's to change
 * (ADM-01: every change audited). Also: what an event takes from its
 * template, and drafting the template's messages into Resources.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { Database } from '@cg/db';
import { EVENT_TEMPLATE_DEFAULTS, MAP_LAYERS, type EventTemplateConfig } from '@cg/intake';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, iso, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;

/** SMS keywords are single words, upper-cased, letters only (docs/06). */
const keyword = z
  .string()
  .min(2)
  .max(20)
  .regex(/^[A-ZÁÉÍÓÚÑ]+$/, 'one word, capital letters');
const text = z.object({ title: z.string().min(1).max(200), summary: z.string().min(1).max(1000) });

export const templateConfig = z.object({
  keywords: z.array(keyword).min(1).max(6),
  mapLayers: z.array(z.enum(MAP_LAYERS)).max(MAP_LAYERS.length),
  messages: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
        texts: z.object({ en: text, es: text.optional() }),
      }),
    )
    .max(10),
});
type Config = z.infer<typeof templateConfig>;

/** A stored config read safely: what does not fit the shape is treated as empty. */
export const configOf = (raw: unknown): Config | null => {
  const parsed = templateConfig.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const templateOut = z.object({
  ...stamped,
  hazardType: z.string(),
  name: z.string(),
  config: templateConfig.nullable(),
});

type TemplateRow = {
  id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  hazard_type: string;
  name: string;
  config: unknown;
};
const toOut = (r: TemplateRow): z.infer<typeof templateOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  hazardType: r.hazard_type,
  name: r.name,
  config: configOf(r.config),
});

/**
 * CON-02, PUB: the template's safety messages, drafted into Resources for the public information
 * officer to check and publish; never published here. One draft per message and intake link, so
 * opening again drafts nothing twice.
 */
export async function draftTemplateMessages(
  trx: Trx,
  tenantId: string,
  accountId: string,
  event: { id: string; intakeSlug: string },
  config: Pick<EventTemplateConfig, 'messages'> | Config,
): Promise<string[]> {
  const drafted: string[] = [];
  for (const m of config.messages) {
    const slug = `${m.key}-${event.intakeSlug}`.slice(0, 61).replace(/-+$/, '');
    const taken = await trx
      .selectFrom('cg.resource')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (taken) continue;
    const row = await trx
      .insertInto('cg.resource')
      .values({
        tenant_id: tenantId,
        slug,
        type: 'guidance',
        category: 'safety',
        owner_account_id: accountId,
        targeting: JSON.stringify({ eventId: event.id, fromTemplate: m.key }),
        created_by: accountId,
        updated_by: accountId,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [locale, t] of Object.entries(m.texts))
      if (t)
        await trx
          .insertInto('cg.resource_text')
          .values({
            tenant_id: tenantId,
            resource_id: row.id,
            locale,
            title: t.title,
            summary: t.summary,
            created_by: accountId,
            updated_by: accountId,
          } as never)
          .execute();
    drafted.push(row.id);
  }
  return drafted;
}

export const eventTemplateRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  app.get(
    '/event-templates',
    { schema: { tags: ['events'], response: { 200: z.array(templateOut) } } },
    async (request) => {
      const s = account(request);
      await request.authorize('event.read', { type: 'event', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx.selectFrom('cg.event_template').selectAll().orderBy('name').execute(),
      );
      return rows.map(toOut);
    },
  );

  /** Adds the shipped template for each hazard the county has none for yet. */
  app.post(
    '/event-templates/defaults',
    { schema: { tags: ['events'], response: { 200: z.array(templateOut) } } },
    async (request) => {
      const s = account(request);
      await request.authorize('event.template_edit', { type: 'event', tenantId: s.tenantId });
      return request.tx(async (trx) => {
        const have = new Set(
          (await trx.selectFrom('cg.event_template').select('hazard_type').execute()).map(
            (r) => r.hazard_type,
          ),
        );
        for (const d of EVENT_TEMPLATE_DEFAULTS) {
          if (have.has(d.hazardType)) continue;
          const row = await trx
            .insertInto('cg.event_template')
            .values({
              tenant_id: s.tenantId,
              hazard_type: d.hazardType,
              name: d.name,
              config: JSON.stringify(d.config),
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'event.template_edit',
            targetType: 'event_template',
            targetId: row.id,
            targetVersion: row.version,
            changes: diffForAudit(
              null,
              { hazard_type: row.hazard_type, name: row.name },
              classifierFor('event_template'),
            ),
          });
        }
        const rows = await trx
          .selectFrom('cg.event_template')
          .selectAll()
          .orderBy('name')
          .execute();
        return rows.map(toOut);
      });
    },
  );

  app.put(
    '/event-templates/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['events'],
        params: uuidParam,
        body: z.object({
          name: z.string().min(1).max(120).optional(),
          config: templateConfig.optional(),
        }),
        response: { 200: templateOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await request.tx((trx) =>
        trx
          .selectFrom('cg.event_template')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!current) throw errors.notFound();
      await request.authorize(
        'event.template_edit',
        { type: 'event', tenantId: current.tenant_id },
        { asNotFound: true },
      );
      const b = request.body;
      return request.tx(async (trx) => {
        const row = assertUpdated(
          await trx
            .updateTable('cg.event_template')
            .set({
              ...(b.name ? { name: b.name } : {}),
              ...(b.config ? { config: JSON.stringify(b.config) } : {}),
              updated_by: s.accountId,
            })
            .where('id', '=', current.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          toOut(current),
        );
        await request.audit(trx, {
          action: 'event.template_edit',
          targetType: 'event_template',
          targetId: row.id,
          targetVersion: row.version,
          changes: diffForAudit(
            current as unknown as Record<string, unknown>,
            row as unknown as Record<string, unknown>,
            classifierFor('event_template'),
          ),
        });
        return toOut(row);
      });
    },
  );

  /** What an event takes from its template: the situation map's first layers among them. */
  app.get(
    '/events/:id/template',
    {
      schema: {
        tags: ['events'],
        params: uuidParam,
        response: {
          200: z.object({
            templateId: z.uuid(),
            name: z.string(),
            hazardType: z.string(),
            keywords: z.array(z.string()),
            mapLayers: z.array(z.string()),
          }),
        },
      },
    },
    async (request) => {
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.event as e')
          .innerJoin('cg.event_template as t', 't.id', 'e.template_id')
          .select([
            'e.id',
            'e.tenant_id',
            't.id as template_id',
            't.name',
            't.hazard_type',
            't.config',
          ])
          .where('e.id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      await request.authorize(
        'event.read',
        { type: 'event', id: row.id, tenantId: row.tenant_id, eventId: row.id },
        { asNotFound: true },
      );
      const config = configOf(row.config);
      return {
        templateId: row.template_id,
        name: row.name,
        hazardType: row.hazard_type,
        keywords: config?.keywords ?? [],
        mapLayers: config?.mapLayers ?? [],
      };
    },
  );
};

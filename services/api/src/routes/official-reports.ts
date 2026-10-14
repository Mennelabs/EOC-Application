/**
 * Official reports (layer-6 task E; F15, RULE-10, RULE-14, RPT-01, CON-06,
 * AC-15A/B/C, A7): situation reports and briefings.
 * - A draft is built from the records: facts computed by packages/reporting
 *   (each citing its definition and, for damage, the record versions used),
 *   a summary drafted from the facts and labelled as drafted until a person
 *   edits it, and judgments staff write and are named against.
 * - Someone other than the author reviews it (approve, or return with a
 *   note); any change after review sends it back to draft. A summary still
 *   as drafted cannot be approved: a person confirms every narrative.
 * - Someone other than the author issues it, with a confirmed reason. The
 *   issued content, exactly as reviewed, is frozen in an append-only
 *   snapshot with its SHA-256; the worker writes a copy under object lock.
 * - An issued report is never changed: an amendment is a new draft that,
 *   once issued, supersedes it. Records changed after issue leave the issued
 *   snapshot as it was (AC-15A).
 * - What changed since the last issued report: its frozen facts against the
 *   facts now (CON-06).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { Database, OfficialReportSectionTable, OfficialReportTable } from '@cg/db';
import {
  compareFacts,
  computeFacts,
  contentHash,
  draftSummary,
  type Fact,
  type RecordRef,
} from '@cg/reporting';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, enqueueOutbox, iso, listQuery, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type ReportRow = Selectable<OfficialReportTable>;
type SectionRow = Selectable<OfficialReportSectionTable>;

/** Kinds drafted here; the FEMA packages and the media sheet come with their own tasks (F, I). */
const KINDS = ['sitrep', 'briefing'] as const;
const KIND_TITLE: Record<(typeof KINDS)[number], string> = {
  sitrep: 'Situation report',
  briefing: 'Briefing',
};
const JUDGMENTS = [
  { key: 'outlook', title: 'Outlook for the next period' },
  { key: 'priorities', title: 'Priorities and actions' },
] as const;
const TEXT_LIMIT = 5000;

const sectionOut = z.object({
  key: z.string(),
  position: z.number().int(),
  kind: z.enum(['fact', 'judgment', 'narrative']),
  title: z.string(),
  content: z.unknown(),
  definition: z.unknown().nullable(),
  recordCount: z.number().int(),
  drafted: z.boolean(),
  editedBy: z.uuid().nullable(),
  editedByName: z.string().nullable(),
  editedAt: z.iso.datetime().nullable(),
});

const reportOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  eventId: z.uuid(),
  kind: z.string(),
  sequence: z.number().int(),
  title: z.string(),
  periodFrom: z.iso.datetime(),
  periodTo: z.iso.datetime(),
  timeZone: z.string(),
  cutoff: z.iso.datetime(),
  state: z.enum(['draft', 'reviewed', 'issued', 'superseded', 'withdrawn']),
  classification: z.enum(['internal', 'public']),
  authorId: z.uuid(),
  authorName: z.string().nullable(),
  reviewerId: z.uuid().nullable(),
  reviewerName: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewNote: z.string().nullable(),
  issuerId: z.uuid().nullable(),
  issuerName: z.string().nullable(),
  issuedAt: z.iso.datetime().nullable(),
  amends: z.uuid().nullable(),
  amendedBy: z.uuid().nullable(),
  factsAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const detailOut = reportOut.extend({
  sections: z.array(sectionOut),
  snapshot: z
    .object({
      id: z.uuid(),
      contentHash: z.string(),
      issuedAt: z.iso.datetime(),
      reason: z.string(),
      recordCount: z.number().int(),
      lock: z
        .object({
          objectKey: z.string(),
          lockMode: z.string(),
          retainUntil: z.iso.datetime(),
          writtenAt: z.iso.datetime(),
        })
        .nullable(),
    })
    .nullable(),
});

const changesOut = z.object({
  since: z
    .object({
      reportId: z.uuid(),
      title: z.string(),
      issuedAt: z.iso.datetime(),
      cutoff: z.iso.datetime(),
    })
    .nullable(),
  asOf: z.iso.datetime(),
  changes: z.array(
    z.object({
      fact: z.string(),
      title: z.string(),
      key: z.string(),
      label: z.string(),
      before: z.number().nullable(),
      after: z.number().nullable(),
    }),
  ),
});

type Detail = z.infer<typeof detailOut>;

const factContent = (f: Fact) => ({ rows: f.rows, note: f.note });
/** What the figures describe: the cutoff, or now while the cutoff is still ahead. */
const asOf = (cutoff: Date | string) => new Date(Math.min(new Date(cutoff).getTime(), Date.now()));
const factSources = (f: Fact) => ({ definition: f.definition, records: f.records });

export const officialReportRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  const names = async (trx: Trx, ids: (string | null)[]) => {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map<string, string>();
    const rows = await trx
      .selectFrom('cg.account')
      .select(['id', 'display_name'])
      .where('id', 'in', want)
      .execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  };

  const view = (r: ReportRow, who: Map<string, string>, amendedBy: string | null) => ({
    id: r.id,
    version: r.version,
    eventId: r.event_id,
    kind: r.kind,
    sequence: r.sequence,
    title: r.title,
    periodFrom: iso(r.period_from)!,
    periodTo: iso(r.period_to)!,
    timeZone: r.time_zone,
    cutoff: iso(r.cutoff)!,
    state: r.state,
    classification: r.classification,
    authorId: r.author_id,
    authorName: who.get(r.author_id) ?? null,
    reviewerId: r.reviewer_id,
    reviewerName: r.reviewer_id ? (who.get(r.reviewer_id) ?? null) : null,
    reviewedAt: iso(r.reviewed_at),
    reviewNote: r.review_note,
    issuerId: r.issuer_id,
    issuerName: r.issuer_id ? (who.get(r.issuer_id) ?? null) : null,
    issuedAt: iso(r.issued_at),
    amends: r.amends,
    amendedBy,
    factsAt: iso(r.facts_at)!,
    updatedAt: iso(r.updated_at)!,
  });

  const sectionView = (x: SectionRow, who: Map<string, string>) => {
    const sources = (x.sources ?? {}) as { definition?: unknown; records?: unknown[] };
    return {
      key: x.key,
      position: x.position,
      kind: x.kind,
      title: x.title,
      content: x.content,
      definition: sources.definition ?? null,
      recordCount: sources.records?.length ?? 0,
      drafted: x.drafted,
      editedBy: x.edited_by,
      editedByName: x.edited_by ? (who.get(x.edited_by) ?? null) : null,
      editedAt: iso(x.edited_at),
    };
  };

  async function detail(trx: Trx, id: string): Promise<Detail> {
    const r = await trx
      .selectFrom('cg.official_report')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw errors.notFound();
    const sections = await trx
      .selectFrom('cg.official_report_section')
      .selectAll()
      .where('report_id', '=', id)
      .orderBy('position')
      .execute();
    const amendment = await trx
      .selectFrom('cg.official_report')
      .select('id')
      .where('amends', '=', id)
      .where('state', '<>', 'withdrawn')
      .executeTakeFirst();
    const snap = await trx
      .selectFrom('cg.official_report_snapshot as s')
      .leftJoin('cg.official_report_lock as l', 'l.snapshot_id', 's.id')
      .select([
        's.id',
        's.content_hash',
        's.issued_at',
        's.reason',
        sql<number>`jsonb_array_length(s.record_versions)`.as('record_count'),
        'l.object_key',
        'l.lock_mode',
        'l.retain_until',
        'l.written_at',
      ])
      .where('s.report_id', '=', id)
      .executeTakeFirst();
    const who = await names(trx, [
      r.author_id,
      r.reviewer_id,
      r.issuer_id,
      ...sections.map((x) => x.edited_by),
    ]);
    return {
      ...view(r, who, amendment?.id ?? null),
      sections: sections.map((x) => sectionView(x, who)),
      snapshot: snap
        ? {
            id: snap.id,
            contentHash: snap.content_hash,
            issuedAt: iso(snap.issued_at)!,
            reason: snap.reason,
            recordCount: Number(snap.record_count),
            lock:
              snap.object_key && snap.lock_mode && snap.retain_until && snap.written_at
                ? {
                    objectKey: snap.object_key,
                    lockMode: snap.lock_mode,
                    retainUntil: iso(snap.retain_until)!,
                    writtenAt: iso(snap.written_at)!,
                  }
                : null,
          }
        : null,
    };
  }

  const load = async (trx: Trx, id: string) => {
    const r = await trx
      .selectFrom('cg.official_report')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw errors.notFound();
    return r;
  };

  const editable = (r: ReportRow) => {
    if (r.state !== 'draft' && r.state !== 'reviewed')
      throw new ApiError(
        409,
        'report_not_editable',
        r.state === 'issued' || r.state === 'superseded'
          ? 'An issued report is never changed. Draft an amendment instead.'
          : 'This report was withdrawn.',
      );
  };

  /** A change after review sends the report back to draft (the reviewer approved what they read). */
  const backToDraft = {
    state: 'draft' as const,
    reviewer_id: null,
    reviewed_at: null,
    reviewed_version: null,
  };

  const factsFor = (
    trx: Trx,
    r: Pick<ReportRow, 'event_id' | 'period_from' | 'period_to' | 'cutoff'>,
  ) =>
    computeFacts(trx, {
      eventId: r.event_id,
      periodFrom: new Date(r.period_from),
      periodTo: new Date(r.period_to),
      cutoff: new Date(r.cutoff),
    });

  async function insertSections(
    trx: Trx,
    r: ReportRow,
    facts: Fact[],
    actor: string,
    judgments: Map<
      string,
      { text: string; editedBy: string | null; editedAt: Date | null }
    > = new Map(),
  ) {
    const rows = [
      {
        key: 'summary',
        kind: 'narrative' as const,
        title: 'Summary',
        content: { text: draftSummary(facts, asOf(r.cutoff), r.time_zone) },
        sources: {},
        drafted: true,
        edited_by: null,
        edited_at: null,
      },
      ...facts.map((f) => ({
        key: f.key,
        kind: 'fact' as const,
        title: f.title,
        content: factContent(f),
        sources: factSources(f),
        drafted: false,
        edited_by: null,
        edited_at: null,
      })),
      ...JUDGMENTS.map((j) => {
        const held = judgments.get(j.key);
        return {
          key: j.key,
          kind: 'judgment' as const,
          title: j.title,
          content: { text: held?.text ?? '' },
          sources: {},
          drafted: false,
          edited_by: held?.editedBy ?? null,
          edited_at: held?.editedAt ?? null,
        };
      }),
    ];
    await trx
      .insertInto('cg.official_report_section')
      .values(
        rows.map((x, position) => ({
          tenant_id: r.tenant_id,
          report_id: r.id,
          key: x.key,
          position,
          kind: x.kind,
          title: x.title,
          content: JSON.stringify(x.content),
          sources: JSON.stringify(x.sources),
          drafted: x.drafted,
          edited_by: x.edited_by,
          edited_at: x.edited_at,
          created_by: actor,
          updated_by: actor,
        })),
      )
      .execute();
  }

  // ------------------------------------------------------------------ list
  app.get(
    '/official-reports',
    {
      schema: {
        tags: ['official-reports'],
        querystring: listQuery.extend({
          eventId: z.uuid().optional(),
          kind: z.enum(KINDS).optional(),
          state: z.enum(['draft', 'reviewed', 'issued', 'superseded', 'withdrawn']).optional(),
        }),
        response: { 200: z.array(reportOut) },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('official_report.read', {
        type: 'official_report',
        tenantId: s.tenantId,
      });
      const q = request.query;
      return request.tx(async (trx) => {
        let x = trx
          .selectFrom('cg.official_report')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(q.limit)
          .offset(q.offset);
        if (q.eventId) x = x.where('event_id', '=', q.eventId);
        if (q.kind) x = x.where('kind', '=', q.kind);
        if (q.state) x = x.where('state', '=', q.state);
        const rows = await x.execute();
        const amendments = rows.length
          ? await trx
              .selectFrom('cg.official_report')
              .select(['id', 'amends'])
              .where(
                'amends',
                'in',
                rows.map((r) => r.id),
              )
              .where('state', '<>', 'withdrawn')
              .execute()
          : [];
        const who = await names(
          trx,
          rows.flatMap((r) => [r.author_id, r.reviewer_id, r.issuer_id]),
        );
        return rows.map((r) => view(r, who, amendments.find((a) => a.amends === r.id)?.id ?? null));
      });
    },
  );

  // ------------------------------------------------------------------ draft
  app.post(
    '/official-reports',
    {
      schema: {
        tags: ['official-reports'],
        body: z
          .object({
            clientUuid: z.uuid(),
            eventId: z.uuid(),
            kind: z.enum(KINDS),
            periodFrom: z.iso.datetime({ offset: true }),
            periodTo: z.iso.datetime({ offset: true }),
            /** Records after this are not in the facts; the period's end by default. */
            cutoff: z.iso.datetime({ offset: true }).optional(),
            classification: z.enum(['internal', 'public']).default('internal'),
          })
          .refine((b) => b.periodTo > b.periodFrom, {
            message: 'the period must end after it starts',
            path: ['periodTo'],
          })
          .refine(
            (b) =>
              !b.cutoff ||
              (Date.parse(b.cutoff) > Date.parse(b.periodFrom) &&
                Date.parse(b.cutoff) <= Date.parse(b.periodTo)),
            { message: 'the cutoff must fall inside the period', path: ['cutoff'] },
          ),
        response: { 201: detailOut, 200: detailOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await request.authorize('official_report.draft', {
        type: 'official_report',
        tenantId: s.tenantId,
        eventId: b.eventId,
      });
      const { id, created } = await request.tx(async (trx) => {
        const held = await trx
          .selectFrom('cg.official_report')
          .select('id')
          .where('client_uuid', '=', b.clientUuid)
          .executeTakeFirst();
        if (held) return { id: held.id, created: false };
        const event = await trx
          .selectFrom('cg.event as e')
          .innerJoin('cg.tenant as t', 't.id', 'e.tenant_id')
          .select(['e.id', 'e.tenant_id', 't.timezone'])
          .where('e.id', '=', b.eventId)
          .executeTakeFirst();
        if (!event) throw errors.notFound();
        const last = await trx
          .selectFrom('cg.official_report')
          .select(sql<number>`coalesce(max(sequence), 0)`.as('n'))
          .where('event_id', '=', b.eventId)
          .where('kind', '=', b.kind)
          .where('amends', 'is', null)
          .executeTakeFirstOrThrow();
        const sequence = Number(last.n) + 1;
        const facts = await computeFacts(trx, {
          eventId: b.eventId,
          periodFrom: new Date(b.periodFrom),
          periodTo: new Date(b.periodTo),
          cutoff: new Date(b.cutoff ?? b.periodTo),
        });
        const r = await trx
          .insertInto('cg.official_report')
          .values({
            tenant_id: event.tenant_id,
            event_id: b.eventId,
            client_uuid: b.clientUuid,
            kind: b.kind,
            sequence,
            title: `${KIND_TITLE[b.kind]} ${sequence}`,
            period_from: b.periodFrom,
            period_to: b.periodTo,
            time_zone: event.timezone,
            cutoff: b.cutoff ?? b.periodTo,
            classification: b.classification,
            author_id: s.accountId,
            facts_at: new Date(),
            definitions: JSON.stringify(facts.map((f) => f.definition)),
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await insertSections(trx, r, facts, s.accountId);
        await request.audit(trx, {
          action: 'official_report.draft',
          targetType: 'official_report',
          targetId: r.id,
          targetVersion: r.version,
          changes: diffForAudit(
            null,
            {
              kind: r.kind,
              sequence,
              period_from: b.periodFrom,
              period_to: b.periodTo,
              cutoff: r.cutoff,
            },
            classifierFor('official_report'),
          ),
        });
        return { id: r.id, created: true };
      });
      const out = await request.tx((trx) => detail(trx, id));
      return reply.code(created ? 201 : 200).send(out);
    },
  );

  // ------------------------------------------------------------------ read
  app.get(
    '/official-reports/:id',
    { schema: { tags: ['official-reports'], params: uuidParam, response: { 200: detailOut } } },
    async (request) => {
      const s = account(request);
      await request.authorize(
        'official_report.read',
        { type: 'official_report', id: request.params.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      return request.tx((trx) => detail(trx, request.params.id));
    },
  );

  // ------------------------------------------------------------------ edit a section
  app.put(
    '/official-reports/:id/sections/:key',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['official-reports'],
        params: uuidParam.extend({ key: z.string().min(1).max(40) }),
        body: z.object({ text: z.string().max(TEXT_LIMIT) }),
        response: { 200: detailOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      await request.authorize(
        'official_report.draft',
        { type: 'official_report', id: request.params.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      await request.tx(async (trx) => {
        const r = await load(trx, request.params.id);
        editable(r);
        const section = await trx
          .selectFrom('cg.official_report_section')
          .selectAll()
          .where('report_id', '=', r.id)
          .where('key', '=', request.params.key)
          .executeTakeFirst();
        if (!section) throw errors.notFound();
        if (section.kind === 'fact')
          throw new ApiError(
            409,
            'fact_not_editable',
            'Facts come from the records. Refresh the facts, or correct the records they come from.',
          );
        const saved = assertUpdated(
          await trx
            .updateTable('cg.official_report')
            .set({ ...backToDraft, version: sql`version + 1`, updated_by: s.accountId })
            .where('id', '=', r.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          { id: r.id, version: r.version },
        );
        await trx
          .updateTable('cg.official_report_section')
          .set({
            content: JSON.stringify({ text: request.body.text }),
            drafted: false,
            edited_by: s.accountId,
            edited_at: new Date(),
            version: sql`version + 1`,
            updated_by: s.accountId,
          })
          .where('id', '=', section.id)
          .execute();
        await request.audit(trx, {
          action: 'official_report.draft',
          targetType: 'official_report',
          targetId: r.id,
          targetVersion: saved.version,
          changes: {
            section: request.params.key,
            ...(r.state === 'reviewed' ? { state: { from: 'reviewed', to: 'draft' } } : {}),
          },
        });
      });
      return request.tx((trx) => detail(trx, request.params.id));
    },
  );

  // ------------------------------------------------------------------ refresh the facts
  app.post(
    '/official-reports/:id/refresh',
    {
      config: { requiresVersion: true },
      schema: { tags: ['official-reports'], params: uuidParam, response: { 200: detailOut } },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      await request.authorize(
        'official_report.draft',
        { type: 'official_report', id: request.params.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      await request.tx(async (trx) => {
        const r = await load(trx, request.params.id);
        editable(r);
        const facts = await factsFor(trx, r);
        const saved = assertUpdated(
          await trx
            .updateTable('cg.official_report')
            .set({
              ...backToDraft,
              facts_at: new Date(),
              definitions: JSON.stringify(facts.map((f) => f.definition)),
              version: sql`version + 1`,
              updated_by: s.accountId,
            })
            .where('id', '=', r.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          { id: r.id, version: r.version },
        );
        for (const f of facts)
          await trx
            .updateTable('cg.official_report_section')
            .set({
              content: JSON.stringify(factContent(f)),
              sources: JSON.stringify(factSources(f)),
              version: sql`version + 1`,
              updated_by: s.accountId,
            })
            .where('report_id', '=', r.id)
            .where('key', '=', f.key)
            .execute();
        // A summary nobody has edited yet follows the new facts; an edited one stays as written.
        await trx
          .updateTable('cg.official_report_section')
          .set({
            content: JSON.stringify({ text: draftSummary(facts, asOf(r.cutoff), r.time_zone) }),
            version: sql`version + 1`,
            updated_by: s.accountId,
          })
          .where('report_id', '=', r.id)
          .where('key', '=', 'summary')
          .where('drafted', '=', true)
          .execute();
        await request.audit(trx, {
          action: 'official_report.draft',
          targetType: 'official_report',
          targetId: r.id,
          targetVersion: saved.version,
          changes: { facts: 'refreshed' },
        });
      });
      return request.tx((trx) => detail(trx, request.params.id));
    },
  );

  // ------------------------------------------------------------------ review
  app.post(
    '/official-reports/:id/review',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['official-reports'],
        params: uuidParam,
        body: z
          .object({
            decision: z.enum(['approve', 'return']),
            note: z.string().trim().max(2000).optional(),
          })
          .refine((b) => b.decision === 'approve' || !!b.note, {
            message: 'say what needs to change',
            path: ['note'],
          }),
        response: { 200: detailOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await request.tx((trx) => load(trx, request.params.id));
      // A7, G4: the author never reviews their own report.
      await request.authorize(
        'official_report.review',
        {
          type: 'official_report',
          id: current.id,
          tenantId: s.tenantId,
          eventId: current.event_id,
          recordedBy: current.author_id,
        },
        { asNotFound: true },
      );
      if (current.author_id === s.accountId)
        throw new ApiError(403, 'self_review', 'Someone other than the author reviews a report.');
      await request.tx(async (trx) => {
        const r = await load(trx, request.params.id);
        if (r.state !== 'draft')
          throw new ApiError(
            409,
            'not_a_draft',
            `This report is ${r.state}; only a draft is reviewed.`,
          );
        const b = request.body;
        if (b.decision === 'approve') {
          const drafted = await trx
            .selectFrom('cg.official_report_section')
            .select('title')
            .where('report_id', '=', r.id)
            .where('drafted', '=', true)
            .execute();
          if (drafted.length)
            throw new ApiError(
              409,
              'narrative_not_confirmed',
              `${drafted.map((d) => d.title).join(', ')} is still as drafted from the data. The author reads and saves it before review.`,
            );
        }
        const saved = assertUpdated(
          await trx
            .updateTable('cg.official_report')
            .set(
              b.decision === 'approve'
                ? {
                    state: 'reviewed',
                    reviewer_id: s.accountId,
                    reviewed_at: new Date(),
                    reviewed_version: expected + 1,
                    review_note: b.note ?? null,
                    version: sql`version + 1`,
                    updated_by: s.accountId,
                  }
                : {
                    review_note: b.note ?? null,
                    version: sql`version + 1`,
                    updated_by: s.accountId,
                  },
            )
            .where('id', '=', r.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          { id: r.id, version: r.version },
        );
        await request.audit(trx, {
          action: 'official_report.review',
          targetType: 'official_report',
          targetId: r.id,
          targetVersion: saved.version,
          changes: { decision: b.decision },
          reason: b.note ?? null,
        });
      });
      return request.tx((trx) => detail(trx, request.params.id));
    },
  );

  // ------------------------------------------------------------------ issue
  app.post(
    '/official-reports/:id/issue',
    {
      config: { requiresVersion: true },
      schema: { tags: ['official-reports'], params: uuidParam, response: { 200: detailOut } },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      const current = await request.tx((trx) => load(trx, request.params.id));
      // A7, G4, RULE-14: someone other than the author issues, confirming with a reason.
      await request.authorize(
        'official_report.issue',
        {
          type: 'official_report',
          id: current.id,
          tenantId: s.tenantId,
          eventId: current.event_id,
          recordedBy: current.author_id,
        },
        { asNotFound: true },
      );
      if (current.author_id === s.accountId)
        throw new ApiError(403, 'self_review', 'Someone other than the author issues a report.');
      const { reason } = request.confirmation();
      await request.tx(async (trx) => {
        const r = await load(trx, request.params.id);
        // AC-15C: a draft is never issued without review.
        if (r.state !== 'reviewed')
          throw new ApiError(
            409,
            'not_reviewed',
            r.state === 'draft'
              ? 'This report has not been reviewed. Someone other than the author reviews it first.'
              : `This report is ${r.state}.`,
          );
        if (r.version !== expected) throw errors.conflict({ id: r.id, version: r.version });
        if (r.reviewed_version !== r.version)
          throw new ApiError(409, 'changed_since_review', 'The report changed after review.');
        const sections = await trx
          .selectFrom('cg.official_report_section')
          .selectAll()
          .where('report_id', '=', r.id)
          .orderBy('position')
          .execute();
        const issuedAt = new Date();
        const who = await names(trx, [
          r.author_id,
          r.reviewer_id,
          s.accountId,
          ...sections.map((x) => x.edited_by),
        ]);
        const records: RecordRef[] = sections.flatMap(
          (x) => (x.sources as { records?: RecordRef[] } | null)?.records ?? [],
        );
        // Exactly what was reviewed, with who wrote, reviewed and issued it.
        const content = {
          report: {
            id: r.id,
            eventId: r.event_id,
            kind: r.kind,
            sequence: r.sequence,
            title: r.title,
            periodFrom: iso(r.period_from),
            periodTo: iso(r.period_to),
            timeZone: r.time_zone,
            cutoff: iso(r.cutoff),
            classification: r.classification,
            amends: r.amends,
            factsAt: iso(r.facts_at),
            author: { id: r.author_id, name: who.get(r.author_id) ?? null },
            reviewer: {
              id: r.reviewer_id,
              name: who.get(r.reviewer_id!) ?? null,
              at: iso(r.reviewed_at),
            },
            issuer: {
              id: s.accountId,
              name: who.get(s.accountId) ?? null,
              at: issuedAt.toISOString(),
            },
          },
          sections: sections.map((x) => ({
            key: x.key,
            kind: x.kind,
            title: x.title,
            content: x.content,
            definition: (x.sources as { definition?: unknown } | null)?.definition ?? null,
            editedBy: x.edited_by ? (who.get(x.edited_by) ?? x.edited_by) : null,
            editedAt: iso(x.edited_at),
          })),
        };
        const hash = contentHash(content);
        const snap = await trx
          .insertInto('cg.official_report_snapshot')
          .values({
            tenant_id: r.tenant_id,
            report_id: r.id,
            content: JSON.stringify(content),
            record_versions: JSON.stringify(records),
            reference_snapshots: JSON.stringify([]),
            content_hash: hash,
            issued_by: s.accountId,
            issued_at: issuedAt,
            reason: reason ?? '',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const saved = await trx
          .updateTable('cg.official_report')
          .set({
            state: 'issued',
            issuer_id: s.accountId,
            issued_at: issuedAt,
            version: sql`version + 1`,
            updated_by: s.accountId,
          })
          .where('id', '=', r.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        if (r.amends)
          await trx
            .updateTable('cg.official_report')
            .set({ state: 'superseded', version: sql`version + 1`, updated_by: s.accountId })
            .where('id', '=', r.amends)
            .where('state', '=', 'issued')
            .execute();
        await enqueueOutbox(
          trx,
          r.tenant_id,
          'official_report.issued',
          { reportId: r.id, snapshotId: snap.id },
          request.executionId,
        );
        await request.audit(trx, {
          action: 'official_report.issue',
          targetType: 'official_report',
          targetId: r.id,
          targetVersion: saved.version,
          changes: {
            state: { from: 'reviewed', to: 'issued' },
            contentHash: hash,
            amends: r.amends,
          },
          reason,
        });
      });
      return request.tx((trx) => detail(trx, request.params.id));
    },
  );

  // ------------------------------------------------------------------ amend
  app.post(
    '/official-reports/:id/amend',
    {
      schema: {
        tags: ['official-reports'],
        params: uuidParam,
        body: z.object({ clientUuid: z.uuid() }),
        response: { 201: detailOut, 200: detailOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      await request.authorize(
        'official_report.draft',
        { type: 'official_report', id: request.params.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      const { id, created } = await request.tx(async (trx) => {
        const held = await trx
          .selectFrom('cg.official_report')
          .select('id')
          .where('client_uuid', '=', request.body.clientUuid)
          .executeTakeFirst();
        if (held) return { id: held.id, created: false };
        const r = await load(trx, request.params.id);
        if (r.state !== 'issued')
          throw new ApiError(
            409,
            'not_amendable',
            r.state === 'superseded'
              ? 'An amendment of this report was issued; amend the latest one.'
              : 'Only an issued report is amended; a draft is edited directly.',
          );
        const open = await trx
          .selectFrom('cg.official_report')
          .select('id')
          .where('amends', '=', r.id)
          .where('state', '<>', 'withdrawn')
          .executeTakeFirst();
        if (open)
          throw new ApiError(
            409,
            'amendment_open',
            'An amendment of this report is already open.',
            {
              details: { id: open.id },
            },
          );
        let depth = 1;
        for (let up = r.amends; up; depth++) up = (await load(trx, up)).amends;
        const facts = await factsFor(trx, r);
        const a = await trx
          .insertInto('cg.official_report')
          .values({
            tenant_id: r.tenant_id,
            event_id: r.event_id,
            client_uuid: request.body.clientUuid,
            kind: r.kind,
            sequence: r.sequence,
            title: `${KIND_TITLE[r.kind as (typeof KINDS)[number]] ?? r.kind} ${r.sequence}, amendment ${depth}`,
            period_from: r.period_from,
            period_to: r.period_to,
            time_zone: r.time_zone,
            cutoff: r.cutoff,
            classification: r.classification,
            author_id: s.accountId,
            amends: r.id,
            facts_at: new Date(),
            definitions: JSON.stringify(facts.map((f) => f.definition)),
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        // The judgments carry over as written; the summary is drafted again from the corrected facts.
        const judgments = await trx
          .selectFrom('cg.official_report_section')
          .select(['key', 'content', 'edited_by', 'edited_at'])
          .where('report_id', '=', r.id)
          .where('kind', '=', 'judgment')
          .execute();
        await insertSections(
          trx,
          a,
          facts,
          s.accountId,
          new Map(
            judgments.map((j) => [
              j.key,
              {
                text: String((j.content as { text?: unknown } | null)?.text ?? ''),
                editedBy: j.edited_by,
                editedAt: j.edited_at ? new Date(j.edited_at) : null,
              },
            ]),
          ),
        );
        await request.audit(trx, {
          action: 'official_report.draft',
          targetType: 'official_report',
          targetId: a.id,
          targetVersion: a.version,
          changes: { amends: r.id },
        });
        return { id: a.id, created: true };
      });
      const out = await request.tx((trx) => detail(trx, id));
      return reply.code(created ? 201 : 200).send(out);
    },
  );

  // ------------------------------------------------------------------ withdraw
  app.post(
    '/official-reports/:id/withdraw',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['official-reports'],
        params: uuidParam,
        body: z.object({ reason: z.string().trim().min(3).max(500) }),
        response: { 200: detailOut },
      },
    },
    async (request) => {
      const s = account(request);
      const expected = request.expectedVersion();
      await request.authorize(
        'official_report.draft',
        { type: 'official_report', id: request.params.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      await request.tx(async (trx) => {
        const r = await load(trx, request.params.id);
        editable(r);
        const saved = assertUpdated(
          await trx
            .updateTable('cg.official_report')
            .set({ state: 'withdrawn', version: sql`version + 1`, updated_by: s.accountId })
            .where('id', '=', r.id)
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst(),
          { id: r.id, version: r.version },
        );
        await request.audit(trx, {
          action: 'official_report.draft',
          targetType: 'official_report',
          targetId: r.id,
          targetVersion: saved.version,
          changes: { state: { from: r.state, to: 'withdrawn' } },
          reason: request.body.reason,
        });
      });
      return request.tx((trx) => detail(trx, request.params.id));
    },
  );

  // ------------------------------------------------------------------ the issued snapshot
  app.get(
    '/official-reports/:id/snapshot',
    {
      schema: {
        tags: ['official-reports'],
        params: uuidParam,
        response: {
          200: z.object({
            id: z.uuid(),
            reportId: z.uuid(),
            content: z.unknown(),
            recordVersions: z.unknown(),
            contentHash: z.string(),
            hashMatches: z.boolean(),
            issuedAt: z.iso.datetime(),
            reason: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize(
        'official_report.read',
        { type: 'official_report', id: request.params.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      const snap = await request.tx((trx) =>
        trx
          .selectFrom('cg.official_report_snapshot')
          .selectAll()
          .where('report_id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!snap) throw errors.notFound();
      return {
        id: snap.id,
        reportId: snap.report_id,
        content: snap.content,
        recordVersions: snap.record_versions,
        contentHash: snap.content_hash,
        // Recomputed on every read: the stored content still hashes to what was issued.
        hashMatches: contentHash(snap.content) === snap.content_hash,
        issuedAt: iso(snap.issued_at)!,
        reason: snap.reason,
      };
    },
  );

  // ------------------------------------------------------------------ what changed (CON-06)
  app.get(
    '/events/:id/changes',
    {
      schema: {
        tags: ['official-reports'],
        params: uuidParam,
        querystring: z.object({ since: z.uuid().optional() }),
        response: { 200: changesOut },
      },
    },
    async (request) => {
      const s = account(request);
      await request.authorize('official_report.read', {
        type: 'official_report',
        tenantId: s.tenantId,
        eventId: request.params.id,
      });
      return request.tx(async (trx) => {
        let base = trx
          .selectFrom('cg.official_report as r')
          .innerJoin('cg.official_report_snapshot as s', 's.report_id', 'r.id')
          .select(['r.id', 'r.title', 'r.cutoff', 's.issued_at', 's.content'])
          .where('r.event_id', '=', request.params.id)
          .where('r.state', 'in', ['issued', 'superseded']);
        base = request.query.since
          ? base.where('r.id', '=', request.query.since)
          : base.orderBy('s.issued_at', 'desc').limit(1);
        const last = await base.executeTakeFirst();
        if (request.query.since && !last) throw errors.notFound();
        const now = new Date();
        if (!last) return { since: null, asOf: now.toISOString(), changes: [] };
        const before: Fact[] = (
          (
            last.content as {
              sections?: { kind: string; key: string; title: string; content: unknown }[];
            }
          ).sections ?? []
        )
          .filter((x) => x.kind === 'fact')
          .map((x) => ({
            key: x.key as Fact['key'],
            title: x.title,
            rows: (x.content as { rows?: Fact['rows'] } | null)?.rows ?? [],
            note: null,
            definition: { key: x.key, version: 0, text: '' },
            records: [],
          }));
        const after = await computeFacts(trx, {
          eventId: request.params.id,
          periodFrom: new Date(last.cutoff),
          periodTo: now,
          cutoff: now,
        });
        // "Received in this period" means a different period now; it is not a change.
        const changes = compareFacts(before, after).filter(
          (c) => !(c.fact === 'reports' && c.key === 'inPeriod'),
        );
        return {
          since: {
            reportId: last.id,
            title: last.title,
            issuedAt: iso(last.issued_at)!,
            cutoff: iso(last.cutoff)!,
          },
          asOf: now.toISOString(),
          changes,
        };
      });
    },
  );
};

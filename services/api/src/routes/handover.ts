/**
 * Shift hand-over (layer-7 task H; FL-12, AI-04, AIG-01, AIG-05). At check-out
 * a worker gets a draft of what their shift did and what is still open, made
 * only from their own shift: the ICS 214 activity log entries they made while
 * checked in, the assignments on them or their team that are not cleared,
 * and the follow-ups in conversation notes they confirmed during the shift
 * (a count, never the notes). The rules write the draft; where the register
 * allows, the AI assistant rewrites it from the same facts, every sentence
 * citing them, names, phone numbers, emails and street addresses removed
 * before it sees them and put back after. The worker edits and confirms it;
 * the next shift on the same team reads it.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';
import { redact, type DraftFact } from '@cg/ai';
import { decide } from '@cg/authz';
import type { CheckInTable, Database, ShiftHandoverTable } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import { aiDraft, type DraftingDeps } from './drafting.ts';
import { iso, listQuery, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type CheckInRow = Selectable<CheckInTable>;
type HandoverRow = Selectable<ShiftHandoverTable>;

const OPEN_STATES = ['assigned', 'dispatched', 'acknowledged', 'en_route', 'on_scene'] as const;
/** Kinds of the activity log that count as work done (check-in and check-out are the frame). */
const KIND_LABEL = {
  en: {
    assessment: 'Damage assessments recorded',
    service: 'Service entries logged',
    hazard: 'Hazards reported',
    note: 'Notes logged',
    message: 'Messages logged',
    alert: 'Alerts raised',
    cleared: 'Assignments cleared',
    on_scene: 'Arrivals on scene',
    status: 'Status updates',
  },
  es: {
    assessment: 'Evaluaciones de daños registradas',
    service: 'Servicios registrados',
    hazard: 'Peligros reportados',
    note: 'Notas registradas',
    message: 'Mensajes registrados',
    alert: 'Alertas enviadas',
    cleared: 'Asignaciones terminadas',
    on_scene: 'Llegadas al lugar',
    status: 'Cambios de estado',
  },
} as const;
type Lang = keyof typeof KIND_LABEL;
const RECENT = 8;

const handoverOut = z.object({
  ...stamped,
  checkInId: z.uuid(),
  personnelId: z.uuid(),
  personnelName: z.string().nullable(),
  teamId: z.uuid().nullable(),
  language: z.enum(['en', 'es']),
  text: z.string(),
  sources: z.array(z.string()),
  aiDrafted: z.boolean(),
});
const factOut = z.object({
  id: z.string(),
  label: z.string(),
  value: z.union([z.string(), z.number(), z.null()]),
});

export interface HandoverFacts {
  facts: DraftFact[];
  rules: string;
}

/**
 * The facts and the rules' draft for one shift. Pure: the caller reads the
 * rows. Every fact is something the worker's own records say.
 */
export function handoverFacts(
  lang: Lang,
  shift: { startedAt: Date; endedAt: Date },
  entries: { id: string; kind: string; summary: string; occurredAt: Date }[],
  open: { reference: string; kind: string; state: string }[],
  followUps: number,
): HandoverFacts {
  const facts: DraftFact[] = [];
  const time = (d: Date) => d.toISOString().slice(11, 16);
  facts.push({
    id: 'shift',
    label: lang === 'en' ? 'Shift (UTC)' : 'Turno (UTC)',
    value: `${time(shift.startedAt)}–${time(shift.endedAt)}`,
  });
  const work = entries.filter((e) => e.kind in KIND_LABEL[lang]);
  const counts = new Map<string, number>();
  for (const e of work) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  for (const [kind, n] of counts)
    facts.push({
      id: `count.${kind}`,
      label: KIND_LABEL[lang][kind as keyof (typeof KIND_LABEL)['en']],
      value: n,
    });
  open.forEach((a, i) =>
    facts.push({
      id: `open.${i + 1}`,
      label: lang === 'en' ? 'Assignment still open' : 'Asignación todavía abierta',
      value: `${a.reference} (${a.kind.replace(/_/g, ' ')}): ${a.state.replace(/_/g, ' ')}`,
    }),
  );
  if (followUps)
    facts.push({
      id: 'followUps',
      label:
        lang === 'en'
          ? 'Follow-ups in the conversation notes saved this shift'
          : 'Seguimientos en las notas de conversación guardadas en este turno',
      value: followUps,
    });
  const recent = work.slice(-RECENT);
  recent.forEach((e, i) =>
    facts.push({
      id: `entry.${i + 1}`,
      label: `${lang === 'en' ? 'Logged at' : 'Registrado a las'} ${time(e.occurredAt)} UTC`,
      value: e.summary,
    }),
  );

  const done = [...counts].map(
    ([kind, n]) => `${KIND_LABEL[lang][kind as keyof (typeof KIND_LABEL)['en']]}: ${n}`,
  );
  const shiftFact = facts[0]!.value as string;
  const lines =
    lang === 'en'
      ? [
          `Shift ${shiftFact} UTC.`,
          done.length ? `Done: ${done.join('; ')}.` : 'Nothing was logged this shift.',
          open.length
            ? `Still open: ${open.map((a) => `${a.reference} (${a.kind.replace(/_/g, ' ')}), ${a.state.replace(/_/g, ' ')}`).join('; ')}.`
            : 'No assignment is left open.',
          followUps ? `Follow-ups in the conversation notes saved this shift: ${followUps}.` : null,
          recent.length
            ? `Last entries: ${recent.map((e) => `${time(e.occurredAt)} ${e.summary}`).join('; ')}.`
            : null,
        ]
      : [
          `Turno ${shiftFact} UTC.`,
          done.length ? `Hecho: ${done.join('; ')}.` : 'No se registró nada en este turno.',
          open.length
            ? `Todavía abierto: ${open.map((a) => `${a.reference} (${a.kind.replace(/_/g, ' ')}), ${a.state.replace(/_/g, ' ')}`).join('; ')}.`
            : 'No queda ninguna asignación abierta.',
          followUps
            ? `Seguimientos en las notas de conversación guardadas en este turno: ${followUps}.`
            : null,
          recent.length
            ? `Últimos registros: ${recent.map((e) => `${time(e.occurredAt)} ${e.summary}`).join('; ')}.`
            : null,
        ];
  return { facts, rules: lines.filter(Boolean).join(' ') };
}

export const handoverRoutesWith =
  (deps: DraftingDeps = {}): FastifyPluginAsync =>
  async (base) => {
    const app = base.withTypeProvider<ZodTypeProvider>();

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    /** The check-in, and whether it is the caller's own (FL-12: one's own shift). */
    const loadShift = async (request: FastifyRequest, id: string) => {
      const s = account(request);
      const ci = await request.tx((trx) =>
        trx.selectFrom('cg.check_in').selectAll().where('id', '=', id).executeTakeFirst(),
      );
      if (!ci) throw errors.notFound();
      const person = await request.tx((trx) =>
        trx
          .selectFrom('cg.personnel')
          .select(['id', 'account_id'])
          .where('id', '=', ci.personnel_id)
          .executeTakeFirst(),
      );
      const mine = person?.account_id === s.accountId;
      await request.authorize(
        mine ? 'check_in.end' : 'check_in.manage',
        { type: 'check_in', id: ci.id, tenantId: s.tenantId },
        { asNotFound: true },
      );
      return { ci, mine, accountId: person?.account_id ?? null };
    };

    const gather = async (
      trx: Trx,
      ci: CheckInRow,
      accountId: string | null,
      lang: Lang,
    ): Promise<HandoverFacts> => {
      const until = ci.ended_at ?? new Date();
      const entries = await trx
        .selectFrom('cg.activity_entry')
        .select(['id', 'kind', 'summary', 'occurred_at'])
        .where('personnel_id', '=', ci.personnel_id)
        .where('event_id', '=', ci.event_id)
        .where('occurred_at', '>=', ci.started_at)
        .where('occurred_at', '<=', until)
        .orderBy('occurred_at')
        .limit(500)
        .execute();
      const open = await trx
        .selectFrom('cg.assignment as a')
        .innerJoin('cg.mission as m', 'm.id', 'a.mission_id')
        .select(['m.reference', 'm.kind', 'a.state'])
        .where('m.event_id', '=', ci.event_id)
        .where('a.state', 'in', [...OPEN_STATES])
        .where((eb) =>
          ci.team_id
            ? eb.or([eb('a.personnel_id', '=', ci.personnel_id), eb('a.team_id', '=', ci.team_id)])
            : eb('a.personnel_id', '=', ci.personnel_id),
        )
        .orderBy('m.reference')
        .limit(20)
        .execute();
      let followUps = 0;
      if (accountId && base.hasDecorator('fieldCrypto')) {
        const notes = await trx
          .selectFrom('cg.scribe_session')
          .select(['tenant_id', 'note_enc'])
          .where('account_id', '=', accountId)
          .where('state', '=', 'confirmed')
          .where('context', '<>', 'legal_aid')
          .where('confirmed_at', '>=', ci.started_at)
          .where('confirmed_at', '<=', until)
          .execute();
        for (const n of notes)
          if (n.note_enc) {
            const note = JSON.parse(await base.fieldCrypto.decrypt(n.tenant_id, n.note_enc)) as {
              followUps?: string[];
            };
            followUps += note.followUps?.length ?? 0;
          }
      }
      return handoverFacts(
        lang,
        { startedAt: new Date(ci.started_at), endedAt: new Date(until) },
        entries.map((e) => ({
          id: e.id,
          kind: e.kind,
          summary: e.summary,
          occurredAt: new Date(e.occurred_at),
        })),
        open,
        followUps,
      );
    };

    const toOut = (r: HandoverRow, personnelName: string | null) => ({
      id: r.id,
      version: r.version,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      checkInId: r.check_in_id,
      personnelId: r.personnel_id,
      personnelName,
      teamId: r.team_id,
      language: r.language,
      text: r.text,
      sources: r.sources,
      aiDrafted: r.ai_output_id !== null,
    });

    // ---------------------------------------------------------- the rules' draft
    app.get(
      '/check-ins/:id/handover',
      {
        schema: {
          tags: ['roster'],
          params: uuidParam,
          querystring: z.object({ language: z.enum(['en', 'es']).default('en') }),
          response: {
            200: z.object({
              rules: z.string(),
              facts: z.array(factOut),
              saved: handoverOut.nullable(),
            }),
          },
        },
      },
      async (request) => {
        const { ci, accountId } = await loadShift(request, request.params.id);
        return request.tx(async (trx) => {
          const g = await gather(trx, ci, accountId, request.query.language);
          const saved = await trx
            .selectFrom('cg.shift_handover')
            .selectAll()
            .where('check_in_id', '=', ci.id)
            .executeTakeFirst();
          return { rules: g.rules, facts: g.facts, saved: saved ? toOut(saved, null) : null };
        });
      },
    );

    // ---------------------------------------------------------- the AI draft
    app.post(
      '/check-ins/:id/handover/ai-draft',
      {
        schema: {
          tags: ['roster'],
          params: uuidParam,
          body: z.object({ language: z.enum(['en', 'es']).default('en') }),
          response: {
            200: z.object({
              text: z.string(),
              sentences: z.array(z.object({ text: z.string(), factIds: z.array(z.string()) })),
              provider: z.string(),
              model: z.string(),
              outputId: z.uuid(),
            }),
          },
        },
      },
      async (request) => {
        const { ci, mine, accountId } = await loadShift(request, request.params.id);
        if (!mine) throw errors.forbidden();
        const g = await request.tx((trx) => gather(trx, ci, accountId, request.body.language));
        // AIG-05: names, phone numbers, emails and street addresses never reach the model.
        // One pass over every value and the rules' draft, so each detail has one token.
        const SEP = '\u241e';
        const strings = g.facts.filter((f) => typeof f.value === 'string');
        const joint = redact([...strings.map((f) => f.value as string), g.rules].join(SEP));
        // The same detail said twice (in a fact and in the rules' draft) keeps one token.
        const first = new Map<string, string>();
        let jointText = joint.text;
        for (const [token, value] of Object.entries(joint.tokens)) {
          const kept = first.get(value);
          if (kept) jointText = jointText.split(token).join(kept);
          else first.set(value, token);
        }
        const parts = jointText.split(SEP);
        if (parts.length !== strings.length + 1)
          throw new ApiError(500, 'redaction_failed', 'The draft could not be prepared.');
        const redacted = new Map(strings.map((f, i) => [f.id, parts[i]!]));
        const facts = g.facts.map((f) =>
          redacted.has(f.id) ? { ...f, value: redacted.get(f.id)! } : f,
        );
        const restore = (t: string) =>
          Object.entries(joint.tokens).reduce(
            (out, [token, value]) => out.split(token).join(value),
            t,
          );
        const draft = await aiDraft(
          request,
          deps,
          'field.handover',
          {
            purpose: 'handover',
            language: request.body.language,
            facts,
            template: parts[parts.length - 1]!,
            maxChars: 2000,
          },
          { type: 'check_in', id: ci.id },
        );
        return {
          text: restore(draft.text),
          sentences: draft.sentences.map((x) => ({ ...x, text: restore(x.text) })),
          provider: draft.provider.provider,
          model: draft.provider.model,
          outputId: draft.outputId,
        };
      },
    );

    // ---------------------------------------------------------- confirm
    app.post(
      '/check-ins/:id/handover',
      {
        schema: {
          tags: ['roster'],
          params: uuidParam,
          body: z.object({
            language: z.enum(['en', 'es']).default('en'),
            text: z.string().trim().min(1).max(4000),
            /** The AI draft this text started from, and whether the worker changed it. */
            ai: z.object({ outputId: z.uuid(), changed: z.boolean() }).optional(),
          }),
          response: { 200: handoverOut, 201: handoverOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const { ci, mine, accountId } = await loadShift(request, request.params.id);
        if (!mine) throw errors.forbidden();
        if (ci.ended_at)
          throw new ApiError(
            409,
            'checked_out',
            'This shift has ended; leave the hand-over before checking out.',
          );
        const b = request.body;
        const { row, created } = await request.tx(async (trx) => {
          const g = await gather(trx, ci, accountId, b.language);
          const sources = g.facts.map((f) => f.id);
          const existing = await trx
            .selectFrom('cg.shift_handover')
            .select(['id', 'version'])
            .where('check_in_id', '=', ci.id)
            .executeTakeFirst();
          const values = {
            language: b.language,
            text: b.text,
            sources,
            ai_output_id: b.ai?.outputId ?? null,
          };
          const r = existing
            ? await trx
                .updateTable('cg.shift_handover')
                .set({ ...values, updated_by: s.accountId })
                .where('id', '=', existing.id)
                .returningAll()
                .executeTakeFirstOrThrow()
            : await trx
                .insertInto('cg.shift_handover')
                .values({
                  ...values,
                  tenant_id: ci.tenant_id,
                  event_id: ci.event_id,
                  check_in_id: ci.id,
                  personnel_id: ci.personnel_id,
                  team_id: ci.team_id,
                  created_by: s.accountId,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
          if (b.ai)
            await trx
              .updateTable('cg.ai_output')
              .set({
                human_action: b.ai.changed ? 'edited' : 'accepted',
                acted_by: s.accountId,
                acted_at: new Date(),
              })
              .where('id', '=', b.ai.outputId)
              .where('feature', '=', 'field.handover')
              .where('target_id', '=', ci.id)
              .where('human_action', 'is', null)
              .execute();
          await request.audit(trx, {
            action: 'handover.write',
            targetType: 'shift_handover',
            targetId: r.id,
            changes: {
              fields: [
                { name: 'checkIn', to: ci.id },
                { name: 'aiDrafted', to: Boolean(b.ai) },
              ],
            },
          });
          return { row: r, created: !existing };
        });
        return reply.code(created ? 201 : 200).send(toOut(row, null));
      },
    );

    // ---------------------------------------------------------- the next shift reads
    app.get(
      '/handovers',
      {
        schema: {
          tags: ['roster'],
          querystring: listQuery.extend({
            teamId: z.uuid().optional(),
            eventId: z.uuid().optional(),
            /** The teams the caller is on now, and the caller's own notes. */
            mine: z.coerce.boolean().optional(),
          }),
          response: { 200: z.array(handoverOut) },
        },
      },
      async (request) => {
        const s = account(request);
        const q = request.query;
        const rows = await request.tx(async (trx) => {
          const own = await trx
            .selectFrom('cg.personnel')
            .select('id')
            .where('account_id', '=', s.accountId)
            .executeTakeFirst();
          const teams = own
            ? (
                await trx
                  .selectFrom('cg.team_member')
                  .select('team_id')
                  .where('personnel_id', '=', own.id)
                  .where('left_at', 'is', null)
                  .execute()
              ).map((t) => t.team_id)
            : [];
          // Coordinators read every hand-over; a worker reads their own and their teams'.
          const all =
            decide(s, 'check_in.manage', { type: 'check_in', tenantId: s.tenantId }).effect ===
            'allow';
          if (!all) {
            await request.authorize('check_in.end', { type: 'check_in', tenantId: s.tenantId });
            if (!own) return [];
          }
          let x = trx
            .selectFrom('cg.shift_handover as h')
            .leftJoin('cg.personnel as p', 'p.id', 'h.personnel_id')
            .selectAll('h')
            .select('p.name as personnel_name')
            .orderBy('h.created_at', 'desc')
            .limit(q.limit)
            .offset(q.offset);
          if (q.eventId) x = x.where('h.event_id', '=', q.eventId);
          if (q.teamId) x = x.where('h.team_id', '=', q.teamId);
          if (q.mine || !all)
            x = x.where((eb) =>
              eb.or([
                eb('h.personnel_id', '=', own?.id ?? '00000000-0000-0000-0000-000000000000'),
                ...(teams.length ? [eb('h.team_id', 'in', teams)] : []),
              ]),
            );
          return x.execute();
        });
        return rows.map((r) => toOut(r, r.personnel_name));
      },
    );
  };

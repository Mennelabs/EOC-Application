/**
 * The conversation scribe (layer-7 task H; FL-04, FL-05, FL-18, FL:FR-16,
 * FL:FR-23, FL:FR-26, AIG-01, AIG-02, AIG-05, AIG-09, SEC-13).
 *
 * A worker asks the survivor first, in the survivor's language, with the
 * statement this server gives; the consent and how it was given are kept with
 * the note. The phone records only while its listening sign shows and sends
 * the audio once the conversation (or the survivor's "stop") ends; it is kept
 * encrypted in object storage. Asking for the draft transcribes the audio,
 * removes names, phone numbers, emails and street addresses, and drafts the
 * note (needs heard, help given, follow-ups, referrals), each line with the
 * words it rests on; a line whose words were never said is dropped. The
 * worker confirms or changes every line; on confirmation the audio, the
 * transcript and the draft are deleted and only the note is kept (FL-04).
 *
 * Where it never runs: counseling and spiritual care are refused outright
 * (FL-05, FL:FR-16) and counselors and chaplains have no scribe action;
 * legal aid and anything involving a child are off unless the organization
 * turns them on, and a legal aid note is only ever its author's (FL:FR-23).
 * Each organization has its own switch (FL-18); with the AI features off the
 * worker writes the note by hand, as before.
 */
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import {
  callAi,
  filterGeneratedText,
  recordAiOutput,
  redact,
  type AiProvider,
  type ScribeNote,
} from '@cg/ai';
import type { Database, ScribeSessionTable } from '@cg/db';
import { ApiError, errors } from '../errors.ts';
import type { DraftingDeps } from './drafting.ts';
import { iso, stamped, uuidParam } from './helpers.ts';

type Trx = Transaction<Database>;
type Row = Selectable<ScribeSessionTable>;

export interface ScribeDeps {
  ai?: DraftingDeps['ai'];
  objects?: DraftingDeps['objects'];
}

/** What the worker reads to the survivor, or shows them, before anything is recorded (FL-18). */
export const SCRIBE_CONSENT = {
  en: 'May I use a note-taker on my phone while we talk? It listens only while the listening sign shows, and you can say stop at any time. It drafts a note of what you need and what we agree to do. I check the note, and the recording is deleted as soon as I save it. Saying no does not change the help you get.',
  es: '¿Puedo usar un asistente de notas en mi teléfono mientras hablamos? Solo escucha mientras se ve la señal de que está escuchando, y usted puede decir alto en cualquier momento. Prepara una nota de lo que necesita y de lo que acordamos hacer. Yo reviso la nota, y la grabación se borra en cuanto la guardo. Decir que no, no cambia la ayuda que recibe.',
} as const;

const AUDIO_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
] as const;
/** The transcription service takes files up to 25 MB. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const SECTIONS = ['needsHeard', 'helpGiven', 'followUps', 'referrals'] as const;
type Section = (typeof SECTIONS)[number];

const lineOut = z.object({
  text: z.string(),
  quote: z.string(),
  /** Words the output filter would stop in public text (a promise, advice): worth a second look. */
  check: z.array(z.string()),
});
const draftOut = z.object({
  needsHeard: z.array(lineOut),
  helpGiven: z.array(lineOut),
  followUps: z.array(lineOut),
  referrals: z.array(lineOut),
  /** Lines the model wrote whose words were not in the conversation; never shown. */
  dropped: z.number().int(),
  /** The conversation held words that tried to instruct the assistant: nothing was drafted. */
  injectionSuspected: z.boolean(),
  provider: z.string(),
  model: z.string(),
});
type Draft = z.infer<typeof draftOut>;

const noteIn = z.object({
  needsHeard: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  helpGiven: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  followUps: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  referrals: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
});
type Note = z.infer<typeof noteIn>;

const sessionOut = z.object({
  ...stamped,
  accountId: z.uuid(),
  context: z.enum(['general', 'legal_aid', 'child']),
  language: z.enum(['en', 'es']),
  consentMethod: z.enum(['spoken', 'tapped']),
  consentText: z.string(),
  consentAt: z.iso.datetime(),
  relatedType: z.string().nullable(),
  relatedId: z.uuid().nullable(),
  state: z.enum(['consented', 'recorded', 'drafted', 'confirmed', 'discarded', 'expired']),
  stoppedBy: z.enum(['worker', 'survivor']).nullable(),
  hasAudio: z.boolean(),
  confirmedAt: z.iso.datetime().nullable(),
  edited: z.boolean().nullable(),
  draft: draftOut.nullable(),
  note: noteIn.nullable(),
});

const toOut = (r: Row, content: { draft?: Draft | null; note?: Note | null } = {}) => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  accountId: r.account_id,
  context: r.context,
  language: r.language,
  consentMethod: r.consent_method,
  consentText: r.consent_text,
  consentAt: iso(r.consent_at)!,
  relatedType: r.related_type,
  relatedId: r.related_id,
  state: r.state,
  stoppedBy: r.stopped_by,
  hasAudio: r.audio_object_key !== null,
  confirmedAt: iso(r.confirmed_at),
  edited: r.edited,
  draft: content.draft ?? null,
  note: content.note ?? null,
});

/** Lowercase letters and digits only, so a quote matches whatever the spacing and punctuation. */
const plain = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}[\]_]+/gu, ' ')
    .trim();

/**
 * AI-09, FL-04: keeps the lines whose words were said (the quote is in the
 * redacted conversation), puts the redacted details back for the worker, and
 * marks lines the public-text filter would stop so the worker looks twice.
 */
export function groundNote(
  note: ScribeNote,
  transcript: string,
  tokens: Record<string, string>,
): Omit<Draft, 'provider' | 'model'> {
  const heard = plain(transcript);
  const restore = (s: string) =>
    Object.entries(tokens).reduce((t, [token, value]) => t.split(token).join(value), s);
  let dropped = 0;
  const out = {} as Record<Section, { text: string; quote: string; check: string[] }[]>;
  for (const k of SECTIONS) {
    out[k] = [];
    for (const line of note[k]) {
      const q = plain(line.quote);
      if (!line.text.trim() || q.length < 3 || !heard.includes(q)) {
        dropped += 1;
        continue;
      }
      const text = restore(line.text.trim());
      out[k].push({
        text,
        quote: restore(line.quote.trim()),
        check: filterGeneratedText(text).reasons.filter((r) => r !== 'contact_data'),
      });
    }
  }
  return { ...out, dropped, injectionSuspected: note.injectionSuspected };
}

export const scribeRoutesWith =
  (deps: ScribeDeps = {}): FastifyPluginAsync =>
  async (base) => {
    const app = base.withTypeProvider<ZodTypeProvider>();

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };
    const crypto = () => {
      if (!base.hasDecorator('fieldCrypto'))
        throw new ApiError(503, 'crypto_unavailable', 'Encryption is not available.');
      return base.fieldCrypto;
    };

    const configFlag = async (trx: Trx, key: string, fallback: boolean) => {
      const row = await trx
        .selectFrom('cg.tenant_config')
        .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
        .select('value')
        .where('key', '=', key)
        .executeTakeFirst();
      return typeof row?.value === 'boolean' ? row.value : fallback;
    };

    /** FL-05, FL-18: the organization's switch and the contexts it allows. */
    const assertAllowed = async (trx: Trx, context: Row['context']) => {
      if (!(await configFlag(trx, 'scribe.enabled', true)))
        throw new ApiError(
          409,
          'scribe_off',
          'Your organization has the scribe turned off. Write the note yourself.',
        );
      if (context === 'legal_aid' && !(await configFlag(trx, 'scribe.legal_aid', false)))
        throw new ApiError(
          409,
          'scribe_off',
          'The scribe is off for legal aid conversations here (FL-05). Write the note yourself.',
        );
      if (context === 'child' && !(await configFlag(trx, 'scribe.children', false)))
        throw new ApiError(
          409,
          'scribe_off',
          'The scribe is off for conversations involving a child here (FL-05). Write the note yourself.',
        );
    };

    /** Both AI features on and the provider able to do both, or null (AI-10). */
    const provider = async (trx: Trx, tenantId: string): Promise<AiProvider | null> => {
      const rows = await trx
        .selectFrom('cg.ai_use_register')
        .select(['feature', 'enabled', 'provider'])
        .where('tenant_id', '=', tenantId)
        .where('feature', 'in', ['scribe.transcription', 'scribe.note'])
        .execute();
      if (rows.length !== 2 || rows.some((r) => !r.enabled)) return null;
      const p = await deps.ai?.providerFor(tenantId, trx);
      if (!p?.stt || !p.llm?.scribeNote) return null;
      return rows.every((r) => r.provider === p.info.provider) ? p : null;
    };
    const aiOff = () =>
      new ApiError(
        409,
        'ai_off',
        'The scribe is off here. Nothing was recorded; write the note yourself.',
      );

    const load = async (request: FastifyRequest, id: string): Promise<Row> => {
      const row = await request.tx((trx) =>
        trx.selectFrom('cg.scribe_session').selectAll().where('id', '=', id).executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      return row;
    };
    /** Only the worker who recorded it handles a conversation before its note is confirmed. */
    const loadOwn = async (request: FastifyRequest, id: string): Promise<Row> => {
      const s = account(request);
      await request.authorize('scribe.use', { type: 'scribe_session', tenantId: s.tenantId });
      const row = await load(request, id);
      if (row.account_id !== s.accountId) throw errors.notFound();
      return row;
    };

    const decryptJson = async <T>(tenantId: string, blob: Buffer | null): Promise<T | null> =>
      blob ? (JSON.parse(await crypto().decrypt(tenantId, blob)) as T) : null;

    /** Removes the audio object and clears everything kept only until the note is confirmed. */
    const dropAudio = async (row: Row) => {
      if (row.audio_object_key && deps.objects)
        await deps.objects.client.send(
          new DeleteObjectCommand({ Bucket: deps.objects.bucket, Key: row.audio_object_key }),
        );
    };
    const logAudioDeletion = async (trx: Trx, row: Row) => {
      if (!row.audio_object_key) return;
      await trx
        .insertInto('cg.deletion_log')
        .values({
          tenant_id: row.tenant_id,
          data_category: 'scribe_audio',
          target_type: 'scribe_session',
          deleted_count: 1,
          oldest: row.created_at,
          newest: row.created_at,
          execution_id: randomUUID(),
        })
        .execute();
    };

    // ------------------------------------------------------------ consent statement
    app.get(
      '/scribe/consent',
      {
        schema: {
          tags: ['scribe'],
          querystring: z.object({ language: z.enum(['en', 'es']).default('en') }),
          response: { 200: z.object({ language: z.string(), text: z.string() }) },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('scribe.use', { type: 'scribe_session', tenantId: s.tenantId });
        return { language: request.query.language, text: SCRIBE_CONSENT[request.query.language] };
      },
    );

    // ------------------------------------------------------------ start, with consent
    app.post(
      '/scribe/sessions',
      {
        schema: {
          tags: ['scribe'],
          body: z.object({
            clientUuid: z.uuid(),
            // Counseling and spiritual care are named so the refusal can say why (FL-05).
            context: z.enum(['general', 'legal_aid', 'child', 'counseling', 'spiritual_care']),
            language: z.enum(['en', 'es']),
            consent: z.object({ method: z.enum(['spoken', 'tapped']), given: z.literal(true) }),
            relatedType: z.string().min(1).max(40).optional(),
            relatedId: z.uuid().optional(),
          }),
          response: { 201: sessionOut, 200: sessionOut },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const b = request.body;
        await request.authorize('scribe.use', { type: 'scribe_session', tenantId: s.tenantId });
        if (b.context === 'counseling' || b.context === 'spiritual_care')
          throw errors.validation([
            {
              name: 'context',
              message:
                'the scribe is never used for counseling or spiritual care (FL-05, FL:FR-16)',
            },
          ]);
        const context = b.context;
        const { row, created } = await request.tx(async (trx) => {
          const existing = await trx
            .selectFrom('cg.scribe_session')
            .selectAll()
            .where('client_uuid', '=', b.clientUuid)
            .executeTakeFirst();
          if (existing) {
            if (existing.account_id !== s.accountId) throw errors.idempotencyMismatch();
            return { row: existing, created: false };
          }
          await assertAllowed(trx, context);
          if (!(await provider(trx, s.tenantId))) throw aiOff();
          const r = await trx
            .insertInto('cg.scribe_session')
            .values({
              tenant_id: s.tenantId,
              client_uuid: b.clientUuid,
              account_id: s.accountId,
              context,
              language: b.language,
              consent_method: b.consent.method,
              consent_text: SCRIBE_CONSENT[b.language],
              consent_at: new Date(),
              related_type: b.relatedType ?? null,
              related_id: b.relatedId ?? null,
              created_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'scribe.start',
            targetType: 'scribe_session',
            targetId: r.id,
            changes: {
              fields: [
                { name: 'context', to: context },
                { name: 'language', to: b.language },
                { name: 'consent', to: b.consent.method },
              ],
            },
          });
          return { row: r, created: true };
        });
        return reply.code(created ? 201 : 200).send(toOut(row));
      },
    );

    // ------------------------------------------------------------ the recording
    app.addContentTypeParser(
      [...AUDIO_TYPES],
      { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES + 1024 },
      (_req, body, done) => done(null, body),
    );
    app.put(
      '/scribe/sessions/:id/audio',
      {
        schema: {
          tags: ['scribe'],
          params: uuidParam,
          querystring: z.object({ stoppedBy: z.enum(['worker', 'survivor']).default('worker') }),
          response: { 200: sessionOut },
        },
      },
      async (request) => {
        const row = await loadOwn(request, request.params.id);
        const body = request.body as Buffer | undefined;
        const type = String(request.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim();
        if (
          !Buffer.isBuffer(body) ||
          !body.length ||
          !(AUDIO_TYPES as readonly string[]).includes(type)
        )
          throw errors.validation([{ name: 'audio', message: 'send the recording as audio' }]);
        if (row.state === 'recorded' && row.audio_object_key) return toOut(row);
        if (row.state !== 'consented')
          throw new ApiError(409, 'wrong_state', 'This conversation already has its recording.');
        if (!deps.objects)
          throw new ApiError(503, 'storage_unavailable', 'File storage is not available.', {
            retryable: true,
          });
        const key = `scribe-audio/${row.tenant_id}/${row.id}.enc`;
        const sealed = await crypto().encrypt(row.tenant_id, body.toString('base64'));
        await deps.objects.client.send(
          new PutObjectCommand({
            Bucket: deps.objects.bucket,
            Key: key,
            Body: sealed,
            ContentType: 'application/octet-stream',
          }),
        );
        const updated = await request.tx(async (trx) => {
          const r = await trx
            .updateTable('cg.scribe_session')
            .set({
              state: 'recorded',
              audio_object_key: key,
              audio_mime: type,
              audio_bytes: body.length,
              stopped_by: request.query.stoppedBy,
            })
            .where('id', '=', row.id)
            .where('state', '=', 'consented')
            .returningAll()
            .executeTakeFirst();
          if (!r) throw errors.conflict(toOut(row));
          await request.audit(trx, {
            action: 'scribe.record',
            targetType: 'scribe_session',
            targetId: row.id,
            changes: {
              fields: [
                { name: 'bytes', to: body.length },
                { name: 'stoppedBy', to: request.query.stoppedBy },
              ],
            },
          });
          return r;
        });
        return toOut(updated);
      },
    );

    // ------------------------------------------------------------ the draft
    app.post(
      '/scribe/sessions/:id/draft',
      { schema: { tags: ['scribe'], params: uuidParam, response: { 200: sessionOut } } },
      async (request) => {
        const s = account(request);
        const row = await loadOwn(request, request.params.id);
        if (row.state === 'drafted')
          return toOut(row, { draft: await decryptJson<Draft>(row.tenant_id, row.draft_enc) });
        if (row.state !== 'recorded' || !row.audio_object_key)
          throw new ApiError(409, 'wrong_state', 'Record the conversation first.');
        const p = await request.tx(async (trx) => {
          await assertAllowed(trx, row.context);
          return provider(trx, s.tenantId);
        });
        if (!p) throw aiOff();
        if (!deps.objects)
          throw new ApiError(503, 'storage_unavailable', 'File storage is not available.', {
            retryable: true,
          });
        const obj = await deps.objects.client.send(
          new GetObjectCommand({ Bucket: deps.objects.bucket, Key: row.audio_object_key }),
        );
        const sealed = await obj.Body?.transformToByteArray();
        if (!sealed)
          throw new ApiError(503, 'storage_unavailable', 'The recording could not be read.');
        const audio = Buffer.from(
          await crypto().decrypt(row.tenant_id, Buffer.from(sealed)),
          'base64',
        );
        const record = (
          feature: string,
          out: { provider: { provider: string; model: string }; latencyMs: number } | null,
          outcome: Parameters<typeof recordAiOutput>[1]['outcome'],
          latencyMs: number,
        ) =>
          request.tx((trx) =>
            recordAiOutput(trx, {
              tenantId: s.tenantId,
              feature,
              provider: out?.provider ?? p.info,
              outcome,
              latencyMs,
              language: row.language,
              targetType: 'scribe_session',
              targetId: row.id,
            }),
          );
        const unavailable = () =>
          new ApiError(
            503,
            'ai_unavailable',
            'The scribe could not draft the note just now. Try again, or write the note yourself.',
            { retryable: true },
          );
        // Speech to text, outside any transaction (AI-10).
        const heard = await callAi(() => p.stt!.transcribe(audio, row.audio_mime!, row.language));
        await record(
          'scribe.transcription',
          heard.ok ? heard.out : null,
          heard.ok ? 'ok' : heard.outcome,
          heard.ok ? heard.out.latencyMs : heard.latencyMs,
        );
        if (!heard.ok) throw unavailable();
        // AIG-05: names, phone numbers, emails and street addresses never reach the model.
        const redacted = redact(heard.out.output.text);
        const drafted = await callAi(() =>
          p.llm!.scribeNote!({ transcript: redacted.text, language: row.language }),
        );
        if (!drafted.ok) {
          await record('scribe.note', null, drafted.outcome, drafted.latencyMs);
          throw unavailable();
        }
        const grounded = groundNote(drafted.out.output, redacted.text, redacted.tokens);
        const draft: Draft = grounded.injectionSuspected
          ? {
              needsHeard: [],
              helpGiven: [],
              followUps: [],
              referrals: [],
              dropped: 0,
              injectionSuspected: true,
              provider: drafted.out.provider.provider,
              model: drafted.out.provider.model,
            }
          : {
              ...grounded,
              provider: drafted.out.provider.provider,
              model: drafted.out.provider.model,
            };
        const outputId = await record(
          'scribe.note',
          drafted.out,
          grounded.injectionSuspected ? 'filtered' : 'ok',
          drafted.out.latencyMs,
        );
        const transcriptEnc = await crypto().encrypt(row.tenant_id, redacted.text);
        const draftEnc = await crypto().encrypt(row.tenant_id, JSON.stringify(draft));
        const updated = await request.tx(async (trx) => {
          const r = await trx
            .updateTable('cg.scribe_session')
            .set({
              state: 'drafted',
              transcript_enc: transcriptEnc,
              draft_enc: draftEnc,
              draft_output_id: outputId,
            })
            .where('id', '=', row.id)
            .where('state', '=', 'recorded')
            .returningAll()
            .executeTakeFirst();
          if (!r) throw errors.conflict(toOut(row));
          await request.audit(trx, {
            action: 'scribe.draft',
            targetType: 'scribe_session',
            targetId: row.id,
            changes: {
              fields: [
                {
                  name: 'lines',
                  to: SECTIONS.reduce((n, k) => n + draft[k].length, 0),
                },
                { name: 'dropped', to: draft.dropped },
                { name: 'injectionSuspected', to: draft.injectionSuspected },
              ],
            },
          });
          return r;
        });
        return toOut(updated, { draft });
      },
    );

    // ------------------------------------------------------------ confirm: only the note is kept
    app.post(
      '/scribe/sessions/:id/confirm',
      {
        schema: {
          tags: ['scribe'],
          params: uuidParam,
          body: z.object({ version: z.number().int().positive(), note: noteIn }),
          response: { 200: sessionOut },
        },
      },
      async (request) => {
        const s = account(request);
        const row = await loadOwn(request, request.params.id);
        if (!['consented', 'recorded', 'drafted'].includes(row.state))
          throw new ApiError(409, 'wrong_state', 'This conversation is already closed.');
        if (row.version !== request.body.version) throw errors.conflict(toOut(row));
        const note = request.body.note;
        if (!SECTIONS.some((k) => note[k].length))
          throw errors.validation([{ name: 'note', message: 'write at least one line' }]);
        const draft = await decryptJson<Draft>(row.tenant_id, row.draft_enc);
        const drafted = draft
          ? Object.fromEntries(SECTIONS.map((k) => [k, draft[k].map((l) => l.text)]))
          : null;
        const edited = drafted
          ? SECTIONS.some((k) => JSON.stringify(drafted[k]) !== JSON.stringify(note[k]))
          : null;
        const noteEnc = await crypto().encrypt(row.tenant_id, JSON.stringify(note));
        // FL-04: the recording goes first; the row then says it is gone.
        await dropAudio(row);
        const updated = await request.tx(async (trx) => {
          const r = await trx
            .updateTable('cg.scribe_session')
            .set({
              state: 'confirmed',
              note_enc: noteEnc,
              edited,
              confirmed_at: new Date(),
              audio_object_key: null,
              audio_mime: null,
              audio_bytes: null,
              transcript_enc: null,
              draft_enc: null,
            })
            .where('id', '=', row.id)
            .where('version', '=', row.version)
            .returningAll()
            .executeTakeFirst();
          if (!r) throw errors.conflict(toOut(row));
          if (row.draft_output_id)
            await trx
              .updateTable('cg.ai_output')
              .set({
                human_action: edited ? 'edited' : 'accepted',
                acted_by: s.accountId,
                acted_at: new Date(),
              })
              .where('id', '=', row.draft_output_id)
              .where('human_action', 'is', null)
              .execute();
          await logAudioDeletion(trx, row);
          await request.audit(trx, {
            action: 'scribe.confirm',
            targetType: 'scribe_session',
            targetId: row.id,
            changes: {
              fields: [
                { name: 'edited', to: edited },
                { name: 'audioDeleted', to: row.audio_object_key !== null },
              ],
            },
          });
          return r;
        });
        return toOut(updated, { note });
      },
    );

    // ------------------------------------------------------------ discard: nothing is kept
    app.post(
      '/scribe/sessions/:id/discard',
      { schema: { tags: ['scribe'], params: uuidParam, response: { 200: sessionOut } } },
      async (request) => {
        const s = account(request);
        const row = await loadOwn(request, request.params.id);
        if (row.state === 'discarded') return toOut(row);
        if (!['consented', 'recorded', 'drafted'].includes(row.state))
          throw new ApiError(409, 'wrong_state', 'This conversation is already closed.');
        await dropAudio(row);
        const updated = await request.tx(async (trx) => {
          const r = await trx
            .updateTable('cg.scribe_session')
            .set({
              state: 'discarded',
              audio_object_key: null,
              audio_mime: null,
              audio_bytes: null,
              transcript_enc: null,
              draft_enc: null,
            })
            .where('id', '=', row.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          if (row.draft_output_id)
            await trx
              .updateTable('cg.ai_output')
              .set({ human_action: 'rejected', acted_by: s.accountId, acted_at: new Date() })
              .where('id', '=', row.draft_output_id)
              .where('human_action', 'is', null)
              .execute();
          await logAudioDeletion(trx, row);
          await request.audit(trx, {
            action: 'scribe.discard',
            targetType: 'scribe_session',
            targetId: row.id,
          });
          return r;
        });
        return toOut(updated);
      },
    );

    // ------------------------------------------------------------ reading
    app.get(
      '/scribe/sessions',
      { schema: { tags: ['scribe'], response: { 200: z.array(sessionOut) } } },
      async (request) => {
        const s = account(request);
        await request.authorize('scribe.use', { type: 'scribe_session', tenantId: s.tenantId });
        const rows = await request.tx((trx) =>
          trx
            .selectFrom('cg.scribe_session')
            .selectAll()
            .where('account_id', '=', s.accountId)
            .orderBy('created_at', 'desc')
            .limit(50)
            .execute(),
        );
        return rows.map((r) => toOut(r));
      },
    );

    app.get(
      '/scribe/sessions/:id',
      { schema: { tags: ['scribe'], params: uuidParam, response: { 200: sessionOut } } },
      async (request) => {
        const s = account(request);
        const row = await load(request, request.params.id);
        const own = row.account_id === s.accountId;
        if (own)
          await request.authorize('scribe.use', { type: 'scribe_session', tenantId: s.tenantId });
        else {
          // FL:FR-23: a legal aid note is only ever its author's; others read confirmed notes only.
          if (row.context === 'legal_aid' || row.state !== 'confirmed') throw errors.notFound();
          await request.authorize(
            'scribe.read',
            { type: 'scribe_session', id: row.id, tenantId: s.tenantId },
            { asNotFound: true },
          );
        }
        const content = {
          draft: own ? await decryptJson<Draft>(row.tenant_id, row.draft_enc) : null,
          note: await decryptJson<Note>(row.tenant_id, row.note_enc),
        };
        if (content.draft || content.note)
          await request.tx((trx) =>
            request.audit(trx, {
              action: 'scribe.read',
              targetType: 'scribe_session',
              targetId: row.id,
            }),
          );
        return toOut(row, content);
      },
    );
  };

export const scribeRoutes = scribeRoutesWith();

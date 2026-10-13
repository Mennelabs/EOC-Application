/**
 * Text and voice sessions on the question graph (CHN-01, CHN-03, CHN-04,
 * CHN-05, INT-05/06, SEC-10, SEC-17, docs/06). State lives in
 * cg.intake_session with the answers encrypted; each inbound text or call
 * step loads it, applies the reply through the shared dialogue, saves it and
 * answers. A finished session goes through the same submission path as the
 * web, so one record exists whatever the channel. Keywords always work;
 * the first reply confirms the program (carrier rules); nothing here reads
 * like an emergency alert.
 */
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Transaction } from 'kysely';
import type { FieldCrypto } from '@cg/crypto';
import { normalisePhone } from '@cg/crypto';
import { normaliseCode, type Database } from '@cg/db';
import {
  command,
  hazardsForEvent,
  nextNode,
  normaliseKeyword,
  parseReply,
  remainingQuestions,
  renderNode,
  strings,
  type Answers,
  type DialogueOptions,
  type QuestionGraph,
  type SessionContext,
} from '@cg/intake';
import { ApiError } from '../errors.ts';
import { WindowCounter } from '../public/abuse.ts';
import {
  configValue,
  loadGraph,
  type SubmitInput,
  type SubmitRequest,
  type SubmitResult,
} from '../public/submit.ts';
import { enqueueOutbox } from '../routes/helpers.ts';
import { isAllowedImage, type MediaFetcher } from './media.ts';
import { element, gather, say, sayCode } from './twilio.ts';

export interface ChannelTenant {
  id: string;
  name: string;
  slug: string;
  locales: string[];
}

export interface InboundText {
  from: string;
  body: string;
  media: { url: string; contentType: string }[];
  provider: 'twilio' | 'simulator';
}

export interface VoiceStep {
  from: string;
  step: 'start' | 'language' | 'answer' | 'repeat';
  digits?: string | undefined;
  speech?: string | undefined;
  /** The voice webhook path; Gather actions append ?step=. */
  actionBase: string;
}

export interface SessionDeps {
  crypto: FieldCrypto;
  defaultGraph: QuestionGraph;
  submit(req: SubmitRequest, input: SubmitInput): Promise<SubmitResult>;
  objects?: { client: S3Client; bucket: string; maxBytes: number } | undefined;
  media?: MediaFetcher | undefined;
  /** Public web base for the find-help link, when known. */
  publicBase?: string | undefined;
  now?: () => Date;
}

type Channel = 'sms' | 'voice';
type Strings = ReturnType<typeof strings>;

interface State {
  answers: Answers;
  history: string[];
  ownWords?: string;
  needs: string[];
  consent: Record<string, boolean>;
  photoIds: string[];
}

interface Session {
  id: string;
  executionId: string;
  eventId: string;
  language: string;
  graphKey: string;
  graphVersion: number;
  state: State;
}

interface EventRow {
  id: string;
  name: string;
  hazard_type: string;
}

interface Turn {
  texts: string[];
  /** The resident asked to send: done outside the transaction. */
  send?: { session: Session; smsOptIn: boolean; channel: Channel };
  expects?: 'digits' | 'speech_or_digits' | 'none';
  maxDigits?: number;
}

type VoiceTurn = { twiml: string } | { send: NonNullable<Turn['send']>; locale: string };

const DONE: Answers[string] = { kind: 'value', value: 'done' };
const SEEN: Answers[string] = { kind: 'value', value: 'seen' };

/** Floods from one number: after this many texts in ten minutes the reply is a short notice, then silence. */
const FLOOD_NOTICE = 60;
const FLOOD_SILENCE = 70;

export class ChannelSessions {
  private readonly deps: SessionDeps;
  private readonly floods = new WindowCounter(10 * 60_000);

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** The request as the submission path sees it: no client address (it would be the carrier's). */
  private sessionRequest(req: SubmitRequest): SubmitRequest {
    return { tx: (fn) => req.tx(fn), audit: (trx, input) => req.audit(trx, input), log: req.log };
  }

  // ------------------------------------------------------------------ text

  async handleText(
    req: SubmitRequest,
    tenant: ChannelTenant,
    inbound: InboundText,
  ): Promise<string[]> {
    const phone = normalisePhone(inbound.from);
    const hits = this.floods.hit(`sms:${phone}`);
    if (hits > FLOOD_SILENCE) return [];
    if (hits > FLOOD_NOTICE) return [strings(tenant.locales[0] ?? 'en').tooMany];

    const turn = await req.tx(async (trx): Promise<Turn> => {
      const bidx = await this.deps.crypto.blindIndex(tenant.id, 'phone', phone);
      const helpPhone = (await configValue<string>(trx, 'intake.help_phone')) ?? null;
      let session = await this.loadActive(trx, tenant.id, 'sms', bidx);
      const locale = session?.language ?? tenant.locales[0] ?? 'en';
      const S = strings(locale);
      const cmd = command(inbound.body);

      if (cmd.kind === 'stop') {
        if (session) await this.setState(req, trx, tenant.id, session, 'stopped', true);
        return { texts: [S.stop(tenant.name)] };
      }
      if (cmd.kind === 'help' || cmd.kind === 'agent')
        return { texts: [S.help(tenant.name, helpPhone)] };
      if (cmd.kind === 'shelter') {
        const url = this.deps.publicBase ? `${this.deps.publicBase}/${tenant.slug}/help` : null;
        return { texts: [strings(cmd.locale).shelter(tenant.name, helpPhone, url)] };
      }
      if (cmd.kind === 'noshare')
        return { texts: [await this.withdrawSharing(req, trx, tenant, bidx, cmd.code, S)] };

      if (cmd.kind === 'start' || !session) {
        const lang = cmd.kind === 'start' ? cmd.locale : locale;
        const event = await this.findEvent(trx, cmd.kind === 'start' ? inbound.body : null);
        if (!event) return { texts: [strings(lang).noEvent(tenant.name)] };
        const Sx = strings(lang);
        let resumed = false;
        if (session && session.eventId === event.id) {
          session.language = lang;
          resumed = true;
        } else {
          if (session) await this.setState(req, trx, tenant.id, session, 'stopped', false);
          session = await this.create(req, trx, tenant, 'sms', phone, bidx, event, lang);
        }
        const graph = await this.graphOf(trx, session);
        const opts = await this.dialogueOpts(trx, graph, 'sms');
        const prompt = await this.advance(trx, tenant.id, session, graph, event, 'sms', opts, []);
        const intro = resumed ? Sx.welcomeBack : Sx.welcome(tenant.name, event.name);
        const main = [intro, ...prompt.texts].join('\n\n');
        return { texts: resumed ? [main] : [Sx.optInConfirmation(tenant.name), main] };
      }

      const graph = await this.graphOf(trx, session);
      const event = await this.eventOf(trx, session);
      const opts = await this.dialogueOpts(trx, graph, 'sms');
      const prefix: string[] = [];
      if (inbound.media.length > 0) {
        const n = await this.attachPhotos(trx, tenant, session, inbound.media);
        if (n > 0) prefix.push(S.gotPhotos(n));
      }
      const applied = await this.applyInput(
        req,
        trx,
        tenant,
        session,
        graph,
        event,
        'sms',
        opts,
        inbound.body,
        cmd.kind,
        inbound.media.length > 0,
      );
      return { ...applied, texts: [...prefix, ...applied.texts] };
    });

    if (!turn.send) return turn.texts;
    return this.sendAndConfirm(
      this.sessionRequest(req),
      tenant,
      turn.send,
      (S, code) => [S.confirmation(tenant.name, code)],
      (S) => [S.retryLater],
    );
  }

  // ----------------------------------------------------------------- voice

  /** Returns the TwiML body (inside <Response>) for one step of a call. */
  async handleVoice(req: SubmitRequest, tenant: ChannelTenant, call: VoiceStep): Promise<string> {
    const phone = normalisePhone(call.from);
    const action = (step: string) => `${call.actionBase}?step=${step}`;
    const greeting = () => {
      const en = strings('en');
      return gather(
        { action: action('language'), locale: 'en', input: 'dtmf', numDigits: 1 },
        say(en.greeting(tenant.name), 'en') + say(en.chooseLanguage, 'en'),
      );
    };
    const prompt = (
      texts: string[],
      locale: string,
      expects: Turn['expects'],
      maxDigits: number,
    ): string => {
      const S = strings(locale);
      const spoken = texts.map((t) => say(t, locale)).join('');
      if (expects === 'none')
        return spoken + element('Redirect', { method: 'POST' }, action('repeat'));
      const multi = maxDigits !== 1;
      return gather(
        {
          action: action('answer'),
          locale,
          input: expects === 'digits' ? 'dtmf' : 'dtmf speech',
          ...(multi ? {} : { numDigits: 1 }),
        },
        spoken + (multi && maxDigits > 1 ? say(S.thenPound, locale) : ''),
      );
    };

    const turn = await req.tx(async (trx): Promise<VoiceTurn> => {
      const bidx = await this.deps.crypto.blindIndex(tenant.id, 'phone', phone);
      const helpPhone = (await configValue<string>(trx, 'intake.help_phone')) ?? null;
      let session = await this.loadActive(trx, tenant.id, 'voice', bidx);
      if (call.step === 'start') return { twiml: greeting() };
      if (call.step === 'language') {
        const lang = call.digits === '2' ? 'es' : call.digits === '1' ? 'en' : null;
        if (!lang) return { twiml: greeting() };
        const S = strings(lang);
        const event = await this.findEvent(trx, null);
        if (!event) return { twiml: say(S.noEvent(tenant.name), lang) + element('Hangup') };
        let resumed = false;
        if (session && session.eventId === event.id) {
          session.language = lang;
          resumed = true;
        } else {
          if (session) await this.setState(req, trx, tenant.id, session, 'stopped', false);
          session = await this.create(req, trx, tenant, 'voice', phone, bidx, event, lang);
        }
        const graph = await this.graphOf(trx, session);
        const opts = await this.dialogueOpts(trx, graph, 'voice');
        const next = await this.advance(
          trx,
          tenant.id,
          session,
          graph,
          event,
          'voice',
          opts,
          resumed ? [S.welcomeBack] : [],
        );
        return { twiml: prompt(next.texts, lang, next.expects, next.maxDigits ?? 0) };
      }
      if (!session) return { twiml: greeting() };
      const locale = session.language;
      const S = strings(locale);
      const graph = await this.graphOf(trx, session);
      const event = await this.eventOf(trx, session);
      const opts = await this.dialogueOpts(trx, graph, 'voice');
      const input = (call.digits ?? call.speech ?? '').trim();
      if (call.step === 'repeat' || !input) {
        const next = await this.advance(trx, tenant.id, session, graph, event, 'voice', opts, []);
        return { twiml: prompt(next.texts, locale, next.expects, next.maxDigits ?? 0) };
      }
      const cmd = command(input);
      if (call.digits === '0' || cmd.kind === 'agent') {
        const digits = helpPhone ? helpPhone.replace(/[^\d+]/g, '') : '';
        return {
          twiml: digits
            ? say(S.agentTransfer, locale) + element('Dial', {}, digits)
            : say(S.noAgent(helpPhone), locale) + element('Hangup'),
        };
      }
      if (cmd.kind === 'stop') {
        await this.setState(req, trx, tenant.id, session, 'stopped', false);
        return { twiml: say(S.goodbye, locale) + element('Hangup') };
      }
      if (cmd.kind === 'help') {
        const next = await this.advance(trx, tenant.id, session, graph, event, 'voice', opts, []);
        return {
          twiml: prompt(
            [S.help(tenant.name, helpPhone), ...next.texts],
            locale,
            next.expects,
            next.maxDigits ?? 0,
          ),
        };
      }
      const applied = await this.applyInput(
        req,
        trx,
        tenant,
        session,
        graph,
        event,
        'voice',
        opts,
        input,
        cmd.kind,
        false,
      );
      if (applied.send) return { send: applied.send, locale };
      return {
        twiml: prompt(
          applied.texts,
          locale,
          applied.expects ?? 'speech_or_digits',
          applied.maxDigits ?? 0,
        ),
      };
    });

    if ('twiml' in turn) return turn.twiml;
    const CODE = '\u0000code:';
    const texts = await this.sendAndConfirm(
      this.sessionRequest(req),
      tenant,
      turn.send,
      (S, code) => [
        S.voiceCodeIntro,
        `${CODE}${code}`,
        ...(turn.send.smsOptIn ? [S.voiceTextOffer] : []),
        S.goodbye,
      ],
      (S) => [S.retryLater, S.goodbye],
    );
    return (
      texts
        .map((t) =>
          t.startsWith(CODE) ? sayCode(t.slice(CODE.length), turn.locale) : say(t, turn.locale),
        )
        .join('') + element('Hangup')
    );
  }

  // --------------------------------------------------------------- shared

  private async sendAndConfirm(
    req: SubmitRequest,
    tenant: ChannelTenant,
    send: NonNullable<Turn['send']>,
    ok: (S: Strings, code: string) => string[],
    fail: (S: Strings) => string[],
  ): Promise<string[]> {
    const { session, channel } = send;
    const S = strings(session.language);
    const rel = session.state.answers['relationship'];
    const relationship =
      rel && rel.kind === 'value' && typeof rel.value === 'string'
        ? (rel.value as SubmitInput['body']['relationship'])
        : 'own_home';
    try {
      const result = await this.deps.submit(req, {
        tenantId: tenant.id,
        eventId: session.eventId,
        confirmationSent: true,
        body: {
          executionId: session.executionId,
          channel,
          language: session.language,
          graphKey: session.graphKey,
          graphVersion: session.graphVersion,
          relationship,
          answers: session.state.answers,
          ...(session.state.ownWords ? { ownWords: session.state.ownWords } : {}),
          needs: session.state.needs,
          consent: session.state.consent,
          photoIds: session.state.photoIds,
          afterSubmission: {},
          smsOptIn: send.smsOptIn,
          aiAssisted: false,
        },
      });
      await req.tx((trx) => this.setState(req, trx, tenant.id, session, 'submitted', false));
      return ok(S, result.referenceCode);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) return [err.message];
      req.log.error(
        { err, sessionId: session.id },
        'channel submission failed; the session stays open',
      );
      return fail(S);
    }
  }

  private ctxFor(event: EventRow, channel: Channel, state: State): SessionContext {
    const rel = state.answers['relationship'];
    const relationship =
      rel && rel.kind === 'value' && typeof rel.value === 'string'
        ? (rel.value as SessionContext['relationship'])
        : undefined;
    return {
      hazards: hazardsForEvent(event.hazard_type),
      channel,
      ...(relationship ? { relationship } : {}),
    };
  }

  private async dialogueOpts(
    trx: Transaction<Database>,
    graph: QuestionGraph,
    channel: Channel,
  ): Promise<DialogueOptions> {
    const faith = await configValue<boolean>(trx, 'intake.faith_partners');
    return {
      channel,
      consentOrgTypes: graph.consentOrgTypes.filter((o) => !o.optIn || faith === true),
    };
  }

  /** Moves past info nodes and steps the channel cannot take, then renders the next node. */
  private async advance(
    trx: Transaction<Database>,
    tenantId: string,
    session: Session,
    graph: QuestionGraph,
    event: EventRow,
    channel: Channel,
    opts: DialogueOptions,
    texts: string[],
  ): Promise<Turn> {
    const ctx = this.ctxFor(event, channel, session.state);
    const answers = session.state.answers;
    for (;;) {
      const next = nextNode(graph, ctx, answers);
      if (!next) {
        await this.save(trx, tenantId, session, null);
        return { texts, expects: 'none', maxDigits: 0 };
      }
      if (next.kind === 'info') {
        texts.push(renderNode(graph, next, ctx, answers, session.language, opts).text);
        answers[next.id] = SEEN;
        continue;
      }
      if (
        next.kind === 'photos' &&
        (channel === 'voice' || !this.deps.objects || !this.deps.media)
      ) {
        if (channel === 'voice') texts.push(strings(session.language).photosVoice);
        answers[next.id] = { kind: 'skipped' };
        continue;
      }
      const remaining =
        next.kind === 'question' ? remainingQuestions(graph, ctx, answers, next.id) : undefined;
      const r = renderNode(graph, next, ctx, answers, session.language, {
        ...opts,
        ...(remaining !== undefined ? { remaining } : {}),
      });
      texts.push(r.text);
      await this.save(trx, tenantId, session, next.id);
      return { texts, expects: r.expects, maxDigits: r.maxDigits };
    }
  }

  private async applyInput(
    req: SubmitRequest,
    trx: Transaction<Database>,
    tenant: ChannelTenant,
    session: Session,
    graph: QuestionGraph,
    event: EventRow,
    channel: Channel,
    opts: DialogueOptions,
    input: string,
    cmd: ReturnType<typeof command>['kind'],
    hadMedia: boolean,
  ): Promise<Turn> {
    const S = strings(session.language);
    const ctx = this.ctxFor(event, channel, session.state);
    const state = session.state;
    const current = nextNode(graph, ctx, state.answers);
    if (!current) return this.advance(trx, tenant.id, session, graph, event, channel, opts, []);
    const next = () => this.advance(trx, tenant.id, session, graph, event, channel, opts, []);
    const reask = (lead?: string): Turn => {
      const r = renderNode(graph, current, ctx, state.answers, session.language, opts);
      const texts = lead ? (channel === 'sms' ? [`${lead}\n${r.text}`] : [lead, r.text]) : [r.text];
      return { texts, expects: r.expects, maxDigits: r.maxDigits };
    };
    const mark = (id: string, value: Answers[string]) => {
      state.answers[id] = value;
      state.history.push(id);
    };

    if (cmd === 'back') {
      const last = state.history.pop();
      if (!last) return reask(S.nothingToGoBackTo);
      delete state.answers[last];
      if (last === 'own_words') delete state.ownWords;
      if (last === 'needs') state.needs = [];
      if (last === 'consent') state.consent = {};
      return next();
    }
    if (cmd === 'skip') {
      if (current.kind === 'question' && current.required)
        return reask(`${S.requiredHint} ${current.allowUnknown ? S.dontKnow : S.pickOne}`);
      mark(current.id, { kind: 'skipped' });
      return next();
    }
    if (hadMedia && !input.trim()) {
      // A picture on its own attached to the report; the photos step is done if that is where we are.
      if (current.kind === 'photos') {
        mark(current.id, DONE);
        return next();
      }
      return reask();
    }

    const parsed = parseReply(graph, current, input, session.language, opts);
    switch (parsed.kind) {
      case 'invalid':
        return reask(parsed.message);
      case 'answer':
        mark(current.id, parsed.value);
        break;
      case 'needs':
        state.needs = parsed.values;
        mark(current.id, DONE);
        break;
      case 'consent':
        state.consent = parsed.values;
        mark(current.id, DONE);
        break;
      case 'own_words':
        state.ownWords = parsed.text;
        mark(current.id, DONE);
        break;
      case 'ack':
        mark(current.id, DONE);
        break;
      case 'back':
        return this.applyInput(
          req,
          trx,
          tenant,
          session,
          graph,
          event,
          channel,
          opts,
          '',
          'back',
          false,
        );
      case 'send':
        await this.save(trx, tenant.id, session, current.id);
        return { texts: [], send: { session, smsOptIn: parsed.smsOptIn, channel } };
    }
    return next();
  }

  private async attachPhotos(
    trx: Transaction<Database>,
    tenant: ChannelTenant,
    session: Session,
    media: InboundText['media'],
  ): Promise<number> {
    const objects = this.deps.objects;
    const fetcher = this.deps.media;
    if (!objects || !fetcher) return 0;
    let n = 0;
    for (const m of media.slice(0, 5)) {
      if (session.state.photoIds.length >= 30 || !isAllowedImage(m.contentType)) continue;
      let fetched;
      try {
        fetched = await fetcher.fetch(m.url);
      } catch {
        continue;
      }
      if (fetched.body.length > objects.maxBytes) continue;
      const row = await trx
        .insertInto('cg.photo')
        .values({
          tenant_id: tenant.id,
          execution_id: session.executionId,
          shot: 'other',
          source: 'mms',
          object_key_original: '',
          content_type: fetched.contentType,
          bytes: fetched.body.length,
          status: 'uploaded',
          uploaded_at: this.now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const key = `tenants/${tenant.id}/originals/${session.executionId}/${row.id}`;
      await objects.client.send(
        new PutObjectCommand({
          Bucket: objects.bucket,
          Key: key,
          Body: fetched.body,
          ContentType: fetched.contentType,
        }),
      );
      await trx
        .updateTable('cg.photo')
        .set({ object_key_original: key })
        .where('id', '=', row.id)
        .execute();
      await enqueueOutbox(trx, tenant.id, 'photo.process', { photoId: row.id }, null);
      session.state.photoIds.push(row.id);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------- storage

  private async findEvent(
    trx: Transaction<Database>,
    keyword: string | null,
  ): Promise<EventRow | null> {
    const events = await trx
      .selectFrom('cg.event')
      .select(['id', 'name', 'hazard_type', 'intake_keywords', 'opened_at'])
      .where('status', '=', 'active')
      .where('intake_slug', 'is not', null)
      .orderBy('opened_at', 'desc')
      .execute();
    if (events.length === 0) return null;
    if (keyword) {
      const k = normaliseKeyword(keyword);
      const hit = events.find((e) => e.intake_keywords.some((w) => normaliseKeyword(w) === k));
      if (hit) return hit;
    }
    return events[0]!;
  }

  private async eventOf(trx: Transaction<Database>, session: Session): Promise<EventRow> {
    return trx
      .selectFrom('cg.event')
      .select(['id', 'name', 'hazard_type'])
      .where('id', '=', session.eventId)
      .executeTakeFirstOrThrow();
  }

  private graphOf(trx: Transaction<Database>, session: Session): Promise<QuestionGraph> {
    return loadGraph(trx, session.graphKey, session.graphVersion, this.deps.defaultGraph);
  }

  private async loadActive(
    trx: Transaction<Database>,
    tenantId: string,
    channel: Channel,
    bidx: Buffer,
  ): Promise<Session | null> {
    const row = await trx
      .selectFrom('cg.intake_session')
      .select([
        'id',
        'execution_id',
        'event_id',
        'language',
        'graph_key',
        'graph_version',
        'answers_enc',
      ])
      .where('channel', '=', channel)
      .where('phone_bidx', '=', bidx)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (!row || !row.event_id) return null;
    const state: State = row.answers_enc
      ? (JSON.parse(await this.deps.crypto.decrypt(tenantId, row.answers_enc)) as State)
      : { answers: {}, history: [], needs: [], consent: {}, photoIds: [] };
    return {
      id: row.id,
      executionId: row.execution_id,
      eventId: row.event_id,
      language: row.language,
      graphKey: row.graph_key,
      graphVersion: row.graph_version,
      state,
    };
  }

  private async create(
    req: SubmitRequest,
    trx: Transaction<Database>,
    tenant: ChannelTenant,
    channel: Channel,
    phone: string,
    bidx: Buffer,
    event: EventRow,
    language: string,
  ): Promise<Session> {
    const graph = await loadGraph(
      trx,
      this.deps.defaultGraph.key,
      undefined,
      this.deps.defaultGraph,
    );
    const state: State = {
      // The channel knows the number: the contact question is answered, not asked (CHN-03).
      answers: {
        contact: {
          kind: 'value',
          value: { phone, preferred: channel === 'sms' ? 'text' : 'call' },
        },
      },
      history: [],
      needs: [],
      consent: {},
      photoIds: [],
    };
    const row = await trx
      .insertInto('cg.intake_session')
      .values({
        tenant_id: tenant.id,
        channel,
        phone_bidx: bidx,
        phone_enc: await this.deps.crypto.encrypt(tenant.id, phone),
        event_id: event.id,
        language,
        graph_key: graph.key,
        graph_version: graph.version,
        answers_enc: await this.deps.crypto.encrypt(tenant.id, JSON.stringify(state)),
        execution_id: randomUUID(),
        last_inbound_at: this.now(),
      })
      .returning(['id', 'execution_id'])
      .executeTakeFirstOrThrow();
    await req.audit(trx, {
      action: 'channel.session_started',
      targetType: 'intake_session',
      targetId: row.id,
      executionId: row.execution_id,
      changes: {
        fields: [
          { name: 'channel', to: channel },
          { name: 'language', to: language },
          { name: 'event', to: event.id },
        ],
      },
    });
    return {
      id: row.id,
      executionId: row.execution_id,
      eventId: event.id,
      language,
      graphKey: graph.key,
      graphVersion: graph.version,
      state,
    };
  }

  private async save(
    trx: Transaction<Database>,
    tenantId: string,
    session: Session,
    cursor: string | null,
  ): Promise<void> {
    await trx
      .updateTable('cg.intake_session')
      .set({
        cursor,
        language: session.language,
        answers_enc: await this.deps.crypto.encrypt(tenantId, JSON.stringify(session.state)),
        last_inbound_at: this.now(),
      })
      .where('id', '=', session.id)
      .execute();
  }

  private async setState(
    req: SubmitRequest,
    trx: Transaction<Database>,
    tenantId: string,
    session: Session,
    state: 'stopped' | 'submitted' | 'paused',
    optOut: boolean,
  ): Promise<void> {
    await trx
      .updateTable('cg.intake_session')
      .set({ state, ...(optOut ? { opt_out: true } : {}), last_inbound_at: this.now() })
      .where('id', '=', session.id)
      .execute();
    if (optOut) {
      // STOP applies to every record of that number, whatever report it belongs to (CHN-04).
      const phone = await this.phoneOf(trx, session);
      const bidx = await this.deps.crypto.blindIndex(tenantId, 'phone', phone);
      await trx
        .updateTable('cg.party')
        .set({ sms_opt_in: false })
        .where('phone_bidx', '=', bidx)
        .execute();
    }
    await req.audit(trx, {
      action: `channel.${state}`,
      targetType: 'intake_session',
      targetId: session.id,
      executionId: session.executionId,
      ...(optOut ? { reason: 'STOP keyword' } : {}),
    });
  }

  /**
   * NOSHARE <code> (NED-05): the sender's number must be the reporter's on that
   * report; then every sharing consent on it is withdrawn and the worker revokes
   * the grants and recalls the record from the partners. A wrong code or another
   * phone gets the same answer, so the keyword reveals nothing about other reports.
   */
  private async withdrawSharing(
    req: SubmitRequest,
    trx: Transaction<Database>,
    tenant: ChannelTenant,
    bidx: Buffer,
    rawCode: string | null,
    S: Strings,
  ): Promise<string> {
    const code = rawCode ? normaliseCode(rawCode) : null;
    if (!code) return S.noshareUnknown(tenant.name);
    const report = await trx
      .selectFrom('cg.report')
      .innerJoin('cg.party', 'cg.party.id', 'cg.report.reporter_party_id')
      .select(['cg.report.id as id', 'cg.report.execution_id as execution_id'])
      .where('cg.report.reference_code', '=', code)
      .where('cg.party.phone_bidx', '=', bidx)
      .where('cg.report.withdrawn_at', 'is', null)
      .executeTakeFirst();
    if (!report) return S.noshareUnknown(tenant.name);
    const changed = await trx
      .updateTable('cg.consent')
      .set({ granted: false, withdrawn_at: this.now(), channel: 'sms' })
      .where('report_id', '=', report.id)
      .where('granted', '=', true)
      .returning('org_type')
      .execute();
    await req.audit(trx, {
      action: 'report.self_update',
      targetType: 'consent',
      targetId: report.id,
      executionId: report.execution_id,
      reason: 'NOSHARE keyword',
      changes: { fields: changed.map((c) => ({ name: c.org_type, from: true, to: false })) },
    });
    await enqueueOutbox(
      trx,
      tenant.id,
      'consent.changed',
      { reportId: report.id, orgType: '*', granted: false },
      report.execution_id,
    );
    return S.noshare(tenant.name, code);
  }

  private async phoneOf(trx: Transaction<Database>, session: Session): Promise<string> {
    const row = await trx
      .selectFrom('cg.intake_session')
      .select(['tenant_id', 'phone_enc'])
      .where('id', '=', session.id)
      .executeTakeFirstOrThrow();
    return this.deps.crypto.decrypt(row.tenant_id, row.phone_enc);
  }
}

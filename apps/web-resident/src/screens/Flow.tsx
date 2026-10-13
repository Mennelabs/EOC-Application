/**
 * The report, one node at a time (plan screens 2–9, 13, 14; INT-02–08,
 * INT-11–16, INT-20/21, PHO-01–06, NED-01–03, CHN-06/07, AC-11B): the graph
 * decides the order, the engine the branches; this screen renders the node
 * being asked, keeps the answers on the device encrypted, and hands the
 * finished report to the outbox. Kiosk mode is the same flow entered by a
 * helper, cleared from the device when done.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  renderAnswer,
  summary,
  text,
  validateAnswer,
  type AnswerValue,
  type QuestionGraph,
  type QuestionNode,
  type Relationship,
  type StepNode,
} from '@cg/intake';
import { useT, type Shell } from '../App.tsx';
import {
  ApiFailure,
  Offline,
  completeUpload,
  extract,
  putObject,
  putObjectViaApi,
  requestUpload,
  saveDraft,
  type ExtractionCandidate,
  type IntakeInfo,
} from '../api/public.ts';
import { preparePhoto } from '../intake/photos.ts';
import { dictationAvailable, startDictation, type Dictation } from '../intake/speech.ts';
import {
  advance,
  answer as setAnswer,
  contextOf,
  currentNode,
  engineAnswers,
  goBack,
  jumpTo,
  markStep,
  newFlow,
  remaining,
  toSubmission,
  type FlowState,
  type PhotoRecord,
} from '../intake/state.ts';
import { ButtonRow, Card, ChoiceGroup, Field, Progress, Status } from '../ui/primitives.tsx';
import { Icon } from '../ui/icons.tsx';
import { Submit } from './Submit.tsx';
import { fallbackIntake, useIntake } from './useIntake.ts';

const FLOW_KEY = 'flow';

interface Candidates {
  extractionId: string;
  items: ExtractionCandidate[];
  notice: string;
}

export function Flow({
  shell,
  tenant,
  event,
  kiosk,
}: {
  shell: Shell;
  tenant: string;
  event: string;
  kiosk: boolean;
}) {
  const t = useT();
  const intake = useIntake(tenant, event, shell.locale);
  const info: IntakeInfo | null =
    intake.data ?? (intake.error ? fallbackIntake(tenant, event) : null);
  const [state, setState] = useState<FlowState | null>(null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [paused, setPaused] = useState<{ code: string; expiresAt: string } | null>(null);
  const [afterMode, setAfterMode] = useState(false);

  // Restore an unfinished report on this device, or start one (AC-11B: one execution id per report).
  useEffect(() => {
    if (!info || state) return;
    let alive = true;
    void (async () => {
      const saved = await shell.store.get<FlowState>(FLOW_KEY);
      if (!alive) return;
      const channel = kiosk ? 'assisted' : 'web';
      if (saved && saved.tenant === tenant && saved.event === event && saved.channel === channel) {
        setState(saved);
        return;
      }
      let relationship: Relationship | undefined = kiosk ? 'helper' : undefined;
      try {
        const raw = sessionStorage.getItem('cg.start');
        if (raw) {
          const start = JSON.parse(raw) as { rel: Relationship; at: number };
          if (Date.now() - start.at < 10 * 60_000) relationship = start.rel;
          sessionStorage.removeItem('cg.start');
        }
      } catch {
        // no session storage: the flow asks
      }
      setState(
        newFlow({
          tenant,
          event,
          language: shell.locale,
          channel,
          graph: info.graph,
          hazards: info.event.hazards,
          ...(relationship ? { relationship } : {}),
        }),
      );
    })();
    return () => {
      alive = false;
    };
  }, [info, state, shell.store, shell.locale, tenant, event, kiosk]);

  // Keep the device copy current (encrypted; cleared on finish or by the resident).
  useEffect(() => {
    if (state) void shell.store.set(FLOW_KEY, state);
  }, [state, shell.store]);

  const update = useCallback((fn: (s: FlowState) => FlowState) => {
    setState((s) => (s ? fn(s) : s));
  }, []);

  const graph = info?.graph;
  const node = useMemo(() => (graph && state ? currentNode(graph, state) : null), [graph, state]);

  useEffect(() => {
    document.getElementById('main')?.focus();
  }, [node?.id]);

  if (!info || !state || !graph) {
    return (
      <main id="main" tabIndex={-1}>
        <p role="status">{intake.loading ? t('loading') : t('error.load')}</p>
      </main>
    );
  }

  const county = info.tenant.name || shell.config.countyName || t('county.fallback');
  const locale = shell.locale;

  const finishNode = (id: string) => update((s) => advance(s, id));
  const back = () => update((s) => goBack(s));
  const pause = async () => {
    try {
      const r = await saveDraft(tenant, state.executionId, state);
      setPaused({ code: r.resumeCode, expiresAt: r.expiresAt });
      shell.store.remove(FLOW_KEY);
    } catch {
      setPaused({ code: '', expiresAt: '' });
    }
  };

  if (paused) {
    return (
      <main id="main" tabIndex={-1}>
        <h1>{t('pause.heading')}</h1>
        {paused.code ? (
          <>
            <p>{t('pause.body', { days: 7 })}</p>
            <p className="reference" aria-label={paused.code.split('').join(' ')}>
              {paused.code}
            </p>
            <p>{t('pause.sharedDevice')}</p>
          </>
        ) : (
          <Status kind="warn">{t('pause.failed')}</Status>
        )}
        <ButtonRow>
          <button type="button" onClick={() => shell.navigate(`/${tenant}/${event}`)}>
            {t('back')}
          </button>
        </ButtonRow>
      </main>
    );
  }

  if (afterMode || !node) {
    return (
      <Submit
        shell={shell}
        info={info}
        state={state}
        kiosk={kiosk}
        afterMode={afterMode}
        setAfterMode={setAfterMode}
        update={update}
        onDone={() => {
          shell.store.remove(FLOW_KEY);
          setState(null);
          shell.navigate(`/${tenant}/${event}`);
        }}
      />
    );
  }

  const chrome = (
    <>
      {kiosk ? (
        <p className="kiosk" role="status">
          {t('kiosk.banner')}
        </p>
      ) : null}
      <ButtonRow>
        {state.history.length > 0 ? (
          <button type="button" className="quiet" onClick={back}>
            {t('back')}
          </button>
        ) : null}
        {!kiosk ? (
          <button type="button" className="link" onClick={() => void pause()}>
            {t('pause.button')}
          </button>
        ) : null}
      </ButtonRow>
    </>
  );

  const progressText = (id: string) => {
    const n = remaining(graph, state, id);
    return n === 0 ? t('progress.last') : n === 1 ? t('progress.one') : t('progress.about', { n });
  };

  switch (node.kind) {
    case 'question':
      return (
        <main id="main" tabIndex={-1}>
          {chrome}
          <QuestionScreen
            key={node.id}
            node={node}
            graph={graph}
            state={state}
            info={info}
            county={county}
            locale={locale}
            progress={progressText(node.id)}
            candidate={candidates?.items.find((c) => c.questionId === node.id) ?? null}
            onAnswer={(value) => {
              update((s) => setAnswer(s, node.id, value));
              finishNode(node.id);
            }}
            onSmsOptIn={(v) => update((s) => ({ ...s, smsOptIn: v }))}
            onOwnWords={() => update((s) => jumpTo(s, 'own_words', node.id))}
            canOwnWords={graph.nodes.some((n) => n.id === 'own_words') && !state.steps['own_words']}
          />
        </main>
      );
    case 'info':
      return (
        <main id="main" tabIndex={-1}>
          {chrome}
          <Card tone="safety">
            <h1>{text(node.title, locale)}</h1>
            <p>
              {node.tenantKey && info.graph.emergencyInstructions
                ? text(info.graph.emergencyInstructions, locale)
                : text(node.body, locale)}
            </p>
            <p>
              <a href="tel:911">{t('safety.body')}</a>
            </p>
          </Card>
          <ButtonRow>
            <button
              type="button"
              className="primary"
              onClick={() => {
                update((s) => ({
                  ...s,
                  answers: { ...s.answers, [node.id]: { kind: 'value', value: 'seen' } },
                }));
                finishNode(node.id);
              }}
            >
              {t('danger.continue')}
            </button>
          </ButtonRow>
        </main>
      );
    case 'free_text':
      return (
        <main id="main" tabIndex={-1}>
          {chrome}
          <OwnWords
            node={node}
            graph={graph}
            state={state}
            locale={locale}
            online={shell.online}
            candidates={candidates}
            setCandidates={setCandidates}
            update={update}
            onDone={() => {
              update((s) => markStep(s, node.id, 'done'));
              finishNode(node.id);
            }}
            onSkip={() => {
              update((s) => markStep(s, node.id, 'skipped'));
              finishNode(node.id);
            }}
          />
        </main>
      );
    case 'photos':
      return (
        <main id="main" tabIndex={-1}>
          {chrome}
          <Photos
            node={node}
            graph={graph}
            state={state}
            info={info}
            locale={locale}
            update={update}
            onDone={() => {
              update((s) => markStep(s, node.id, 'done'));
              finishNode(node.id);
            }}
            onSkip={() => {
              update((s) => markStep(s, node.id, 'skipped'));
              finishNode(node.id);
            }}
          />
        </main>
      );
    case 'needs':
      return (
        <main id="main" tabIndex={-1}>
          {chrome}
          <h1>{text(node.title, locale)}</h1>
          {node.body ? <p>{text(node.body, locale)}</p> : null}
          <ChoiceGroup
            legend={text(node.title, locale)}
            hint={t('needs.hint')}
            multiple
            choices={graph.needCategories.map((c) => ({
              value: c.value,
              label: text(c.label, locale),
              picture: c.icon,
            }))}
            value={state.needs}
            onChange={(needs) => update((s) => ({ ...s, needs }))}
          />
          <ButtonRow>
            <button
              type="button"
              className="primary"
              onClick={() => {
                update((s) => markStep(s, node.id, 'done'));
                finishNode(node.id);
              }}
            >
              {t('continue')}
            </button>
          </ButtonRow>
        </main>
      );
    case 'consent': {
      const types = graph.consentOrgTypes;
      return (
        <main id="main" tabIndex={-1}>
          {chrome}
          <h1>{text(node.title, locale)}</h1>
          {node.body ? <p>{text(node.body, locale)}</p> : null}
          <p>{t('consent.always')}</p>
          {types.map((o) => (
            <ChoiceGroup
              key={o.value}
              legend={text(o.label, locale)}
              hint={o.description ? text(o.description, locale) : undefined}
              multiple={false}
              choices={[
                { value: 'yes', label: t('consent.yes') },
                { value: 'no', label: t('consent.no') },
              ]}
              value={[state.consent[o.value] ? 'yes' : 'no']}
              onChange={([v]) =>
                update((s) => ({ ...s, consent: { ...s.consent, [o.value]: v === 'yes' } }))
              }
            />
          ))}
          <p className="hint">{t('consent.note')}</p>
          <ButtonRow>
            <button
              type="button"
              className="primary"
              onClick={() => {
                update((s) => {
                  const consent = { ...s.consent };
                  for (const o of types) consent[o.value] = consent[o.value] ?? false;
                  return markStep({ ...s, consent }, node.id, 'done');
                });
                finishNode(node.id);
              }}
            >
              {t('continue')}
            </button>
          </ButtonRow>
        </main>
      );
    }
    case 'review':
      return (
        <main id="main" tabIndex={-1}>
          {chrome}
          <Review
            graph={graph}
            state={state}
            locale={locale}
            onChange={(id) => update((s) => jumpTo(s, id, node.id))}
            onSend={() => {
              void shell.outbox.add(tenant, event, toSubmission(state, graph));
              update((s) => markStep(s, node.id, 'done'));
              finishNode(node.id);
            }}
          />
        </main>
      );
  }
}

// ------------------------------------------------------------------ question

function QuestionScreen({
  node,
  graph,
  state,
  info,
  county,
  locale,
  progress,
  candidate,
  onAnswer,
  onSmsOptIn,
  onOwnWords,
  canOwnWords,
}: {
  node: QuestionNode;
  graph: QuestionGraph;
  state: FlowState;
  info: IntakeInfo;
  county: string;
  locale: string;
  progress: string;
  candidate: ExtractionCandidate | null;
  onAnswer: (value: AnswerValue) => void;
  onSmsOptIn: (v: boolean) => void;
  onOwnWords: () => void;
  canOwnWords: boolean;
}) {
  const t = useT();
  const existing = state.answers[node.id];
  const ctx = contextOf(state);
  const prompt = text(
    (ctx.relationship && node.promptFor?.[ctx.relationship]) ??
      node.promptFor?.own_home ??
      node.prompt,
    locale,
  );
  void graph;
  const [error, setError] = useState<string | null>(null);
  const initial = existing?.kind === 'value' ? existing.value : undefined;
  const [picked, setPicked] = useState<string[]>(() =>
    Array.isArray(initial) ? initial : typeof initial === 'string' ? [initial] : [],
  );
  const [textValue, setTextValue] = useState<string>(() =>
    typeof initial === 'string' ? initial : typeof initial === 'number' ? String(initial) : '',
  );
  const [record, setRecord] = useState<Record<string, string>>(() =>
    initial && typeof initial === 'object' && !Array.isArray(initial) ? { ...initial } : {},
  );

  const commit = (value: AnswerValue) => {
    const errors = validateAnswer(node, value);
    if (errors.length > 0) {
      setError(errors[0]!.message);
      return;
    }
    setError(null);
    onAnswer(value);
  };

  const options = (node.options ?? []).map((o) => ({
    value: o.value,
    label: text(o.label, locale),
    ...(o.hint ? { hint: text(o.hint, locale) } : {}),
    ...(o.picture ? { picture: o.picture } : {}),
  }));

  let control: React.ReactNode;
  switch (node.answerType) {
    case 'single':
    case 'yesno':
    case 'multi': {
      const multiple = node.answerType === 'multi';
      control = (
        <ChoiceGroup
          legend={prompt}
          hint={multiple ? t('choose.all') : t('choose.one')}
          multiple={multiple}
          choices={options}
          value={picked}
          onChange={setPicked}
          error={error ?? undefined}
        />
      );
      break;
    }
    case 'number':
      control = (
        <Field label={prompt} hint={t('number.hint')} error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="number"
              inputMode="numeric"
              min={node.min}
              max={node.max}
              value={textValue}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => setTextValue(e.target.value)}
            />
          )}
        </Field>
      );
      break;
    case 'address':
      control = (
        <fieldset className="address">
          <legend>{prompt}</legend>
          {(['line1', 'unit', 'city', 'postal', 'landmark'] as const).map((k) => (
            <Field
              key={k}
              label={t(`address.${k}`)}
              error={k === 'line1' ? (error ?? undefined) : undefined}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  type="text"
                  autoComplete={
                    k === 'postal' ? 'postal-code' : k === 'city' ? 'address-level2' : 'off'
                  }
                  inputMode={k === 'postal' ? 'numeric' : 'text'}
                  value={record[k] ?? ''}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  onChange={(e) => setRecord((r) => ({ ...r, [k]: e.target.value }))}
                />
              )}
            </Field>
          ))}
          <div className="choices">
            <ul>
              <li>
                <input
                  type="checkbox"
                  id={`${node.id}-nofixed`}
                  checked={record['note'] === 'no_fixed_address'}
                  onChange={(e) =>
                    setRecord((r) => {
                      const next = { ...r };
                      if (e.target.checked) next['note'] = 'no_fixed_address';
                      else delete next['note'];
                      return next;
                    })
                  }
                />
                <label htmlFor={`${node.id}-nofixed`}>{t('address.noFixed')}</label>
              </li>
            </ul>
          </div>
        </fieldset>
      );
      break;
    case 'contact':
      control = (
        <fieldset className="contact">
          <legend>{prompt}</legend>
          <Field label={t('contact.phone')} error={error ?? undefined}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                value={record['phone'] ?? ''}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => setRecord((r) => ({ ...r, phone: e.target.value }))}
              />
            )}
          </Field>
          {record['phone'] ? (
            <div className="choices">
              <ul>
                <li>
                  <input
                    type="checkbox"
                    id={`${node.id}-sms`}
                    checked={state.smsOptIn}
                    onChange={(e) => onSmsOptIn(e.target.checked)}
                  />
                  <label htmlFor={`${node.id}-sms`}>{t('contact.smsOptIn', { county })}</label>
                </li>
              </ul>
              {info.sms.termsUrl || info.sms.privacyUrl ? (
                <p className="hint">
                  {info.sms.termsUrl ? (
                    <a href={info.sms.termsUrl}>{t('contact.smsTerms')}</a>
                  ) : null}{' '}
                  {info.sms.privacyUrl ? (
                    <a href={info.sms.privacyUrl}>{t('contact.smsPrivacy')}</a>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}
          <Field label={t('contact.email')}>
            {({ id }) => (
              <input
                id={id}
                type="email"
                autoComplete="email"
                inputMode="email"
                value={record['email'] ?? ''}
                onChange={(e) => setRecord((r) => ({ ...r, email: e.target.value }))}
              />
            )}
          </Field>
          <ChoiceGroup
            legend={t('contact.preferred')}
            multiple={false}
            choices={[
              { value: 'text', label: t('contact.text') },
              { value: 'call', label: t('contact.call') },
              { value: 'email', label: t('contact.emailWay') },
            ]}
            value={record['preferred'] ? [record['preferred']] : []}
            onChange={([v]) => setRecord((r) => ({ ...r, preferred: v ?? '' }))}
          />
          <p className="hint">{t('contact.need')}</p>
        </fieldset>
      );
      break;
    case 'text':
    default:
      control = (
        <Field label={prompt} error={error ?? undefined}>
          {({ id, describedBy, invalid }) =>
            node.multiline ? (
              <textarea
                id={id}
                value={textValue}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => setTextValue(e.target.value)}
              />
            ) : (
              <input
                id={id}
                type="text"
                value={textValue}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => setTextValue(e.target.value)}
              />
            )
          }
        </Field>
      );
  }

  const submit = () => {
    switch (node.answerType) {
      case 'single':
      case 'yesno':
        if (picked.length === 0) return setError(t('validation.pick'));
        return commit({ kind: 'value', value: picked[0]! });
      case 'multi':
        if (picked.length === 0) return setError(t('validation.pick'));
        return commit({ kind: 'value', value: picked });
      case 'number':
        if (textValue.trim() === '') return setError(t('number.hint'));
        return commit({ kind: 'value', value: Number(textValue) });
      case 'address':
      case 'contact': {
        const clean = Object.fromEntries(
          Object.entries(record).filter(([, v]) => v && v.trim() !== ''),
        );
        if (Object.keys(clean).length === 0) {
          if (node.required) return setError(t('validation.pick'));
          return commit({ kind: 'skipped' });
        }
        return commit({ kind: 'value', value: clean });
      }
      default:
        if (textValue.trim() === '') {
          if (node.required) return setError(t('validation.pick'));
          return commit({ kind: 'skipped' });
        }
        return commit({ kind: 'value', value: textValue.trim() });
    }
  };

  const candidateText = candidate
    ? renderAnswer(node, candidate.value, locale, t('dontKnow'), t('skip')).answer
    : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Progress text={progress} />
      <h1>{prompt}</h1>
      {candidate && candidateText ? (
        <Status kind="info">
          <p>{t('ownWords.candidate', { answer: candidateText })}</p>
          <ButtonRow>
            <button type="button" className="primary" onClick={() => commit(candidate.value)}>
              {t('ownWords.yes')}
            </button>
          </ButtonRow>
        </Status>
      ) : null}
      <details className="why">
        <summary>{t('why.label')}</summary>
        <p>{text(node.why, locale)}</p>
        <p>
          <strong>{t('example.label')}:</strong> {text(node.example, locale)}
        </p>
      </details>
      {control}
      {node.required ? <p className="hint">{t('required.note')}</p> : null}
      <ButtonRow>
        <button type="submit" className="primary">
          {t('continue')}
        </button>
        {node.allowUnknown ? (
          <button type="button" onClick={() => commit({ kind: 'unknown' })}>
            {t('dontKnow')}
          </button>
        ) : null}
        {!node.required ? (
          <button type="button" className="quiet" onClick={() => commit({ kind: 'skipped' })}>
            {t('skip')}
          </button>
        ) : null}
      </ButtonRow>
      {canOwnWords ? (
        <p>
          <button type="button" className="link" onClick={onOwnWords}>
            {t('ownWords.heading')}
          </button>
        </p>
      ) : null}
    </form>
  );
}

// ----------------------------------------------------------------- own words

function OwnWords({
  node,
  graph,
  state,
  locale,
  online,
  candidates,
  setCandidates,
  update,
  onDone,
  onSkip,
}: {
  node: StepNode;
  graph: QuestionGraph;
  state: FlowState;
  locale: string;
  online: boolean;
  candidates: Candidates | null;
  setCandidates: (c: Candidates | null) => void;
  update: (fn: (s: FlowState) => FlowState) => void;
  onDone: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  const [words, setWords] = useState(state.ownWords ?? '');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const dictation = useRef<Dictation | null>(null);

  useEffect(() => () => dictation.current?.stop(), []);

  const toggleDictation = () => {
    if (listening) {
      dictation.current?.stop();
      setListening(false);
      return;
    }
    const base = words;
    const d = startDictation(
      locale,
      (spoken) => setWords(`${base}${base && spoken ? ' ' : ''}${spoken}`),
      () => setListening(false),
    );
    if (d) {
      dictation.current = d;
      setListening(true);
    }
  };

  const ask = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await extract(state.tenant, {
        executionId: state.executionId,
        text: words,
        language: locale,
        graphKey: state.graphKey,
        graphVersion: state.graphVersion,
      });
      const open = new Set(
        graph.nodes
          .filter((n): n is QuestionNode => n.kind === 'question' && !state.answers[n.id])
          .map((n) => n.id),
      );
      const items = r.candidates.filter((c) => open.has(c.questionId));
      setCandidates({ extractionId: r.extractionId, items, notice: r.notice });
      setConfirmed({});
      if (items.length === 0) setNote(t('ownWords.none'));
    } catch (err) {
      setNote(
        err instanceof ApiFailure && err.envelope.code === 'ai_off'
          ? t('ownWords.unavailable')
          : t('ownWords.unavailable'),
      );
      setCandidates(null);
    } finally {
      setBusy(false);
    }
  };

  const questionOf = (id: string) =>
    graph.nodes.find((n): n is QuestionNode => n.kind === 'question' && n.id === id);

  const useConfirmed = () => {
    if (!candidates) return;
    update((s) => {
      let next: FlowState = {
        ...s,
        ownWords: words,
        aiAssisted: true,
        extractionId: candidates.extractionId,
      };
      for (const c of candidates.items) {
        if (!confirmed[c.questionId]) continue;
        const q = questionOf(c.questionId);
        if (!q || validateAnswer(q, c.value).length > 0) continue;
        next = {
          ...setAnswer(next, c.questionId, c.value),
          fromWords: [...next.fromWords, c.questionId],
        };
      }
      return next;
    });
    setCandidates(null);
    onDone();
  };

  return (
    <>
      <h1>{text(node.title, locale)}</h1>
      {node.body ? <p>{text(node.body, locale)}</p> : null}
      <Field label={t('ownWords.label')}>
        {({ id }) => (
          <textarea id={id} value={words} onChange={(e) => setWords(e.target.value)} rows={5} />
        )}
      </Field>
      <ButtonRow>
        {dictationAvailable() ? (
          <button type="button" onClick={toggleDictation} aria-pressed={listening}>
            {listening ? t('ownWords.stop') : t('ownWords.dictate')}
          </button>
        ) : null}
        {!state.aiOff && online ? (
          <button
            type="button"
            onClick={() => void ask()}
            disabled={busy || words.trim().length < 3}
          >
            {busy ? t('ownWords.helping') : t('ownWords.help')}
          </button>
        ) : null}
      </ButtonRow>
      {listening ? <p role="status">{t('ownWords.listening')}</p> : null}
      {note ? <Status kind="info">{note}</Status> : null}
      {state.aiOff ? <p className="hint">{t('ownWords.offNote')}</p> : null}
      {candidates && candidates.items.length > 0 ? (
        <section aria-labelledby="cand-heading">
          <Status kind="info">{candidates.notice}</Status>
          <h2 id="cand-heading" className="visually-hidden">
            {t('ownWords.help')}
          </h2>
          {candidates.items.map((c) => {
            const q = questionOf(c.questionId);
            if (!q) return null;
            const shown = renderAnswer(q, c.value, locale, t('dontKnow'), t('skip')).answer;
            return (
              <ChoiceGroup
                key={c.questionId}
                legend={`${text(q.prompt, locale)} — ${t('ownWords.candidate', { answer: shown })}`}
                hint={c.evidence ? `“${c.evidence}”` : undefined}
                multiple={false}
                choices={[
                  { value: 'yes', label: t('ownWords.yes') },
                  { value: 'no', label: t('ownWords.no') },
                ]}
                value={
                  confirmed[c.questionId] === undefined
                    ? []
                    : [confirmed[c.questionId] ? 'yes' : 'no']
                }
                onChange={([v]) => setConfirmed((m) => ({ ...m, [c.questionId]: v === 'yes' }))}
              />
            );
          })}
          <ButtonRow>
            <button type="button" className="primary" onClick={useConfirmed}>
              {t('continue')}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setCandidates(null);
                update((s) => ({ ...s, aiOff: true }));
              }}
            >
              {t('ownWords.off')}
            </button>
          </ButtonRow>
        </section>
      ) : (
        <ButtonRow>
          <button
            type="button"
            className="primary"
            onClick={() => {
              update((s) => ({ ...s, ownWords: words.trim() || undefined }));
              if (words.trim()) onDone();
              else onSkip();
            }}
          >
            {t('continue')}
          </button>
          <button type="button" className="quiet" onClick={onSkip}>
            {t('skip')}
          </button>
        </ButtonRow>
      )}
    </>
  );
}

// -------------------------------------------------------------------- photos

function Photos({
  node,
  graph,
  state,
  info,
  locale,
  update,
  onDone,
  onSkip,
}: {
  node: StepNode;
  graph: QuestionGraph;
  state: FlowState;
  info: IntakeInfo;
  locale: string;
  update: (fn: (s: FlowState) => FlowState) => void;
  onDone: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  const shots = graph.shots.filter(
    (s) => !s.hazards || s.hazards.some((h) => state.hazards.includes(h)),
  );
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    blob: Blob;
    issue: 'dark' | 'blurry';
    url: string;
  } | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const maxBytes = Math.min(info.uploads.maxBytes ?? 1_500_000, 1_500_000);
  const shot = shots[index] ?? shots[0];

  useEffect(() => () => Object.values(previews).forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const upload = async (
    blob: Blob,
    contentType: string,
    hints: { takenAt?: string; location?: { lat: number; lon: number } },
  ) => {
    if (!shot) return;
    setBusy(t('photos.uploading'));
    setFailed(null);
    try {
      const ticket = await requestUpload(state.tenant, {
        executionId: state.executionId,
        shot: shot.id,
        contentType,
        bytes: blob.size,
        ...(hints.takenAt ? { takenAt: new Date(hints.takenAt).toISOString() } : {}),
        ...(hints.location ? { location: hints.location } : {}),
      });
      const rec: PhotoRecord = {
        photoId: ticket.photoId,
        shot: shot.id,
        status: 'uploading',
        ...(hints.takenAt ? { takenAt: hints.takenAt } : {}),
      };
      update((s) => ({ ...s, photos: [...s.photos, rec] }));
      try {
        await putObject(ticket, blob);
      } catch (err) {
        // The direct route to object storage fails where the API works when the objects
        // host name, its certificate or a strict network is in the way; the same bytes
        // then go through the gateway (SCL-04 fallback, SCL-06).
        if (!(err instanceof Offline)) throw err;
        await putObjectViaApi(state.tenant, ticket.photoId, state.executionId, blob, contentType);
      }
      await completeUpload(state.tenant, ticket.photoId, state.executionId);
      update((s) => ({
        ...s,
        photos: s.photos.map((p) =>
          p.photoId === ticket.photoId ? { ...p, status: 'uploaded' } : p,
        ),
      }));
      setPreviews((p) => ({ ...p, [ticket.photoId]: URL.createObjectURL(blob) }));
      setIndex((i) => Math.min(i + 1, shots.length - 1));
    } catch (err) {
      update((s) => ({
        ...s,
        photos: s.photos.map((p) => (p.status === 'uploading' ? { ...p, status: 'failed' } : p)),
      }));
      // "Offline" only when the device says so; a photo that cannot be stored while the
      // network is up is a failed photo, and the report still goes (PHO-04).
      const offline = err instanceof Offline && !navigator.onLine;
      setFailed(offline ? t('offline.banner') : t('photos.failed'));
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const prepared = await preparePhoto(file, maxBytes);
    if (prepared.quality?.dark || prepared.quality?.blurry) {
      setPending({
        blob: prepared.blob,
        issue: prepared.quality.dark ? 'dark' : 'blurry',
        url: URL.createObjectURL(prepared.blob),
      });
      return;
    }
    await upload(prepared.blob, prepared.contentType, prepared.hints);
  };

  const uploaded = state.photos.filter((p) => p.status === 'uploaded');
  if (!info.uploads.enabled) {
    return (
      <>
        <h1>{text(node.title, locale)}</h1>
        <Status kind="info">{t('photos.unavailable')}</Status>
        <ButtonRow>
          <button type="button" className="primary" onClick={onSkip}>
            {t('continue')}
          </button>
        </ButtonRow>
      </>
    );
  }
  return (
    <>
      <h1>{text(node.title, locale)}</h1>
      {node.body ? <p>{text(node.body, locale)}</p> : null}
      <Card tone="safety">
        <p>{t('photos.safety')}</p>
      </Card>
      {shot ? (
        <section aria-labelledby="shot-heading">
          <Progress
            text={`${t('photos.shot', { n: index + 1, total: shots.length })}${shot.optional ? ` · ${t('photos.optional')}` : ''}`}
          />
          <h2 id="shot-heading">{text(shot.title, locale)}</h2>
          <p>
            <strong>{t('example.label')}:</strong> {text(shot.example, locale)}
          </p>
          {pending ? (
            <div>
              <img
                src={pending.url}
                alt=""
                className="preview"
                style={{ maxInlineSize: '100%', borderRadius: 8 }}
              />
              <Status kind="warn">
                {t('photos.retake', {
                  issue: t(pending.issue === 'dark' ? 'photos.dark' : 'photos.blurry'),
                })}
              </Status>
              <ButtonRow>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    const p = pending;
                    setPending(null);
                    void upload(p.blob, 'image/jpeg', {});
                  }}
                >
                  {t('photos.keep')}
                </button>
                <button type="button" onClick={() => setPending(null)}>
                  {t('photos.another')}
                </button>
              </ButtonRow>
            </div>
          ) : (
            <ButtonRow>
              <label className="button-like">
                <span className="visually-hidden">{t('photos.take')}</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  aria-label={t('photos.take')}
                  disabled={Boolean(busy) || uploaded.length >= 30}
                  onChange={(e) => void onFile(e.target.files?.[0])}
                />
              </label>
              <label className="button-like">
                <span className="visually-hidden">{t('photos.choose')}</span>
                <input
                  type="file"
                  accept="image/*"
                  aria-label={t('photos.choose')}
                  disabled={Boolean(busy) || uploaded.length >= 30}
                  onChange={(e) => void onFile(e.target.files?.[0])}
                />
              </label>
            </ButtonRow>
          )}
          {busy ? <p role="status">{busy}</p> : null}
          {failed ? <Status kind="warn">{failed}</Status> : null}
        </section>
      ) : null}
      {uploaded.length > 0 ? (
        <>
          <p role="status">{t('photos.added', { n: uploaded.length })}</p>
          <ul className="photo-list">
            {uploaded.map((p) => (
              <li key={p.photoId}>
                {previews[p.photoId] ? (
                  <img src={previews[p.photoId]} alt="" />
                ) : (
                  <Icon name="other" />
                )}
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    update((s) => ({
                      ...s,
                      photos: s.photos.filter((x) => x.photoId !== p.photoId),
                    }))
                  }
                >
                  {t('photos.remove')}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ButtonRow>
        <button
          type="button"
          className="primary"
          onClick={uploaded.length > 0 ? onDone : onSkip}
          disabled={Boolean(busy)}
        >
          {uploaded.length > 0 ? t('continue') : t('photos.skipAll')}
        </button>
      </ButtonRow>
    </>
  );
}

// -------------------------------------------------------------------- review

function Review({
  graph,
  state,
  locale,
  onChange,
  onSend,
}: {
  graph: QuestionGraph;
  state: FlowState;
  locale: string;
  onChange: (id: string) => void;
  onSend: () => void;
}) {
  const t = useT();
  const sections = summary(graph, contextOf(state), engineAnswers(state), locale, {
    unknown: t('dontKnow'),
    skipped: t('skip'),
  });
  const needLabel = (v: string) => {
    const c = graph.needCategories.find((n) => n.value === v);
    return c ? text(c.label, locale) : v;
  };
  const consentYes = graph.consentOrgTypes
    .filter((o) => state.consent[o.value])
    .map((o) => text(o.label, locale));
  const photos = state.photos.filter((p) => p.status === 'uploaded').length;
  return (
    <>
      <Progress text={t('progress.last')} />
      <h1>{t('review.heading')}</h1>
      <p>{t('review.body')}</p>
      {state.fromWords.length > 0 ? <Status kind="info">{t('review.aiNotice')}</Status> : null}
      {sections.map((s) => (
        <section key={s.section} className="review-section" aria-labelledby={`rev-${s.section}`}>
          <h2 id={`rev-${s.section}`}>{s.title}</h2>
          <dl>
            {s.items.map((item) => (
              <div className="row" key={item.id}>
                <dt>{item.prompt}</dt>
                <dd>
                  <span className="answer">
                    {item.answer}
                    {state.fromWords.includes(item.id) ? (
                      <span className="tag">{t('review.fromWords')}</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => onChange(item.id)}
                    aria-label={`${t('review.change')}: ${item.prompt}`}
                  >
                    {t('review.change')}
                  </button>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <section className="review-section" aria-labelledby="rev-needs">
        <h2 id="rev-needs">{t('review.needs')}</h2>
        <dl>
          <div className="row">
            <dt>{t('review.needs')}</dt>
            <dd>
              <span className="answer">
                {state.needs.length ? state.needs.map(needLabel).join(', ') : t('review.none')}
              </span>
              <button
                type="button"
                className="link"
                onClick={() => onChange('needs')}
                aria-label={`${t('review.change')}: ${t('review.needs')}`}
              >
                {t('review.change')}
              </button>
            </dd>
          </div>
          <div className="row">
            <dt>{t('review.consent')}</dt>
            <dd>
              <span className="answer">
                {consentYes.length ? consentYes.join(', ') : t('review.none')}
              </span>
              <button
                type="button"
                className="link"
                onClick={() => onChange('consent')}
                aria-label={`${t('review.change')}: ${t('review.consent')}`}
              >
                {t('review.change')}
              </button>
            </dd>
          </div>
          <div className="row">
            <dt>{t('review.photos')}</dt>
            <dd>
              <span className="answer">
                {photos ? t('photos.added', { n: photos }) : t('review.none')}
              </span>
              <button
                type="button"
                className="link"
                onClick={() => onChange('photos')}
                aria-label={`${t('review.change')}: ${t('review.photos')}`}
              >
                {t('review.change')}
              </button>
            </dd>
          </div>
          {state.ownWords ? (
            <div className="row">
              <dt>{t('review.ownWords')}</dt>
              <dd>
                <span className="answer">{state.ownWords}</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => onChange('own_words')}
                  aria-label={`${t('review.change')}: ${t('review.ownWords')}`}
                >
                  {t('review.change')}
                </button>
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
      <ButtonRow>
        <button type="button" className="primary" onClick={onSend}>
          {t('review.send')}
        </button>
      </ButtonRow>
    </>
  );
}

/**
 * Sending and after (plan screens 9–11; ACC-39, ACC-41, ACC-50, INT-19,
 * INT-22, FL-01, AC-11B): the outbox states in words, the confirmation with
 * the reference number in text and as a code to scan, "text this number to
 * me", what happens next without promising aid, the optional questions, and
 * clearing the device.
 */
import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { text, validateAnswer, type AnswerValue, type QuestionNode } from '@cg/intake';
import { useT, type Shell } from '../App.tsx';
import { Offline, sendAfter, textCode, type IntakeInfo } from '../api/public.ts';
import type { OutboxItem } from '../intake/outbox.ts';
import { nextPlace, spellCode, type FlowState } from '../intake/state.ts';
import { ButtonRow, Card, ChoiceGroup, Field, Status } from '../ui/primitives.tsx';

export function Submit({
  shell,
  info,
  state,
  kiosk,
  afterMode,
  setAfterMode,
  update,
  onDone,
}: {
  shell: Shell;
  info: IntakeInfo;
  state: FlowState;
  kiosk: boolean;
  afterMode: boolean;
  setAfterMode: (v: boolean) => void;
  update: (fn: (s: FlowState) => FlowState) => void;
  onDone: () => void;
}) {
  const t = useT();
  const [, tick] = useState(0);
  useEffect(() => shell.outbox.subscribe(() => tick((n) => n + 1)), [shell.outbox]);
  const item = shell.outbox.find(state.executionId);

  if (afterMode && item?.state === 'received') {
    return (
      <After
        shell={shell}
        info={info}
        state={state}
        update={update}
        onFinish={() => {
          setAfterMode(false);
        }}
      />
    );
  }

  if (!item || item.state !== 'received') {
    return (
      <main id="main" tabIndex={-1}>
        <h1>{t('review.notSent')}</h1>
        <SendState item={item} />
        <ButtonRow>
          <button
            type="button"
            className="primary"
            onClick={() => void shell.outbox.flush()}
            disabled={item?.state === 'sending'}
          >
            {t('send.retry')}
          </button>
        </ButtonRow>
      </main>
    );
  }

  return (
    <Confirmation
      shell={shell}
      info={info}
      state={state}
      item={item}
      kiosk={kiosk}
      onMore={() => setAfterMode(true)}
      onAnotherPlace={(keepContact) =>
        update((s) => nextPlace(s, info.graph, item.receipt?.referenceCode ?? '', keepContact))
      }
      onDone={onDone}
    />
  );
}

function SendState({ item }: { item: OutboxItem | undefined }) {
  const t = useT();
  const state = item?.state ?? 'not_sent';
  const label = {
    not_sent: t('send.state.notSent'),
    sending: t('send.state.sending'),
    received: t('send.state.received'),
    failed: t('send.state.failed'),
  }[state];
  return (
    <div role="status" aria-live="polite">
      <p>
        <strong>{label}</strong>
      </p>
      {state === 'sending' ? <p>{t('send.sending')}</p> : null}
      {state === 'failed' && item?.final ? (
        <Status kind="error">{t('send.failed', { reason: item.lastError ?? '' })}</Status>
      ) : state === 'failed' || state === 'not_sent' ? (
        <p>{t('send.waiting')}</p>
      ) : null}
    </div>
  );
}

function Confirmation({
  shell,
  info,
  state,
  item,
  kiosk,
  onMore,
  onAnotherPlace,
  onDone,
}: {
  shell: Shell;
  info: IntakeInfo;
  state: FlowState;
  item: OutboxItem;
  kiosk: boolean;
  onMore: () => void;
  onAnotherPlace: (keepContact: boolean) => void;
  onDone: () => void;
}) {
  const t = useT();
  const code = item.receipt?.referenceCode ?? '';
  const county = info.tenant.name || shell.config.countyName || t('county.fallback');
  const [qr, setQr] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [texted, setTexted] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  // ORG-01: an organization reports each of its places as a report of its own, one after another.
  const rel = state.answers['relationship'];
  const orgAnswer = state.answers['org_name'];
  const orgName =
    rel?.kind === 'value' && rel.value === 'organization' && orgAnswer?.kind === 'value'
      ? String(orgAnswer.value)
      : null;
  const places = [...(state.earlierPlaces ?? []), code];
  const contact = state.answers['contact'];
  const gavePhone =
    contact?.kind === 'value' &&
    typeof contact.value === 'object' &&
    !Array.isArray(contact.value) &&
    Boolean(contact.value['phone']);

  useEffect(() => {
    const url = `${location.origin}/${state.tenant}/my-report?ref=${encodeURIComponent(code)}`;
    QRCode.toDataURL(url, { margin: 1, width: 176, errorCorrectionLevel: 'M' })
      .then(setQr)
      .catch(() => setQr(null));
  }, [code, state.tenant]);

  const clear = () => {
    shell.store.clearAll();
    void shell.outbox.forget(state.executionId);
    setCleared(true);
  };

  // Shared devices: personal answers leave the device after two minutes here (ACC-41); the code stays on screen.
  useEffect(() => {
    const ms = kiosk ? 10_000 : 120_000;
    const timer = setTimeout(() => {
      clear();
      if (kiosk) onDone();
    }, ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendText = async () => {
    try {
      await textCode(state.tenant, state.executionId, phone, state.language);
      setTexted(t('confirm.textSent'));
    } catch (err) {
      setTexted(err instanceof Offline ? t('offline.banner') : t('confirm.textSent'));
    }
  };

  return (
    <main id="main" tabIndex={-1}>
      {kiosk ? (
        <p className="kiosk" role="status">
          {t('kiosk.clearing')}
        </p>
      ) : null}
      <h1>{t('confirm.heading')}</h1>
      <Card>
        <p>{t('confirm.reference')}</p>
        <p className="reference">
          <span aria-hidden="true">{code}</span>
          <span className="visually-hidden">
            {t('confirm.referenceSpelled', { spelled: spellCode(code) })}
          </span>
        </p>
        {qr ? <img className="qr" src={qr} alt={t('confirm.qrAlt')} /> : null}
        {state.smsOptIn && gavePhone ? (
          <p>{t('confirm.textedAlready')}</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendText();
            }}
          >
            <Field label={t('confirm.textPhone')}>
              {({ id }) => (
                <input
                  id={id}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              )}
            </Field>
            <ButtonRow>
              <button type="submit" disabled={phone.replace(/\D/g, '').length < 10}>
                {t('confirm.textMe')}
              </button>
            </ButtonRow>
            {texted ? <p role="status">{texted}</p> : null}
          </form>
        )}
      </Card>
      <h2>{t('confirm.next')}</h2>
      <ul>
        <li>{t('confirm.next1', { county })}</li>
        {Object.values(state.consent).some(Boolean) ? <li>{t('confirm.next2')}</li> : null}
        <li>{t('confirm.next3')}</li>
        <li>{t('confirm.next4')}</li>
        {item.receipt?.verificationSuggested ? <li>{t('confirm.verify')}</li> : null}
      </ul>
      {orgName && !kiosk ? (
        <Card>
          <h2>{t('confirm.places', { org: orgName })}</h2>
          {places.length > 1 ? (
            <p>
              {t('confirm.placesSoFar', { count: String(places.length) })}{' '}
              <span className="codes">{places.join(', ')}</span>
            </p>
          ) : null}
          <p>{t(cleared ? 'confirm.anotherPlaceCleared' : 'confirm.anotherPlaceWhy')}</p>
          <ButtonRow>
            <button type="button" className="primary" onClick={() => onAnotherPlace(!cleared)}>
              {t('confirm.anotherPlace', { org: orgName })}
            </button>
          </ButtonRow>
        </Card>
      ) : null}
      {!kiosk && info.graph.afterSubmission.length > 0 ? (
        <Card>
          <p>{t('confirm.moreWhy')}</p>
          <ButtonRow>
            <button type="button" className="primary" onClick={onMore}>
              {t('confirm.more')}
            </button>
          </ButtonRow>
        </Card>
      ) : null}
      <ButtonRow>
        <a
          className="button"
          href={`/${state.tenant}/help`}
          onClick={(e) => (e.preventDefault(), shell.navigate(`/${state.tenant}/help`))}
        >
          {t('confirm.findHelp')}
        </a>
        <a
          className="button"
          href={`/${state.tenant}/my-report`}
          onClick={(e) => (e.preventDefault(), shell.navigate(`/${state.tenant}/my-report`))}
        >
          {t('confirm.myReport')}
        </a>
      </ButtonRow>
      {!kiosk ? (
        <p>
          {cleared ? (
            <span role="status">{t('confirm.cleared')}</span>
          ) : (
            <button type="button" className="link" onClick={clear}>
              {t('confirm.clear')}
            </button>
          )}
        </p>
      ) : null}
      {!kiosk ? <p className="hint">{t('confirm.autoClear')}</p> : null}
    </main>
  );
}

// --------------------------------------------------------------------- after

function After({
  shell,
  info,
  state,
  update,
  onFinish,
}: {
  shell: Shell;
  info: IntakeInfo;
  state: FlowState;
  update: (fn: (s: FlowState) => FlowState) => void;
  onFinish: () => void;
}) {
  const t = useT();
  const questions = info.graph.afterSubmission;
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<'saved' | 'queued' | 'offline' | null>(null);
  const q = questions[index];
  const locale = shell.locale;

  const finish = async (answers: Record<string, AnswerValue>) => {
    if (Object.keys(answers).length === 0) {
      onFinish();
      return;
    }
    try {
      const r = await sendAfter(state.tenant, state.executionId, {
        graphKey: state.graphKey,
        graphVersion: state.graphVersion,
        answers,
      });
      setResult(r.status === 'saved' ? 'saved' : 'queued');
    } catch (err) {
      if (err instanceof Offline) {
        setResult('offline');
        const retry = () => {
          window.removeEventListener('online', retry);
          void finish(answers);
        };
        window.addEventListener('online', retry);
      } else setResult('queued');
    }
  };

  if (result) {
    return (
      <main id="main" tabIndex={-1}>
        <h1>{t('after.heading')}</h1>
        <Status kind={result === 'offline' ? 'warn' : 'success'}>
          {t(
            result === 'saved'
              ? 'after.done'
              : result === 'queued'
                ? 'after.queued'
                : 'after.offline',
          )}
        </Status>
        <ButtonRow>
          <button type="button" className="primary" onClick={onFinish}>
            {t('after.finish')}
          </button>
        </ButtonRow>
      </main>
    );
  }
  if (!q) {
    void finish(state.afterSubmission);
    return (
      <main id="main" tabIndex={-1}>
        <p role="status">{t('loading')}</p>
      </main>
    );
  }
  return (
    <main id="main" tabIndex={-1}>
      <h1>{t('after.heading')}</h1>
      <p>{t('after.body')}</p>
      <AfterQuestion
        key={q.id}
        q={q}
        locale={locale}
        position={`${index + 1} / ${questions.length}`}
        onAnswer={(value) => {
          update((s) => ({ ...s, afterSubmission: { ...s.afterSubmission, [q.id]: value } }));
          if (index + 1 >= questions.length)
            void finish({ ...state.afterSubmission, [q.id]: value });
          else setIndex(index + 1);
        }}
        onSkip={() => {
          if (index + 1 >= questions.length) void finish(state.afterSubmission);
          else setIndex(index + 1);
        }}
      />
    </main>
  );
}

function AfterQuestion({
  q,
  locale,
  position,
  onAnswer,
  onSkip,
}: {
  q: QuestionNode;
  locale: string;
  position: string;
  onAnswer: (v: AnswerValue) => void;
  onSkip: () => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>([]);
  const [textValue, setTextValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const options = (q.options ?? []).map((o) => ({
    value: o.value,
    label: text(o.label, locale),
    ...(o.hint ? { hint: text(o.hint, locale) } : {}),
  }));
  const commit = (value: AnswerValue) => {
    const errors = validateAnswer(q, value);
    if (errors.length) return setError(errors[0]!.message);
    onAnswer(value);
  };
  let control: ReactNode;
  if (q.answerType === 'single' || q.answerType === 'yesno' || q.answerType === 'multi') {
    control = (
      <ChoiceGroup
        legend={text(q.prompt, locale)}
        multiple={q.answerType === 'multi'}
        choices={options}
        value={picked}
        onChange={setPicked}
        error={error ?? undefined}
      />
    );
  } else if (q.answerType === 'number') {
    control = (
      <Field label={text(q.prompt, locale)} hint={t('number.hint')} error={error ?? undefined}>
        {({ id }) => (
          <input
            id={id}
            type="number"
            inputMode="numeric"
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
          />
        )}
      </Field>
    );
  } else {
    control = (
      <Field label={text(q.prompt, locale)} error={error ?? undefined}>
        {({ id }) => (
          <textarea id={id} value={textValue} onChange={(e) => setTextValue(e.target.value)} />
        )}
      </Field>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (q.answerType === 'single' || q.answerType === 'yesno') {
          if (!picked[0]) return setError(t('validation.pick'));
          return commit({ kind: 'value', value: picked[0] });
        }
        if (q.answerType === 'multi') {
          if (!picked.length) return setError(t('validation.pick'));
          return commit({ kind: 'value', value: picked });
        }
        if (q.answerType === 'number') {
          if (!textValue.trim()) return setError(t('number.hint'));
          return commit({ kind: 'value', value: Number(textValue) });
        }
        if (!textValue.trim()) return onSkip();
        return commit({ kind: 'value', value: textValue.trim() });
      }}
    >
      <p className="progress">{position}</p>
      <p>
        <strong>{t('why.label')}:</strong> {text(q.why, locale)}
      </p>
      {control}
      <ButtonRow>
        <button type="submit" className="primary">
          {t('continue')}
        </button>
        {q.allowUnknown ? (
          <button type="button" onClick={() => commit({ kind: 'unknown' })}>
            {t('dontKnow')}
          </button>
        ) : null}
        <button type="button" className="quiet" onClick={onSkip}>
          {t('skip')}
        </button>
      </ButtonRow>
    </form>
  );
}

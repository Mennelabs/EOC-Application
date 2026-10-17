/**
 * My report (plan screen 12; RES-01, RES-02, RULE-17, SEC-09, NED-03):
 * reference number plus the contact on file, a one-time code, then status,
 * consent changes, corrections and withdrawal, and a PDF copy to keep or
 * send to an insurer (FL:FR-32). The server answers the same
 * whether or not the details matched; nothing is shown without the code.
 * Photos can be added here to a report started by text, phone or a helper
 * (CHN-09), prepared on the device like intake photos (metadata gone).
 */
import { useEffect, useRef, useState } from 'react';
import { useT, type Shell } from '../App.tsx';
import {
  ApiFailure,
  Offline,
  completeUpload,
  correct,
  downloadMyCopy,
  lookupRecover,
  lookupStart,
  lookupVerify,
  myReport,
  putObject,
  putObjectViaApi,
  requestMyUpload,
  setConsent,
  withdraw,
  type MyReport as Report,
} from '../api/public.ts';
import { preparePhoto } from '../intake/photos.ts';
import { ButtonRow, Card, Field, Status } from '../ui/primitives.tsx';
import { IdleTimer, MY_REPORT_IDLE } from '../intake/idle.ts';
import { useIntake } from './useIntake.ts';
import { text } from '@cg/intake';

export function MyReport({ shell, tenant }: { shell: Shell; tenant: string }) {
  const t = useT();
  const params = new URLSearchParams(location.search);
  const [reference, setReference] = useState(params.get('ref') ?? '');
  const [contact, setContact] = useState('');
  const [sent, setSent] = useState(false);
  // BRD:FR-01.06: a lost reference number is sent again to the contact on the report.
  const [recover, setRecover] = useState<'closed' | 'open' | 'sent'>('closed');
  const switched = useRef(false);
  useEffect(() => {
    // The screen changes in place: focus goes to its start, as on any new screen (WCAG 2.4.3).
    if (switched.current) document.getElementById('main')?.focus();
    switched.current = true;
  }, [recover]);
  const [code, setCode] = useState('');
  const [token, setToken] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('cg.resident');
    } catch {
      return null;
    }
  });
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [photoNote, setPhotoNote] = useState<{
    kind: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const intake = useIntake(tenant, shell.config.event ?? 'westwind', shell.locale);

  useEffect(() => {
    if (!token) return;
    myReport(tenant, token)
      .then(setReport)
      .catch(() => {
        setToken(null);
        try {
          sessionStorage.removeItem('cg.resident');
        } catch {
          // nothing stored
        }
      });
  }, [token, tenant]);

  const sendReference = async () => {
    await lookupRecover(tenant, contact).catch(() => undefined);
    setRecover('sent'); // the answer is the same either way (RULE-17)
  };
  const start = async () => {
    setError(null);
    await lookupStart(tenant, reference, contact).catch(() => undefined);
    setSent(true); // the answer is the same either way (RULE-17)
  };
  const verify = async () => {
    setError(null);
    try {
      const r = await lookupVerify(tenant, reference, code);
      setToken(r.token);
      try {
        sessionStorage.setItem('cg.resident', r.token);
      } catch {
        // memory only
      }
    } catch (err) {
      // AC-A05: always the resident's language, never the server's English.
      setError(
        err instanceof ApiFailure && err.status === 401
          ? t('my.codeWrong')
          : err instanceof ApiFailure && err.status === 429
            ? t('my.tooMany')
            : t('my.tryLater'),
      );
    }
  };
  // AC-A07, ACC-41, WCAG 2.2.1: an open report closes after a while without use, warned first,
  // with "I need more time"; the lookup screen then says why.
  const [idleWarning, setIdleWarning] = useState(false);
  const [closedIdle, setClosedIdle] = useState(false);
  const idle = useRef<IdleTimer | null>(null);
  useEffect(() => {
    if (!token) return;
    const timer = new IdleTimer({
      ...MY_REPORT_IDLE,
      onWarn: () => setIdleWarning(true),
      onExpire: () => {
        setIdleWarning(false);
        setClosedIdle(true);
        setToken(null);
        setReport(null);
        try {
          sessionStorage.removeItem('cg.resident');
        } catch {
          // nothing stored
        }
      },
    });
    idle.current = timer;
    const touched = () => {
      setIdleWarning(false);
      timer.touch();
    };
    timer.touch();
    for (const e of ['pointerdown', 'keydown', 'input'] as const)
      document.addEventListener(e, touched, true);
    return () => {
      timer.stop();
      for (const e of ['pointerdown', 'keydown', 'input'] as const)
        document.removeEventListener(e, touched, true);
    };
  }, [token]);
  const close = () => {
    setToken(null);
    setReport(null);
    try {
      sessionStorage.removeItem('cg.resident');
    } catch {
      // nothing stored
    }
  };

  if (!token && recover !== 'closed') {
    return (
      <main id="main" tabIndex={-1}>
        <h1>{t('my.recover.heading')}</h1>
        {recover === 'open' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendReference();
            }}
          >
            <p>{t('my.recover.body')}</p>
            <Field label={t('my.contact')}>
              {({ id }) => (
                <input
                  id={id}
                  type="text"
                  autoComplete="tel"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                />
              )}
            </Field>
            <ButtonRow>
              <button type="submit" className="primary" disabled={contact.trim().length < 3}>
                {t('my.recover.send')}
              </button>
            </ButtonRow>
          </form>
        ) : (
          <Status kind="info">{t('my.recover.sent')}</Status>
        )}
        <p>
          <button type="button" className="link" onClick={() => setRecover('closed')}>
            {t('my.recover.back')}
          </button>
        </p>
      </main>
    );
  }

  if (!token) {
    return (
      <main id="main" tabIndex={-1}>
        <h1>{t('my.heading')}</h1>
        {closedIdle ? <Status kind="info">{t('my.closedIdle')}</Status> : null}
        <p>{t('my.body')}</p>
        {!sent ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <Field label={t('my.reference')}>
              {({ id }) => (
                <input
                  id={id}
                  type="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('my.contact')}>
              {({ id }) => (
                <input
                  id={id}
                  type="text"
                  autoComplete="tel"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                />
              )}
            </Field>
            <ButtonRow>
              <button
                type="submit"
                className="primary"
                disabled={
                  reference.replace(/[^a-z0-9]/gi, '').length < 8 || contact.trim().length < 3
                }
              >
                {t('my.sendCode')}
              </button>
            </ButtonRow>
            <p>
              <button type="button" className="link" onClick={() => setRecover('open')}>
                {t('my.lost')}
              </button>
            </p>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <Status kind="info">{t('my.sent')}</Status>
            <Field label={t('my.code')} error={error ?? undefined}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              )}
            </Field>
            <ButtonRow>
              <button type="submit" className="primary" disabled={code.length !== 6}>
                {t('my.verify')}
              </button>
              <button type="button" className="link" onClick={() => setSent(false)}>
                {t('my.sendCode')}
              </button>
            </ButtonRow>
          </form>
        )}
      </main>
    );
  }

  if (!report) {
    return (
      <main id="main" tabIndex={-1}>
        <p role="status">{t('loading')}</p>
      </main>
    );
  }
  const statusId = (
    report.withdrawnAt ? 'my.status.withdrawn' : `my.status.${report.status}`
  ) as Parameters<typeof t>[0];
  const graph = intake.data?.graph;
  /** Question ids from a county's request, as the questions' own words in the resident's language. */
  const askedAbout = (ids: unknown): string[] => {
    const nodes = [...(graph?.nodes ?? []), ...(graph?.afterSubmission ?? [])];
    return (Array.isArray(ids) ? ids : [])
      .map((id) => nodes.find((n) => n.id === id))
      .flatMap((n) => (n?.kind === 'question' ? [text(n.prompt, shell.locale)] : []));
  };
  const orgLabel = (v: string) => {
    const o = graph?.consentOrgTypes.find((c) => c.value === v);
    return o ? text(o.label, shell.locale) : v;
  };
  const needLabel = (v: string) => {
    const c = graph?.needCategories.find((n) => n.value === v);
    return c ? text(c.label, shell.locale) : v;
  };
  const refresh = () =>
    myReport(tenant, token)
      .then(setReport)
      .catch(() => undefined);
  const uploads = intake.data?.uploads;
  // CHN-09: the same preparation and upload as during intake, to this report.
  const addPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoNote({ kind: 'info', text: t('photos.uploading') });
    try {
      const maxBytes = Math.min(uploads?.maxBytes ?? 1_500_000, 1_500_000);
      const p = await preparePhoto(file, maxBytes);
      const ticket = await requestMyUpload(tenant, token, {
        shot: 'other',
        contentType: p.contentType,
        bytes: p.blob.size,
        ...(p.hints.takenAt ? { takenAt: new Date(p.hints.takenAt).toISOString() } : {}),
        ...(p.hints.location ? { location: p.hints.location } : {}),
      });
      try {
        await putObject(ticket, p.blob);
      } catch (err) {
        if (!(err instanceof Offline)) throw err;
        await putObjectViaApi(tenant, ticket.photoId, ticket.executionId, p.blob, p.contentType);
      }
      await completeUpload(tenant, ticket.photoId, ticket.executionId);
      setPhotoNote({ kind: 'success', text: t('my.photoAdded') });
      await refresh();
    } catch (err) {
      setPhotoNote({
        kind: 'error',
        text:
          err instanceof ApiFailure && err.status === 503 ? t('my.photosOff') : t('my.photoFailed'),
      });
    }
  };
  return (
    <main id="main" tabIndex={-1}>
      <h1>{t('my.heading')}</h1>
      {idleWarning ? (
        <div role="alert" className="status warn">
          <p>{t('my.idleWarning')}</p>
          <button
            type="button"
            onClick={() => {
              setIdleWarning(false);
              idle.current?.touch();
            }}
          >
            {t('kiosk.moreTime')}
          </button>
        </div>
      ) : null}
      <Card>
        <p className="reference">{report.referenceCode}</p>
        <p>
          <strong>{t('my.status')}:</strong> {t(statusId)}
        </p>
        <p>
          {t('my.submitted', {
            date: new Date(report.submittedAt).toLocaleDateString(shell.locale),
          })}
        </p>
      </Card>
      {note ? <Status kind="success">{note}</Status> : null}
      <section aria-labelledby="copy-heading">
        <h2 id="copy-heading">{t('my.copy')}</h2>
        <p>{t('my.copyHint')}</p>
        <button
          type="button"
          onClick={() => {
            setNote(null);
            setError(null);
            downloadMyCopy(tenant, token, shell.locale)
              .then(() => setNote(t('my.copyReady')))
              .catch(() => setError(t('my.copyFailed')));
          }}
        >
          {t('my.copyDownload')}
        </button>
        {error ? <Status kind="error">{error}</Status> : null}
      </section>
      {report.openQuestions.length > 0 ? (
        <section aria-labelledby="q-heading">
          <h2 id="q-heading">{t('my.questions')}</h2>
          <ul>
            {report.openQuestions.map((q) => {
              // The questions the county asks about, in the resident's language (AC-A05).
              const asked = askedAbout(q.questions);
              return (
                <li key={q.id}>
                  {q.message ? <p>{q.message}</p> : null}
                  {asked.length > 0 ? (
                    <>
                      <p>{t('my.questionAbout')}</p>
                      <ul>
                        {asked.map((prompt) => (
                          <li key={prompt}>{prompt}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {!q.message && asked.length === 0 ? <p>{t('my.questionGeneric')}</p> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="needs-heading">
        <h2 id="needs-heading">{t('my.needs')}</h2>
        {report.needs.length ? (
          <ul>
            {report.needs.map((n) => (
              <li key={n.id}>
                {needLabel(n.category)} — {n.status}
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('review.none')}</p>
        )}
      </section>
      {!report.withdrawnAt ? (
        <>
          <section aria-labelledby="consent-heading">
            <h2 id="consent-heading">{t('my.consent')}</h2>
            <div className="choices">
              <ul>
                {(graph?.consentOrgTypes ?? []).map((o) => {
                  const granted = report.consent[o.value] ?? false;
                  const id = `consent-${o.value}`;
                  return (
                    <li key={o.value}>
                      <input
                        type="checkbox"
                        id={id}
                        checked={granted}
                        onChange={async (e) => {
                          await setConsent(tenant, token, o.value, e.target.checked).catch(
                            () => undefined,
                          );
                          await refresh();
                        }}
                      />
                      <label htmlFor={id}>{orgLabel(o.value)}</label>
                    </li>
                  );
                })}
              </ul>
            </div>
            <p className="hint">{t('consent.note')}</p>
          </section>
          <section aria-labelledby="photos-heading">
            <h2 id="photos-heading">{t('my.photos')}</h2>
            <p>{t('my.photosHint')}</p>
            <p>{t('my.photosCount', { n: report.photos })}</p>
            {photoNote ? <Status kind={photoNote.kind}>{photoNote.text}</Status> : null}
            {uploads && !uploads.enabled ? (
              <p>{t('my.photosOff')}</p>
            ) : (
              <Field label={t('my.photosAdd')}>
                {({ id }) => (
                  <input
                    id={id}
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      void addPhoto(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                )}
              </Field>
            )}
          </section>
          <section aria-labelledby="correct-heading">
            <h2 id="correct-heading">{t('my.correct')}</h2>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const first = report.openQuestions[0];
                await correct(tenant, token, {
                  answers: {},
                  ownWords: message,
                  message,
                  ...(first ? { correctionRequestId: first.id } : {}),
                }).catch(() => undefined);
                setMessage('');
                setNote(t('my.corrected'));
                await refresh();
              }}
            >
              <Field label={t('my.correctLabel')}>
                {({ id }) => (
                  <textarea id={id} value={message} onChange={(e) => setMessage(e.target.value)} />
                )}
              </Field>
              <ButtonRow>
                <button type="submit" className="primary" disabled={message.trim().length < 2}>
                  {t('my.correctSend')}
                </button>
              </ButtonRow>
            </form>
          </section>
          <ButtonRow>
            <button
              type="button"
              onClick={async () => {
                if (!window.confirm(t('my.withdrawConfirm'))) return;
                await withdraw(tenant, token).catch(() => undefined);
                setNote(t('my.withdrawn'));
                await refresh();
              }}
            >
              {t('my.withdraw')}
            </button>
            <button type="button" className="link" onClick={close}>
              {t('my.signOut')}
            </button>
          </ButtonRow>
        </>
      ) : (
        <ButtonRow>
          <button type="button" className="link" onClick={close}>
            {t('my.signOut')}
          </button>
        </ButtonRow>
      )}
    </main>
  );
}

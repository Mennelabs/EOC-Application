/**
 * Official reports in the console (layer-6 task E; F15, RULE-10, RULE-14,
 * CON-06, AC-15A/B/C, A7, WCAG 2.2 AA): the list for an event with a form
 * to draft a situation report or briefing for the current operational
 * period, and each report's page: facts from the records (each citing its
 * definition; unknown reads "Unknown"), the summary drafted from them and
 * labelled as such until the author has read and saved it, the judgments
 * staff write and are named against, and the steps its state allows the
 * person looking: the author edits and refreshes, someone else approves or
 * returns it, someone else issues it through the confirmation dialog. An
 * issued report shows its content hash and its locked copy, and is
 * corrected only by an amendment. "What changed since the last issued
 * report" sits beside a draft.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';
import { ExportFile, useExports } from './fema-package.tsx';
import { PartnerRollupChooser, type RollupValue } from './partner-rollup.tsx';
import { fromZoneInput, toZoneInput, wallClock } from '../ui/time.ts';

type State = 'draft' | 'reviewed' | 'issued' | 'superseded' | 'withdrawn';
const STATE_TEXT: Record<State, string> = {
  draft: 'Draft',
  reviewed: 'Reviewed, ready to issue',
  issued: 'Issued',
  superseded: 'Superseded by an amendment',
  withdrawn: 'Withdrawn',
};
const KINDS = { sitrep: 'Situation report', briefing: 'Briefing' } as const;
type Kind = keyof typeof KINDS;

interface ReportRow {
  id: string;
  version: number;
  eventId: string;
  kind: string;
  title: string;
  periodFrom: string;
  periodTo: string;
  timeZone: string;
  cutoff: string;
  state: State;
  authorId: string;
  authorName: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  issuerName: string | null;
  issuedAt: string | null;
  amends: string | null;
  amendedBy: string | null;
  factsAt: string;
  /** Which partner counts the report states (2026-10-15, DCL:DEC-09). */
  partnerRollup?: RollupValue;
}

interface Section {
  key: string;
  kind: 'fact' | 'judgment' | 'narrative';
  title: string;
  content: {
    text?: string;
    rows?: { key: string; label: string; value: number | null; detail?: string }[];
    note?: string | null;
    /** Layer-7 task G: drafted by the AI assistant from the facts, each sentence citing them. */
    ai?: {
      provider: string;
      model: string;
      sentences: { text: string; factIds: string[] }[];
    };
  };
  definition: { key: string; version: number; text: string } | null;
  recordCount: number;
  drafted: boolean;
  editedByName: string | null;
  editedAt: string | null;
}

interface Report extends ReportRow {
  partnerOrganizations?: { id: string; organization: string }[];
  sections: Section[];
  snapshot: {
    id: string;
    contentHash: string;
    issuedAt: string;
    reason: string;
    recordCount: number;
    lock: { objectKey: string; lockMode: string; retainUntil: string; writtenAt: string } | null;
  } | null;
}

interface Changes {
  since: { reportId: string; title: string; issuedAt: string; cutoff: string } | null;
  asOf: string;
  changes: {
    fact: string;
    title: string;
    key: string;
    label: string;
    before: number | null;
    after: number | null;
  }[];
}

const value = (v: number | null) => (v === null ? 'Unknown' : v.toLocaleString('en-US'));

/** A time in the report's own time zone, with the zone named. */
const inZone = (iso: string, timeZone: string) =>
  // dateStyle and timeStyle cannot be combined with timeZoneName, so the parts are named.
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));

/**
 * The operational period now: 07:00–19:00 or 19:00–07:00 on the tenant's clock
 * (plan §14 question 2, default in force; BRD:FR-00.08), as datetime-local values.
 */
function currentPeriod(now = new Date()): { from: string; to: string } {
  const w = wallClock(now);
  const start = w.hour >= 7 && w.hour < 19 ? 7 : 19;
  // Before 07:00 the night period began at 19:00 the day before.
  const day = new Date(Date.UTC(w.year, w.month - 1, w.day - (w.hour < 7 ? 1 : 0)));
  const p = (x: number) => String(x).padStart(2, '0');
  const from = `${day.getUTCFullYear()}-${p(day.getUTCMonth() + 1)}-${p(day.getUTCDate())}T${p(start)}:00`;
  const to = toZoneInput(new Date(fromZoneInput(from).getTime() + 12 * 3_600_000));
  return { from, to };
}

function useMe() {
  const [me, setMe] = useState<{ accountId: string; actions: string[] } | null>(null);
  useEffect(() => {
    let live = true;
    api<{ accountId: string; actions: string[] }>('/me')
      .then((m) => live && setMe(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return me;
}

function ChangesPanel({ eventId }: { eventId: string }) {
  const [c, setC] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Changes>(`/events/${eventId}/changes`)
      .then((x) => live && setC(x))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [eventId]);
  return (
    <section aria-labelledby="changes-h">
      <h2 id="changes-h">What changed since the last issued report</h2>
      {error ? <Status kind="error">{error}</Status> : null}
      {c && !c.since ? <p>No report has been issued for this event yet.</p> : null}
      {c?.since ? (
        <>
          <p>
            Since {c.since.title}, issued {fmt(c.since.issuedAt)} (figures to {fmt(c.since.cutoff)}
            ), compared with the records at {fmt(c.asOf)}.
          </p>
          <DataTable
            caption="Changes since the last issued report"
            rows={c.changes}
            rowKey={(x) => `${x.fact}.${x.key}`}
            empty="Nothing in the facts has changed."
            columns={[
              { key: 'what', header: 'Figure', render: (x) => `${x.title}: ${x.label}` },
              { key: 'before', header: 'Then', render: (x) => value(x.before) },
              { key: 'after', header: 'Now', render: (x) => value(x.after) },
            ]}
          />
        </>
      ) : null}
    </section>
  );
}

export function OfficialReportsScreen({ navigate }: { navigate: (to: string) => void }) {
  const { events, error: eventsError } = useOpenEvents();
  const [picked, setPicked] = useState<string | null>(null);
  const eventId = picked ?? events?.[0]?.id ?? null;
  const me = useMe();
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const period = currentPeriod();
  const [form, setForm] = useState({
    kind: 'sitrep' as Kind,
    from: period.from,
    to: period.to,
    cutoff: '',
    classification: 'internal',
  });
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!eventId) return;
    api<ReportRow[]>(`/official-reports?eventId=${eventId}&limit=100`)
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e: unknown) => setError(describeFailure(e)));
  }, [eventId]);
  useEffect(reload, [reload]);

  const periodError =
    form.from && form.to && form.to <= form.from
      ? 'The period must end after it starts.'
      : undefined;
  const cutoffError =
    form.cutoff && (form.cutoff <= form.from || form.cutoff > form.to)
      ? 'The cutoff must fall inside the period.'
      : undefined;
  const draft = (e: FormEvent) => {
    e.preventDefault();
    if (!eventId || periodError || cutoffError) return;
    setFormError(null);
    api<Report>('/official-reports', {
      body: {
        clientUuid: crypto.randomUUID(),
        eventId,
        kind: form.kind,
        periodFrom: fromZoneInput(form.from).toISOString(),
        periodTo: fromZoneInput(form.to).toISOString(),
        ...(form.cutoff ? { cutoff: fromZoneInput(form.cutoff).toISOString() } : {}),
        classification: form.classification,
      },
    })
      .then((r) => navigate(`/console/official-reports/${r.id}`))
      .catch((err: unknown) => setFormError(describeFailure(err)));
  };

  return (
    <section aria-labelledby="reports-h">
      <h1 id="reports-h">Official reports</h1>
      <p>
        Situation reports and briefings, drafted from the records, reviewed by someone other than
        the author, and issued. An issued report never changes; it is corrected by an amendment.
      </p>
      {eventsError ? <Status kind="error">{eventsError}</Status> : null}
      {events && events.length === 0 ? <p>There is no open event.</p> : null}
      {events && events.length > 0 ? (
        <EventPicker events={events} value={eventId} onChange={setPicked} />
      ) : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {rows === null && !error && eventId ? <p role="status">Loading reports…</p> : null}
      {rows ? (
        <DataTable
          caption="Reports for this event"
          rows={rows}
          rowKey={(r) => r.id}
          empty="No reports for this event yet."
          columns={[
            {
              key: 'title',
              header: 'Report',
              render: (r) => (
                <a
                  href={`/console/official-reports/${r.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/console/official-reports/${r.id}`);
                  }}
                >
                  {r.title}
                </a>
              ),
            },
            {
              key: 'period',
              header: 'Period',
              render: (r) =>
                `${inZone(r.periodFrom, r.timeZone)} to ${inZone(r.periodTo, r.timeZone)}`,
            },
            { key: 'state', header: 'State', render: (r) => STATE_TEXT[r.state] },
            { key: 'author', header: 'Author', render: (r) => r.authorName ?? '—' },
            { key: 'reviewer', header: 'Reviewed by', render: (r) => r.reviewerName ?? '—' },
            {
              key: 'issued',
              header: 'Issued',
              render: (r) => (r.issuedAt ? `${fmt(r.issuedAt)} by ${r.issuerName ?? '—'}` : '—'),
            },
          ]}
        />
      ) : null}
      {eventId && me?.actions.includes('official_report.draft') ? (
        <form onSubmit={draft} className="form-grid" aria-labelledby="draft-h">
          <h2 id="draft-h">Draft a report</h2>
          <p className="hint">
            The period is the current operational period (07:00 to 19:00, or 19:00 to 07:00). The
            facts include records made up to the cutoff, the end of the period unless you choose an
            earlier time.
          </p>
          <Field label="Kind of report">
            {({ id }) => (
              <select
                id={id}
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })}
              >
                {(Object.keys(KINDS) as Kind[]).map((k) => (
                  <option key={k} value={k}>
                    {KINDS[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Period starts">
            {({ id }) => (
              <input
                id={id}
                type="datetime-local"
                required
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
              />
            )}
          </Field>
          <Field label="Period ends" {...(periodError ? { error: periodError } : {})}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="datetime-local"
                required
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={form.to}
                onChange={(e) => setForm({ ...form, to: e.target.value })}
              />
            )}
          </Field>
          <Field label="Cutoff (optional)" {...(cutoffError ? { error: cutoffError } : {})}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="datetime-local"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={form.cutoff}
                onChange={(e) => setForm({ ...form, cutoff: e.target.value })}
              />
            )}
          </Field>
          <Field label="Who may see it">
            {({ id }) => (
              <select
                id={id}
                value={form.classification}
                onChange={(e) => setForm({ ...form, classification: e.target.value })}
              >
                <option value="internal">Internal: staff and partners</option>
                <option value="public">Public</option>
              </select>
            )}
          </Field>
          {formError ? <Status kind="error">{formError}</Status> : null}
          <div className="toolbar">
            <button type="submit" className="primary">
              Draft the report
            </button>
          </div>
        </form>
      ) : null}
      {eventId ? <ChangesPanel eventId={eventId} /> : null}
    </section>
  );
}

function TextSection({
  section,
  editable,
  onSave,
  onAiDraft,
}: {
  section: Section;
  editable: boolean;
  onSave: (text: string) => void;
  /** The summary only: ask the AI assistant to redraft it from the facts. */
  onAiDraft?: () => void;
}) {
  const [text, setText] = useState(section.content.text ?? '');
  const id = `sec-${section.key}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{section.title}</h2>
      {section.drafted && section.content.ai ? (
        <>
          <p className="status info">
            Drafted by the AI assistant ({section.content.ai.provider}, {section.content.ai.model})
            from the facts below; every figure was checked against them. The author reads it,
            changes what needs changing and saves it before review.
          </p>
          <details>
            <summary>The facts each sentence uses</summary>
            <ol>
              {section.content.ai.sentences.map((x, i) => (
                <li key={i}>
                  {x.text} <span className="hint">({x.factIds.join(', ')})</span>
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : section.drafted ? (
        <p className="status info">
          Drafted from the facts. The author reads it, changes what needs changing and saves it
          before review.
        </p>
      ) : section.editedByName ? (
        <p className="hint">
          Written by {section.editedByName}
          {section.editedAt ? `, ${fmt(section.editedAt)}` : ''}.
        </p>
      ) : null}
      {editable ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(text);
          }}
        >
          <Field
            label={section.title}
            hint={`${text.length.toLocaleString('en-US')} of 5,000 characters.`}
          >
            {({ id: fid, describedBy }) => (
              <textarea
                id={fid}
                aria-describedby={describedBy}
                rows={section.kind === 'narrative' ? 8 : 4}
                maxLength={5000}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
          <div className="toolbar">
            <button type="submit">Save {section.title.toLowerCase()}</button>
            {onAiDraft ? (
              <button type="button" onClick={onAiDraft}>
                Draft the {section.title.toLowerCase()} with the AI assistant
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="report-text">{section.content.text || 'Nothing written.'}</p>
      )}
    </section>
  );
}

function FactSection({ section }: { section: Section }) {
  const id = `sec-${section.key}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{section.title}</h2>
      <DataTable
        caption={section.title}
        rows={section.content.rows ?? []}
        rowKey={(r) => r.key}
        columns={[
          { key: 'label', header: 'Figure', render: (r) => r.label },
          { key: 'value', header: 'Value', render: (r) => value(r.value) },
          { key: 'detail', header: 'Detail', render: (r) => r.detail ?? '' },
        ]}
      />
      {section.content.note ? <p>{section.content.note}</p> : null}
      {section.definition ? (
        <p className="hint">
          Definition {section.definition.key}, version {section.definition.version}:{' '}
          {section.definition.text}
          {section.recordCount
            ? ` Based on ${section.recordCount.toLocaleString('en-US')} records.`
            : ''}
        </p>
      ) : null}
    </section>
  );
}

export function OfficialReportScreen({
  id,
  navigate,
}: {
  id: string;
  navigate: (to: string) => void;
}) {
  const me = useMe();
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | undefined>();
  const [withdrawReason, setWithdrawReason] = useState('');

  const reload = useCallback(() => {
    api<Report>(`/official-reports/${id}`)
      .then((x) => {
        setR(x);
        setError(null);
      })
      .catch((e: unknown) => setError(describeFailure(e)));
  }, [id]);
  useEffect(reload, [reload]);

  const act = async (fn: () => Promise<Report>, done: string) => {
    setMsg(null);
    try {
      const next = await fn();
      setR(next);
      setMsg({ kind: 'success', text: done });
      return next;
    } catch (err) {
      const conflict =
        err instanceof ApiFailure && err.status === 409 && err.envelope.code === 'version_conflict';
      if (err instanceof ApiFailure && err.envelope.code === 'cancelled') {
        setMsg({ kind: 'info', text: 'Cancelled; nothing was changed.' });
        return null;
      }
      setMsg({
        kind: 'error',
        text: conflict
          ? 'Someone changed this report while you were reading it. It now shows their version; check it and try again.'
          : describeFailure(err),
      });
      if (conflict) reload();
      return null;
    }
  };

  if (error) return <Status kind="error">{error}</Status>;
  if (!r) return <p role="status">Loading the report…</p>;
  const can = (a: string) => me?.actions.includes(a) ?? false;
  const author = me?.accountId === r.authorId;
  const open = r.state === 'draft' || r.state === 'reviewed';
  const editable = open && can('official_report.draft');
  const drafted = r.sections.filter((s) => s.drafted);
  const v = { version: r.version };

  return (
    <article aria-labelledby="report-h">
      <p>
        <a
          href="/console/official-reports"
          onClick={(e) => {
            e.preventDefault();
            navigate('/console/official-reports');
          }}
        >
          All official reports
        </a>
      </p>
      <h1 id="report-h">{r.title}</h1>
      <dl className="meta">
        <dt>State</dt>
        <dd>{STATE_TEXT[r.state]}</dd>
        <dt>Period</dt>
        <dd>
          {inZone(r.periodFrom, r.timeZone)} to {inZone(r.periodTo, r.timeZone)}
        </dd>
        <dt>Records up to</dt>
        <dd>{inZone(r.cutoff, r.timeZone)}</dd>
        <dt>Facts computed</dt>
        <dd>{fmt(r.factsAt)}</dd>
        <dt>Author</dt>
        <dd>{r.authorName ?? '—'}</dd>
        <dt>Reviewed by</dt>
        <dd>{r.reviewerName ? `${r.reviewerName}, ${fmt(r.reviewedAt)}` : 'Not yet reviewed'}</dd>
        {r.issuedAt ? (
          <>
            <dt>Issued by</dt>
            <dd>
              {r.issuerName ?? '—'}, {fmt(r.issuedAt)}
            </dd>
          </>
        ) : null}
      </dl>
      {r.amends ? (
        <p>
          This is an amendment.{' '}
          <a
            href={`/console/official-reports/${r.amends}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/console/official-reports/${r.amends}`);
            }}
          >
            Open the report it corrects
          </a>
          .
        </p>
      ) : null}
      {r.amendedBy ? (
        <p>
          <a
            href={`/console/official-reports/${r.amendedBy}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/console/official-reports/${r.amendedBy}`);
            }}
          >
            Open the amendment of this report
          </a>
          .
        </p>
      ) : null}
      {r.reviewNote && r.state === 'draft' ? (
        <Status kind="info">Returned by the reviewer: {r.reviewNote}</Status>
      ) : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}

      {r.snapshot ? (
        <section aria-labelledby="snap-h">
          <h2 id="snap-h">Issued copy</h2>
          <p>
            Frozen when issued, exactly as reviewed. Content hash (SHA-256):{' '}
            <code className="hash">{r.snapshot.contentHash}</code>. Reason given:{' '}
            {r.snapshot.reason}
          </p>
          <p>
            {r.snapshot.lock
              ? `Locked copy written ${fmt(r.snapshot.lock.writtenAt)}; nobody can change or delete it before ${fmt(r.snapshot.lock.retainUntil)} (${r.snapshot.lock.lockMode.toLowerCase()} lock).`
              : 'The locked copy is being written; reload in a minute.'}
          </p>
        </section>
      ) : null}
      {r.snapshot && can('official_report.export') ? <ReportExports reportId={r.id} /> : null}

      <section aria-labelledby="steps-h">
        <h2 id="steps-h">Next steps</h2>
        {editable ? (
          <div className="toolbar">
            <button
              type="button"
              onClick={() =>
                void act(
                  () => api<Report>(`/official-reports/${r.id}/refresh`, { method: 'POST', ...v }),
                  r.state === 'reviewed'
                    ? 'Facts refreshed from the records. The report needs review again.'
                    : 'Facts refreshed from the records.',
                )
              }
            >
              Refresh the facts
            </button>
          </div>
        ) : null}
        {editable && r.partnerRollup ? (
          <PartnerRollupChooser
            key={`rollup-${r.version}`}
            id="report-rollup"
            value={r.partnerRollup}
            organizations={r.partnerOrganizations ?? []}
            statement={r.sections.find((x) => x.key === 'partners')?.content.note ?? null}
            editable
            onSave={async (partnerRollup) =>
              !!(await act(
                () =>
                  api<Report>(`/official-reports/${r.id}/partner-rollup`, {
                    body: { partnerRollup },
                    ...v,
                  }),
                r.state === 'reviewed'
                  ? 'Partner counts choice saved and the facts recomputed. The report needs review again.'
                  : 'Partner counts choice saved and the facts recomputed.',
              ))
            }
          />
        ) : null}
        {r.state === 'draft' && can('official_report.review') && !author ? (
          drafted.length ? (
            <p>
              {drafted.map((s) => s.title).join(', ')} is still as drafted from the data; the author
              saves it before it can be approved. You can return the report with a note.
            </p>
          ) : (
            <div className="toolbar">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  void act(
                    () =>
                      api<Report>(`/official-reports/${r.id}/review`, {
                        body: { decision: 'approve' },
                        ...v,
                      }),
                    'Approved. Someone other than the author can issue it now.',
                  )
                }
              >
                Approve the report
              </button>
            </div>
          )
        ) : null}
        {r.state === 'draft' && can('official_report.review') && !author ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!note.trim()) {
                setNoteError('Say what needs to change.');
                return;
              }
              setNoteError(undefined);
              void act(
                () =>
                  api<Report>(`/official-reports/${r.id}/review`, {
                    body: { decision: 'return', note: note.trim() },
                    ...v,
                  }),
                'Returned to the author with your note.',
              ).then((x) => x && setNote(''));
            }}
          >
            <Field label="Note for the author" {...(noteError ? { error: noteError } : {})}>
              {({ id: fid, describedBy, invalid }) => (
                <textarea
                  id={fid}
                  rows={3}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
            <div className="toolbar">
              <button type="submit">Return with this note</button>
            </div>
          </form>
        ) : null}
        {r.state === 'draft' && author ? <p>Someone other than you reviews this report.</p> : null}
        {r.state === 'reviewed' && can('official_report.issue') && !author ? (
          <div className="toolbar">
            <button
              type="button"
              className="primary"
              onClick={() =>
                void act(
                  () => api<Report>(`/official-reports/${r.id}/issue`, { method: 'POST', ...v }),
                  'Issued. The report is frozen; correct it only by an amendment.',
                )
              }
            >
              Issue the report
            </button>
          </div>
        ) : null}
        {r.state === 'superseded' || r.state === 'withdrawn' ? (
          <p>No further steps: this report is {STATE_TEXT[r.state].toLowerCase()}.</p>
        ) : null}
        {r.state === 'reviewed' && author ? (
          <p>Reviewed. Someone other than you issues it.</p>
        ) : null}
        {r.state === 'issued' && !r.amendedBy && can('official_report.draft') ? (
          <div className="toolbar">
            <button
              type="button"
              onClick={() =>
                void act(
                  () =>
                    api<Report>(`/official-reports/${r.id}/amend`, {
                      body: { clientUuid: crypto.randomUUID() },
                    }),
                  'Amendment drafted from the records as they are now.',
                ).then((x) => x && navigate(`/console/official-reports/${x.id}`))
              }
            >
              Draft an amendment
            </button>
          </div>
        ) : null}
        {editable ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (withdrawReason.trim().length < 3) return;
              void act(
                () =>
                  api<Report>(`/official-reports/${r.id}/withdraw`, {
                    body: { reason: withdrawReason.trim() },
                    ...v,
                  }),
                'Withdrawn.',
              );
            }}
          >
            <Field label="Reason to withdraw this draft">
              {({ id: fid }) => (
                <input
                  id={fid}
                  minLength={3}
                  maxLength={500}
                  value={withdrawReason}
                  onChange={(e) => setWithdrawReason(e.target.value)}
                />
              )}
            </Field>
            <div className="toolbar">
              <button type="submit" disabled={withdrawReason.trim().length < 3}>
                Withdraw the draft
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {r.sections.map((s) =>
        s.kind === 'fact' ? (
          <FactSection key={`${s.key}-${r.version}`} section={s} />
        ) : (
          <TextSection
            key={`${s.key}-${r.version}`}
            section={s}
            editable={editable}
            onSave={(text) =>
              void act(
                () =>
                  api<Report>(`/official-reports/${r.id}/sections/${s.key}`, {
                    method: 'PUT',
                    body: { text },
                    ...v,
                  }),
                r.state === 'reviewed'
                  ? `${s.title} saved. The report needs review again.`
                  : `${s.title} saved.`,
              )
            }
            {...(s.key === 'summary'
              ? {
                  onAiDraft: () =>
                    void act(
                      () =>
                        api<Report>(`/official-reports/${r.id}/sections/summary/ai-draft`, {
                          body: { language: 'en' },
                          ...v,
                        }),
                      'Summary drafted by the AI assistant from the facts. Read it and save it before review.',
                    ),
                }
              : {})}
          />
        ),
      )}
      {open ? <ChangesPanel eventId={r.eventId} /> : null}
    </article>
  );
}

/** F15: an issued report as PDF or CSV, always from its frozen copy (RULE-10). */
function ReportExports({ reportId }: { reportId: string }) {
  const { rows, error, reload } = useExports(`/official-reports/${reportId}/exports`);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const ask = async (format: 'pdf' | 'csv') => {
    setMsg(null);
    try {
      await api(`/official-reports/${reportId}/exports`, {
        body: { clientUuid: crypto.randomUUID(), format },
      });
      setMsg({ kind: 'success', text: `The ${format.toUpperCase()} is being made.` });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  return (
    <section aria-labelledby="exports-h">
      <h2 id="exports-h">Exports</h2>
      <p>Made from the issued copy, so the file always matches what was issued.</p>
      <div className="toolbar">
        <button type="button" onClick={() => void ask('pdf')}>
          Export as PDF
        </button>
        <button type="button" onClick={() => void ask('csv')}>
          Export as CSV
        </button>
      </div>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {rows ? (
        <DataTable
          caption="Exports of this report"
          rows={rows}
          rowKey={(x) => x.id}
          empty="No export yet."
          columns={[
            { key: 'at', header: 'Asked for', render: (x) => fmt(x.createdAt) },
            { key: 'format', header: 'Format', render: (x) => x.format.toUpperCase() },
            {
              key: 'file',
              header: 'File',
              render: (x) => <ExportFile row={x} label={x.format.toUpperCase()} />,
            },
          ]}
        />
      ) : null}
    </section>
  );
}

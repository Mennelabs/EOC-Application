/**
 * Review workspace (plan console screens 1–3; CON-05, CON-10, PHO-07, PHO-14,
 * BRD:FR-12.01–12.06, DCL:DEC-02/03, EQ-08, SEC-18): the queue ordered by
 * need signals first, the report with what the role may see, photos,
 * versions and decisions, and the decision, verification and FEMA-degree
 * forms. Every consequential action asks for confirmation and a reason
 * through the API (RULE-14).
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  hazardsForEvent,
  summary,
  text,
  type QuestionGraph,
  type Answers,
  type SessionContext,
  type SummarySection,
} from '@cg/intake';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';
import { DEGREES, FEMA_MATRIX, draftDegreeReason, matrixColumn } from './fema-matrix.ts';

interface Flag {
  kind: string;
  reason: string;
  reportId?: string;
  photoId?: string;
  at: string;
}

interface Summary {
  id: string;
  version: number;
  referenceCode: string;
  eventId: string | null;
  channelOfOrigin: string;
  relationship: string;
  reviewState: string;
  verificationLevel: string;
  femaDegree: string | null;
  isPrimaryResidence: boolean | null;
  preExistingDamage: boolean | null;
  needSignals: Record<string, boolean>;
  flags: Flag[];
  dangerFlag: boolean;
  toldToCall911At: string | null;
  submittedAt: string;
  withdrawnAt: string | null;
  homeType: string | null;
  city: string | null;
  postal: string | null;
  aiAssisted: boolean;
}

interface Detail extends Summary {
  executionId: string;
  graphKey: string;
  graphVersion: number;
  channelsUsed: string[];
  duplicateOf: string | null;
  supersedes: string | null;
  answers: Record<string, unknown>;
  originalLang: string | null;
  translationProvider: string | null;
  reporter: {
    kind: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    preferred: string | null;
    smsOptIn: boolean;
    language: string;
  } | null;
  subjectName: string | null;
  location: {
    line1: string | null;
    unit: string | null;
    city: string | null;
    state: string | null;
    postal: string | null;
    landmark: string | null;
    note: string | null;
    noFixedAddress: boolean;
    precision: string;
  } | null;
  ownWords: string | null;
  translation: string | null;
  household: Record<string, unknown> | null;
  accessNeeds: Record<string, unknown> | null;
  hidden: string[];
  needs: { id: string; category: string; detail: string | null; status: string }[];
  consent: { orgType: string; granted: boolean }[];
  decisions: {
    id: string;
    reportVersion: number;
    reviewerAccountId: string;
    decision: string;
    reason: string;
    createdAt: string;
  }[];
  openCorrections: {
    id: string;
    questions: unknown;
    message: string | null;
    sentVia: string | null;
    requestedAt: string;
  }[];
  versions: number;
  reReview: boolean;
}

interface Photo {
  id: string;
  shot: string;
  source: string;
  status: string;
  blurStatus: string;
  width: number | null;
  height: number | null;
  uploadedAt: string | null;
  suggestedTakenAt: string | null;
  reviewUrl: string | null;
  thumbUrl: string | null;
  restricted: boolean;
}

interface EventRow {
  id: string;
  name: string;
  hazardType: string;
  status: string;
}

const STATE_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  under_review: 'Under review',
  needs_information: 'Needs information',
  approved: 'Approved',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
  superseded: 'Superseded',
};
const VERIFICATION_LABEL: Record<string, string> = {
  self_reported: 'Self-reported',
  desktop_verified: 'Desktop-verified',
  field_verified: 'Field-verified',
  cannot_verify: 'Cannot verify',
};
const SIGNAL_LABEL: Record<string, string> = {
  unsafe: 'someone unsafe',
  no_shelter: 'no shelter',
  medical: 'medical need',
  displaced: 'displaced',
};
const FLAG_LABEL: Record<string, string> = {
  possible_duplicate: 'possible duplicate',
  duplicate_photo: 'same photo as another report',
  near_duplicate_photo: 'a photo that looks the same as one on another report',
  verify_suggested: 'verify before acting',
  ai_assisted: 'answers drafted from the resident’s words',
};

function signals(s: Record<string, boolean>): string {
  const on = Object.entries(s)
    .filter(([, v]) => v)
    .map(([k]) => SIGNAL_LABEL[k] ?? k);
  return on.length ? on.join(', ') : '—';
}

const graphCache = new Map<string, Promise<QuestionGraph>>();
function loadGraph(key: string, version: number): Promise<QuestionGraph> {
  const k = `${key}@${version}`;
  let p = graphCache.get(k);
  if (!p) {
    p = api<{ graph: QuestionGraph }>(`/intake-graphs/${key}/${version}`).then((r) => r.graph);
    graphCache.set(k, p);
  }
  return p;
}

// ------------------------------------------------------------------ queue

export function ReviewQueueScreen({ navigate }: { navigate: (to: string) => void }) {
  const events = useList<EventRow>('/events');
  const [filters, setFilters] = useState({
    eventId: '',
    state: '',
    verification: '',
    channel: '',
    flagged: false,
    danger: false,
    reference: '',
  });
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) query.set(k, String(v));
  query.set('limit', '200');
  const { rows, error, reload } = useList<Summary>(`/reports?${query.toString()}`);
  return (
    <section aria-labelledby="queue-h">
      <h1 id="queue-h">Review queue</h1>
      <p>
        People first: reports with someone unsafe, no shelter or a medical need come first (PHO-14).
        Where the county has switched it on, the AI severity suggestion from the photos comes
        second, only among reports with the same needs; then the oldest waiting. It never moves a
        report ahead of people's needs and never sets a degree (PHO-12).
      </p>
      <form
        className="form-grid"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          reload();
        }}
      >
        <Field label="Event">
          {({ id }) => (
            <select
              id={id}
              value={filters.eventId}
              onChange={(e) => setFilters({ ...filters, eventId: e.target.value })}
            >
              <option value="">All events</option>
              {(events.rows ?? []).map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="State">
          {({ id }) => (
            <select
              id={id}
              value={filters.state}
              onChange={(e) => setFilters({ ...filters, state: e.target.value })}
            >
              <option value="">Any</option>
              {Object.entries(STATE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Verification">
          {({ id }) => (
            <select
              id={id}
              value={filters.verification}
              onChange={(e) => setFilters({ ...filters, verification: e.target.value })}
            >
              <option value="">Any</option>
              {Object.entries(VERIFICATION_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Channel">
          {({ id }) => (
            <select
              id={id}
              value={filters.channel}
              onChange={(e) => setFilters({ ...filters, channel: e.target.value })}
            >
              <option value="">Any</option>
              {['web', 'sms', 'voice', 'assisted'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Reference number">
          {({ id }) => (
            <input
              id={id}
              value={filters.reference}
              onChange={(e) => setFilters({ ...filters, reference: e.target.value })}
              placeholder="KXMR-4827"
            />
          )}
        </Field>
        <div className="toolbar">
          <label>
            <input
              type="checkbox"
              checked={filters.flagged}
              onChange={(e) => setFilters({ ...filters, flagged: e.target.checked })}
            />{' '}
            Flagged only
          </label>
          <label>
            <input
              type="checkbox"
              checked={filters.danger}
              onChange={(e) => setFilters({ ...filters, danger: e.target.checked })}
            />{' '}
            Danger flags only
          </label>
          <button type="submit">Apply</button>
        </div>
      </form>
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption={`Reports (${rows?.length ?? 0})`}
        rows={rows ?? []}
        rowKey={(r) => r.id}
        empty="No reports match."
        columns={[
          {
            key: 'ref',
            header: 'Reference',
            render: (r) => (
              <a
                href={`/console/reports/${r.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/console/reports/${r.id}`);
                }}
              >
                {r.referenceCode}
              </a>
            ),
          },
          { key: 'signals', header: 'Need signals', render: (r) => signals(r.needSignals) },
          {
            key: 'danger',
            header: 'Danger',
            render: (r) =>
              r.dangerFlag
                ? `Not dispatched — told to call 911 ${r.toldToCall911At ? fmt(r.toldToCall911At) : ''}`
                : '—',
          },
          {
            key: 'state',
            header: 'State',
            render: (r) => STATE_LABEL[r.reviewState] ?? r.reviewState,
          },
          {
            key: 'verification',
            header: 'Verification',
            render: (r) => VERIFICATION_LABEL[r.verificationLevel] ?? r.verificationLevel,
          },
          { key: 'degree', header: 'Degree', render: (r) => r.femaDegree ?? '—' },
          {
            key: 'home',
            header: 'Home',
            render: (r) => [r.homeType, r.city, r.postal].filter(Boolean).join(' · ') || '—',
          },
          { key: 'channel', header: 'Channel', render: (r) => r.channelOfOrigin },
          {
            key: 'flags',
            header: 'Flags',
            render: (r) =>
              r.flags.length ? r.flags.map((f) => FLAG_LABEL[f.kind] ?? f.kind).join('; ') : '—',
          },
          { key: 'submitted', header: 'Submitted', render: (r) => fmt(r.submittedAt) },
        ]}
      />
    </section>
  );
}

// ----------------------------------------------------------------- detail

export function ReportDetailScreen({
  id,
  navigate,
}: {
  id: string;
  navigate: (to: string) => void;
}) {
  const [report, setReport] = useState<Detail | null>(null);
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [graph, setGraph] = useState<QuestionGraph | null>(null);
  const [event, setEvent] = useState<EventRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let live = true;
    api<Detail>(`/reports/${id}`)
      .then(async (r) => {
        if (!live) return;
        setReport(r);
        setError(null);
        const [g, ev, ph] = await Promise.all([
          loadGraph(r.graphKey, r.graphVersion).catch(() => null),
          r.eventId
            ? api<EventRow>(`/events/${r.eventId}`).catch(() => null)
            : Promise.resolve(null),
          api<Photo[]>(`/reports/${id}/photos`).catch(() => null),
        ]);
        if (!live) return;
        setGraph(g);
        setEvent(ev);
        setPhotos(ph);
      })
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [id, tick]);

  // FR-00.05: the next step must carry the version this one produced, so "Done" shows only once
  // the changed report is on screen; acting on the old version would be refused as a conflict.
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setReport(await api<Detail>(`/reports/${id}`));
      setMsg(ok);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
      reload();
    }
  };

  if (error) return <Status kind="error">{error}</Status>;
  if (!report) return <p role="status">Loading the report…</p>;

  const ctx: SessionContext = {
    hazards: hazardsForEvent(event?.hazardType ?? 'other'),
    channel: report.channelOfOrigin as SessionContext['channel'],
    ...(report.relationship
      ? { relationship: report.relationship as NonNullable<SessionContext['relationship']> }
      : {}),
  };
  const sections = graph
    ? summary(graph, ctx, report.answers as Answers, 'en', {
        unknown: 'Unknown',
        skipped: 'Skipped',
      })
    : [];
  const afterPrompt = (qid: string) => {
    const q = graph?.afterSubmission.find((n) => n.id === qid);
    return q ? text(q.prompt, 'en') : qid;
  };
  const renderAfter = (value: unknown) => {
    const v = value as { kind?: string; value?: unknown };
    if (v?.kind === 'unknown') return 'Unknown';
    if (v?.kind === 'skipped') return 'Skipped';
    return Array.isArray(v?.value) ? v.value.join(', ') : String(v?.value ?? '');
  };
  const needLabel = (cat: string) => {
    const c = graph?.needCategories.find((n) => n.value === cat);
    return c ? text(c.label, 'en') : cat;
  };
  const orgLabel = (t: string) => {
    const o = graph?.consentOrgTypes.find((c) => c.value === t);
    return o ? text(o.label, 'en') : t;
  };

  return (
    <section aria-labelledby="report-h">
      <Toolbar>
        <button type="button" className="link" onClick={() => navigate('/console/reports')}>
          ← Review queue
        </button>
      </Toolbar>
      <h1 id="report-h">Report {report.referenceCode}</h1>
      {report.dangerFlag ? (
        <Status kind="error">
          Not dispatched — the resident said someone was in danger and was told to call 911
          {report.toldToCall911At ? ` at ${fmt(report.toldToCall911At)}` : ''} (CON-10). Awareness
          only.
        </Status>
      ) : null}
      {report.withdrawnAt ? (
        <Status kind="info">Withdrawn by the resident on {fmt(report.withdrawnAt)}.</Status>
      ) : null}
      {report.reReview ? (
        <Status kind="info">
          Changed after approval: review again before counting it (BRD:FR-12.05).
        </Status>
      ) : null}
      {msg ? <Status kind={msg.startsWith('Done') ? 'success' : 'info'}>{msg}</Status> : null}
      <dl className="meta">
        <dt>State</dt>
        <dd>{STATE_LABEL[report.reviewState] ?? report.reviewState}</dd>
        <dt>Verification</dt>
        <dd>{VERIFICATION_LABEL[report.verificationLevel] ?? report.verificationLevel}</dd>
        <dt>FEMA degree</dt>
        <dd>{report.femaDegree ?? 'not set'}</dd>
        <dt>Submitted</dt>
        <dd>
          {fmt(report.submittedAt)} via {report.channelOfOrigin}
        </dd>
        <dt>Reporting as</dt>
        <dd>
          {report.relationship}
          {report.aiAssisted
            ? ' · some answers drafted from the resident’s words and confirmed'
            : ''}
        </dd>
        <dt>Event</dt>
        <dd>{event?.name ?? '—'}</dd>
        <dt>Versions</dt>
        <dd>
          {report.versions + 1} (current v{report.version})
        </dd>
      </dl>
      {report.flags.length ? (
        <section aria-labelledby="flags-h">
          <h2 id="flags-h">For your attention</h2>
          <ul>
            {report.flags.map((f, i) => (
              <li key={i}>
                {FLAG_LABEL[f.kind] ?? f.kind}: {f.reason}{' '}
                {f.reportId ? (
                  <a
                    href={`/console/reports/${f.reportId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/console/reports/${f.reportId}`);
                    }}
                  >
                    open the other report
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="people-h">
        <h2 id="people-h">People and place</h2>
        {report.reporter ? (
          <dl className="meta">
            <dt>
              {report.reporter.kind === 'resident'
                ? 'Resident'
                : `Reporter (${report.reporter.kind})`}
            </dt>
            <dd>
              {report.reporter.name ?? '—'} · {report.reporter.phone ?? ''}{' '}
              {report.reporter.email ?? ''} · prefers {report.reporter.preferred ?? '—'} · texts{' '}
              {report.reporter.smsOptIn ? 'allowed' : 'not allowed'} · {report.reporter.language}
            </dd>
            {report.subjectName ? (
              <>
                <dt>Affected person</dt>
                <dd>{report.subjectName}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="hint">Contact details are not shown to your role.</p>
        )}
        {report.location ? (
          <p>
            {report.location.noFixedAddress ? 'No fixed address. ' : ''}
            {[
              report.location.line1,
              report.location.unit,
              report.location.city,
              report.location.state,
              report.location.postal,
            ]
              .filter(Boolean)
              .join(', ')}
            {report.location.landmark ? ` · ${report.location.landmark}` : ''}
            {report.location.note ? ` · ${report.location.note}` : ''}{' '}
            <span className="hint">(location {report.location.precision})</span>
          </p>
        ) : (
          <p className="hint">
            The exact location is not shown to your role
            {report.city || report.postal
              ? `; area: ${[report.city, report.postal].filter(Boolean).join(' ')}`
              : ''}
            .
          </p>
        )}
      </section>

      <section aria-labelledby="answers-h">
        <h2 id="answers-h">Answers</h2>
        {sections.map((s) => (
          <div key={s.section}>
            <h3>{s.title}</h3>
            <dl className="meta">
              {s.items.map((it) => (
                <>
                  <dt key={`${it.id}-t`}>{it.prompt}</dt>
                  <dd key={`${it.id}-d`}>
                    {it.answer}
                    {it.state !== 'answered' ? ` (${it.state})` : ''}
                  </dd>
                </>
              ))}
            </dl>
          </div>
        ))}
        {!graph ? (
          <p className="hint">
            The question graph for this report could not be loaded; raw answers:{' '}
            {JSON.stringify(report.answers)}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="words-h">
        <h2 id="words-h">In the resident’s own words</h2>
        {report.ownWords !== null ? (
          <>
            <blockquote lang={report.originalLang ?? undefined}>
              {report.ownWords || '—'}
            </blockquote>
            {report.translation ? (
              <p>
                <strong>Machine translation ({report.translationProvider})</strong> — the original
                above is the record (EQ-08): {report.translation}
              </p>
            ) : report.ownWords ? (
              <button
                type="button"
                onClick={() =>
                  void run(
                    () => api(`/reports/${id}/translate`, { body: { to: 'en' } }),
                    'Done: translated; the original is kept.',
                  )
                }
              >
                Translate to English (labelled machine translation)
              </button>
            ) : null}
          </>
        ) : (
          <p className="hint">Free text is not shown to your role.</p>
        )}
      </section>

      <section aria-labelledby="needs-h">
        <h2 id="needs-h">Needs and sharing</h2>
        <p>
          Help asked for:{' '}
          {report.needs.length
            ? report.needs.map((n) => `${needLabel(n.category)} (${n.status})`).join(', ')
            : 'none'}
          . Asking never changes the damage report (NED-01).
        </p>
        <p>
          May see the request:{' '}
          {report.consent
            .filter((c) => c.granted)
            .map((c) => orgLabel(c.orgType))
            .join(', ') || 'no partner group (default)'}
          .
        </p>
        {report.household ? (
          <dl className="meta">
            {Object.entries(report.household).map(([k, v]) => (
              <>
                <dt key={`${k}-t`}>{afterPrompt(k)}</dt>
                <dd key={`${k}-d`}>{renderAfter(v)}</dd>
              </>
            ))}
          </dl>
        ) : null}
        {report.accessNeeds ? (
          <dl className="meta">
            {Object.entries(report.accessNeeds).map(([k, v]) => (
              <>
                <dt key={`${k}-t`}>{afterPrompt(k)}</dt>
                <dd key={`${k}-d`}>{renderAfter(v)}</dd>
              </>
            ))}
          </dl>
        ) : report.hidden.includes('accessNeeds') ? (
          <p className="hint">
            Access and functional needs answers are shown only to qualified roles.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="photos-h">
        <h2 id="photos-h">Photos</h2>
        {photos === null ? (
          <p className="hint">Photos are not shown to your role.</p>
        ) : photos.length === 0 ? (
          <p>
            No photos. A report without photos is valid and goes to field verification (PHO-04).
          </p>
        ) : (
          <ul className="photo-grid">
            {photos.map((p) => (
              <li key={p.id}>
                {p.reviewUrl ? (
                  <a href={p.reviewUrl} target="_blank" rel="noopener noreferrer">
                    <img
                      src={p.thumbUrl ?? p.reviewUrl}
                      alt={`${p.shot} photo, ${p.width ?? '?'} by ${p.height ?? '?'} pixels`}
                    />
                  </a>
                ) : (
                  <p className="hint">
                    {p.shot}:{' '}
                    {p.status === 'processed'
                      ? 'restricted until faces, plates and documents can be blurred (no detector yet, PHO-07)'
                      : p.status}
                  </p>
                )}
                <p className="hint">
                  {p.shot} · {p.source} · {p.uploadedAt ? fmt(p.uploadedAt) : ''}
                  {p.suggestedTakenAt
                    ? ` · taken ${fmt(p.suggestedTakenAt)} (from the picture)`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Decisions report={report} run={run} sections={sections} photoCount={photos?.length ?? 0} />

      <section aria-labelledby="history-h">
        <h2 id="history-h">Decisions</h2>
        {report.decisions.length === 0 ? (
          <p>None yet.</p>
        ) : (
          <ul>
            {report.decisions.map((d) => (
              <li key={d.id}>
                {fmt(d.createdAt)} · {d.decision} (v{d.reportVersion}) — {d.reason}
              </li>
            ))}
          </ul>
        )}
        {report.openCorrections.length ? (
          <>
            <h3>Waiting on the resident</h3>
            <ul>
              {report.openCorrections.map((c) => (
                <li key={c.id}>
                  {fmt(c.requestedAt)} · {c.message ?? JSON.stringify(c.questions)} · sent via{' '}
                  {c.sentVia ?? 'pending'}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </section>
  );
}

/** The questions whose answers describe the damage itself, in the order a reviewer reads them. */
const DAMAGE_FACTS = [
  'home_type',
  'cause',
  'damage_types',
  'roof_state',
  'water_depth',
  'habitable',
  'tonight',
  'utilities_out',
  'access',
  'pre_existing',
];

function Decisions({
  report,
  run,
  sections,
  photoCount,
}: {
  report: Detail;
  run: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
  sections: SummarySection[];
  photoCount: number;
}) {
  const [decision, setDecision] = useState('approve');
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const [question, setQuestion] = useState('');
  const [level, setLevel] = useState(report.verificationLevel);
  const [levelReason, setLevelReason] = useState('');
  const [degree, setDegree] = useState(report.femaDegree ?? 'affected');
  const [degreeReason, setDegreeReason] = useState('');
  const column = matrixColumn(report.homeType);
  const canDecide = !report.withdrawnAt && !['superseded'].includes(report.reviewState);
  return (
    <section aria-labelledby="decide-h" className="panel">
      <h2 id="decide-h">Decide</h2>
      <p>
        Decisions are recorded with your name, the time, the reason and the record version
        (BRD:FR-12.02). You cannot approve a report you entered yourself (FR-12.04).
      </p>
      {report.reviewState === 'submitted' ? (
        <Toolbar>
          <button
            type="button"
            onClick={() =>
              void run(
                () =>
                  api(`/reports/${report.id}/claim`, {
                    method: 'POST',
                    version: report.version,
                    idempotent: false,
                  }),
                'Done: under review.',
              )
            }
          >
            Start review
          </button>
        </Toolbar>
      ) : null}
      {canDecide ? (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                api(`/reports/${report.id}/decisions`, {
                  method: 'POST',
                  version: report.version,
                  idempotent: false,
                  body: {
                    decision,
                    reason,
                    ...(decision === 'duplicate' ? { duplicateOf: other } : {}),
                    ...(decision === 'supersede' ? { supersedes: other } : {}),
                    ...(decision === 'needs_information'
                      ? { message: question, questions: [] }
                      : {}),
                  },
                }),
              `Done: ${decision}.`,
            ).then(() => {
              setReason('');
              setQuestion('');
              setOther('');
            });
          }}
        >
          <Field label="Decision">
            {({ id }) => (
              <select id={id} value={decision} onChange={(e) => setDecision(e.target.value)}>
                <option value="approve">Approve</option>
                <option value="reject">Reject</option>
                <option value="needs_information">Needs information (asks the resident)</option>
                <option value="duplicate">Link as duplicate of another report</option>
                <option value="supersede">This report replaces an older one</option>
                <option value="reopen">Reopen for review</option>
              </select>
            )}
          </Field>
          {decision === 'duplicate' || decision === 'supersede' ? (
            <Field label="Other report id" hint="Paste the id from the other report's address">
              {({ id }) => (
                <input id={id} value={other} onChange={(e) => setOther(e.target.value)} required />
              )}
            </Field>
          ) : null}
          {decision === 'needs_information' ? (
            <Field
              label="Question for the resident"
              hint="Plain words; it goes by the channel they chose"
            >
              {({ id }) => (
                <textarea
                  id={id}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  required
                />
              )}
            </Field>
          ) : null}
          <Field label="Reason" hint="Recorded with the decision">
            {({ id }) => (
              <input
                id={id}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                minLength={3}
              />
            )}
          </Field>
          <div className="toolbar">
            <button type="submit" className="primary">
              Record decision
            </button>
          </div>
        </form>
      ) : null}

      <h3>Verification (DEC-03)</h3>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              api(`/reports/${report.id}/verification`, {
                method: 'POST',
                version: report.version,
                idempotent: false,
                body: { level, reason: levelReason },
              }),
            'Done: verification level set.',
          ).then(() => setLevelReason(''));
        }}
      >
        <Field label="Level">
          {({ id }) => (
            <select id={id} value={level} onChange={(e) => setLevel(e.target.value)}>
              {Object.entries(VERIFICATION_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Why">
          {({ id }) => (
            <input
              id={id}
              value={levelReason}
              onChange={(e) => setLevelReason(e.target.value)}
              required
              minLength={3}
            />
          )}
        </Field>
        <div className="toolbar">
          <button type="submit">Set verification</button>
        </div>
      </form>

      <h3>FEMA degree of damage (DEC-02)</h3>
      <p>
        Residents never pick a degree. Read the matrix for a{' '}
        {column === 'manufactured' ? 'manufactured home' : 'conventional home'} and set it from the
        answers and photos.
      </p>
      <table>
        <caption>
          FEMA degree matrix —{' '}
          {column === 'manufactured' ? 'manufactured homes' : 'conventional homes'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Degree</th>
            <th scope="col">Criteria</th>
          </tr>
        </thead>
        <tbody>
          {FEMA_MATRIX.map((row) => (
            <tr key={row.degree}>
              <th scope="row">{row.title}</th>
              <td>{row[column]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <SeveritySuggestion reportId={report.id} />
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              api(`/reports/${report.id}/fema-degree`, {
                method: 'POST',
                version: report.version,
                idempotent: false,
                body: { degree, reason: degreeReason },
              }),
            'Done: degree set.',
          ).then(() => setDegreeReason(''));
        }}
      >
        <Field label="Degree">
          {({ id }) => (
            <select id={id} value={degree} onChange={(e) => setDegree(e.target.value)}>
              {DEGREES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              <option value="no_damage">no damage</option>
              <option value="cannot_tell">cannot tell</option>
            </select>
          )}
        </Field>
        <Field
          label="Why"
          hint={
            'Say what you checked. "Draft from the report" starts it with the matrix criteria, what the resident reported and the photos on file; the degree is yours to pick.'
          }
        >
          {({ id }) => (
            <textarea
              id={id}
              value={degreeReason}
              onChange={(e) => setDegreeReason(e.target.value)}
              required
              minLength={3}
              rows={5}
            />
          )}
        </Field>
        <div className="toolbar">
          <button
            type="button"
            onClick={() =>
              setDegreeReason(
                draftDegreeReason({
                  degree,
                  column,
                  facts: sections
                    .flatMap((sec) => sec.items)
                    .filter((item) => DAMAGE_FACTS.includes(item.id))
                    .map((item) => ({ prompt: item.prompt, answer: item.answer })),
                  photoCount,
                }),
              )
            }
          >
            Draft from the report
          </button>
          <button type="submit">Set degree</button>
        </div>
      </form>
    </section>
  );
}

interface Suggestion {
  label: string;
  degree: string;
  confidence: number;
  visibleFeatures: string[];
  photoCount: number;
  provider: string;
  model: string;
  createdAt: string;
}

/**
 * PHO-09, PHO-10, PHO-11 (as decided 2026-10-15): the AI suggestion from the
 * photos, for the reviewer only, labelled as not verified, with what it rests
 * on. The reviewer sets the degree; the decision records whether they agreed.
 */
function SeveritySuggestion({ reportId }: { reportId: string }) {
  const [s, setS] = useState<Suggestion | null>(null);
  useEffect(() => {
    let live = true;
    api<Suggestion | null>(`/reports/${reportId}/suggestion`)
      .then((r) => live && setS(r))
      .catch(() => live && setS(null));
    return () => {
      live = false;
    };
  }, [reportId]);
  if (!s) return null;
  return (
    <div className="panel" role="region" aria-label={s.label}>
      <h4>{s.label}</h4>
      <p>
        Suggested degree: <strong>{s.degree.replace(/_/g, ' ')}</strong>, confidence{' '}
        {Math.round(s.confidence * 100)}%, from {s.photoCount}{' '}
        {s.photoCount === 1 ? 'photo' : 'photos'} ({s.provider}, {s.model}).
      </p>
      {s.visibleFeatures.length ? (
        <>
          <p>What it rests on:</p>
          <ul>
            {s.visibleFeatures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p>
        A suggestion from the photos only, never shown to the resident. Set the degree yourself from
        the matrix, the answers and the photos; your decision records whether you agreed.
      </p>
    </div>
  );
}

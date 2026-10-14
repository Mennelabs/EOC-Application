/**
 * Missions (layer-4 plan console 2; MIS-01–04, CALL-01, FR-02.01–02.06,
 * FR-03.03, AC-02A/B/C, AC-06A–D, AC-07, RULE-03, RULE-14): the list with
 * filters; staff intake for phone and walk-in requests, saved as a draft
 * with whatever is known or as intake when it can be dispatched; and the
 * detail with its timeline, what still blocks dispatch, assignments, people
 * involved, narratives, priority, the lock, and the consequential steps
 * (cancel, close, reopen, release) through the confirmation dialog.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';

interface Assignment {
  id: string;
  version: number;
  resourceKind: string;
  teamId: string | null;
  personnelId: string | null;
  state: string;
  assignedAt: string;
  dispatchMethod: string | null;
  acknowledgedAt: string | null;
  conflicts: { kind: string; detail: string }[];
}
interface Mission {
  id: string;
  version: number;
  reference: string;
  eventId: string;
  kind: string;
  state: string;
  priority: string;
  urgency: string;
  source: string;
  summary: string | null;
  conditions: string | null;
  caller?: { name?: string; phone?: string } | null;
  callerLanguage: string | null;
  interpreterNeeded: boolean;
  location: {
    line1: string | null;
    city: string | null;
    landmark: string | null;
    usng: string | null;
    position: { lat: number; lon: number } | null;
  } | null;
  locationState: string;
  lock: { by: string; at: string; reason: string | null } | null;
  disposition: string | null;
  dispatchBlockers: string[];
  /** SEC-12: law-enforcement details are held in the CJIS enclave; the console only links there. */
  cjis?: { restricted: true; ref?: string; url?: string; linkedAt?: string } | null;
  createdAt: string;
  closedAt: string | null;
  assignments?: Assignment[];
  timeline?: {
    id: string;
    kind: string;
    fromState: string | null;
    toState: string | null;
    reason: string | null;
    body: string | null;
    narrativeRole: string | null;
    occurredAt: string;
  }[];
}

export const KINDS = [
  'welfare_check',
  'verification_route',
  'cleanup_work_order',
  'delivery',
  'outreach_sweep',
  'site_staffing',
  'search',
  'road_clearance',
  'traffic_control',
  'debris',
  'other',
];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const URGENCIES = ['routine', 'soon', 'now'];
const DISPOSITIONS = [
  'completed',
  'referred',
  'no_action_needed',
  'unable_to_locate',
  'duplicate',
  'transferred',
  'other',
];
const label = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—');

export function MissionsScreen({ navigate }: { navigate: (to: string) => void }) {
  const { events, error: eventsError } = useOpenEvents();
  const [eventId, setEventId] = useState<string | null>(null);
  const currentEvent = eventId ?? events?.[0]?.id ?? null;
  const [state, setState] = useState('');
  const [kind, setKind] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const [rows, setRows] = useState<Mission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!currentEvent) return;
    const q = new URLSearchParams({ eventId: currentEvent, limit: '100' });
    if (state) q.set('state', state);
    if (kind) q.set('kind', kind);
    if (openOnly && !state) q.set('open', 'true');
    let live = true;
    api<Mission[]>(`/missions?${q.toString()}`)
      .then((r) => {
        if (!live) return;
        setRows(r);
        setError(null);
      })
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [currentEvent, state, kind, openOnly, tick]);
  if (eventsError) return <Status kind="error">{eventsError}</Status>;
  return (
    <section aria-labelledby="missions-h">
      <h1 id="missions-h">Missions</h1>
      <Toolbar>
        {events?.length ? (
          <EventPicker events={events} value={currentEvent} onChange={setEventId} />
        ) : null}
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          New request (phone or walk-in)
        </button>
      </Toolbar>
      {creating && currentEvent ? (
        <NewMission
          eventId={currentEvent}
          onCancel={() => setCreating(false)}
          onCreated={(m) => {
            setCreating(false);
            setTick((n) => n + 1);
            navigate(`/console/missions/${m.id}`);
          }}
        />
      ) : null}
      <div className="filters">
        <label>
          State
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any</option>
            {['draft', 'open', 'en_route', 'on_scene', 'cleared', 'closed', 'canceled'].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {label(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="inline" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />{' '}
          Open only
        </label>
      </div>
      {error ? <Status kind="error">{error}</Status> : null}
      {rows ? (
        <DataTable
          caption="Missions"
          rows={rows}
          rowKey={(m) => m.id}
          empty="No missions match."
          columns={[
            {
              key: 'ref',
              header: 'Mission',
              render: (m) => (
                <a
                  href={`/console/missions/${m.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/console/missions/${m.id}`);
                  }}
                >
                  {m.reference}
                </a>
              ),
            },
            { key: 'kind', header: 'Kind', render: (m) => label(m.kind) },
            { key: 'state', header: 'State', render: (m) => label(m.state) },
            { key: 'pri', header: 'Priority', render: (m) => `${m.priority}, ${label(m.urgency)}` },
            { key: 'sum', header: 'Summary', render: (m) => m.summary ?? '—' },
            {
              key: 'cjis',
              header: 'Law enforcement',
              render: (m) => (m.cjis ? 'Restricted: CJIS' : '—'),
            },
            { key: 'at', header: 'Created', render: (m) => fmt(m.createdAt) },
          ]}
        />
      ) : !error ? (
        <p role="status">Loading…</p>
      ) : null}
    </section>
  );
}

/** CALL-01: a call taker writes down what the caller says; the caller's details are restricted. */
function NewMission({
  eventId,
  onCreated,
  onCancel,
}: {
  eventId: string;
  onCreated: (m: Mission) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    kind: 'welfare_check',
    priority: 'normal',
    urgency: 'routine',
    source: 'call',
    summary: '',
    conditions: '',
    callerName: '',
    callerPhone: '',
    callerLanguage: '',
    interpreterNeeded: false,
    line1: '',
    city: '',
    landmark: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string | boolean) => setF((c) => ({ ...c, [k]: v }));
  const save = async (mode: 'draft' | 'intake', e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    try {
      const hasPlace = f.line1.trim() || f.landmark.trim();
      const m = await api<Mission>('/missions', {
        body: {
          eventId,
          kind: f.kind,
          priority: f.priority,
          urgency: f.urgency,
          source: f.source,
          save: mode,
          interpreterNeeded: f.interpreterNeeded,
          ...(f.summary.trim() ? { summary: f.summary.trim() } : {}),
          ...(f.conditions.trim() ? { conditions: f.conditions.trim() } : {}),
          ...(f.callerName.trim() || f.callerPhone.trim()
            ? {
                caller: {
                  ...(f.callerName.trim() ? { name: f.callerName.trim() } : {}),
                  ...(f.callerPhone.trim() ? { phone: f.callerPhone.trim() } : {}),
                },
              }
            : {}),
          ...(f.callerLanguage.trim() ? { callerLanguage: f.callerLanguage.trim() } : {}),
          ...(hasPlace
            ? {
                location: {
                  ...(f.line1.trim() ? { line1: f.line1.trim() } : {}),
                  ...(f.city.trim() ? { city: f.city.trim() } : {}),
                  ...(f.landmark.trim() ? { landmark: f.landmark.trim() } : {}),
                  state: 'manual',
                },
              }
            : {}),
        },
      });
      onCreated(m);
    } catch (err) {
      setError(describeFailure(err));
    }
  };
  const text = (k: keyof typeof f, lbl: string, hint?: string) => (
    <Field label={lbl} {...(hint ? { hint } : {})}>
      {({ id, describedBy }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          value={f[k] as string}
          onChange={(e) => set(k, e.target.value)}
        />
      )}
    </Field>
  );
  const select = (k: keyof typeof f, lbl: string, options: string[]) => (
    <Field label={lbl}>
      {({ id }) => (
        <select id={id} value={f[k] as string} onChange={(e) => set(k, e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {label(o)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
  return (
    <form
      className="panel"
      aria-labelledby="new-mission-h"
      onSubmit={(e) => void save('intake', e)}
    >
      <h2 id="new-mission-h">New request</h2>
      <p className="hint">
        For volunteer and resource help. If anyone is in danger now, transfer the caller to 911.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      <div className="form-grid">
        {select('kind', 'Kind of help', KINDS)}
        {select('source', 'How it came in', ['call', 'walk_in', 'staff'])}
        {select('priority', 'Priority', PRIORITIES)}
        {select('urgency', 'How soon', URGENCIES)}
      </div>
      <Field label="What is needed">
        {({ id }) => (
          <textarea
            id={id}
            rows={3}
            value={f.summary}
            onChange={(e) => set('summary', e.target.value)}
          />
        )}
      </Field>
      <Field label="Conditions on site (optional)" hint="Access, animals, hazards.">
        {({ id, describedBy }) => (
          <textarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            value={f.conditions}
            onChange={(e) => set('conditions', e.target.value)}
          />
        )}
      </Field>
      <fieldset>
        <legend>Where</legend>
        {text('line1', 'Street address')}
        {text('city', 'City')}
        {text(
          'landmark',
          'Landmark when there is no address',
          'For example: blue trailer behind the church on Route 9.',
        )}
      </fieldset>
      <fieldset>
        <legend>Caller (private)</legend>
        {text('callerName', 'Name')}
        {text('callerPhone', 'Phone')}
        {text('callerLanguage', 'Language (optional)', 'For example: es')}
        <label className="inline" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={f.interpreterNeeded}
            onChange={(e) => set('interpreterNeeded', e.target.checked)}
          />{' '}
          Needs an interpreter
        </label>
      </fieldset>
      <div className="actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={() => void save('draft')}>
          Save as draft
        </button>
        <button type="submit" className="primary">
          Save for dispatch
        </button>
      </div>
    </form>
  );
}

/**
 * SEC-12, ADR-0038: the console holds no criminal-justice information. A mission with
 * law-enforcement involvement shows "Restricted: CJIS"; a liaison (mission.cji.open) gets
 * a link that opens the record in the CJIS enclave, on its own address with its own
 * sign-in; mission.cji.link links a mission after a confirmation with a reason.
 */
function CjisPanel({
  mission,
  closed,
  onChanged,
}: {
  mission: Mission;
  closed: boolean;
  onChanged: (notice: string | null, error: string | null) => void;
}) {
  const [canLink, setCanLink] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setCanLink(me.actions.includes('mission.cji.link')))
      .catch(() => live && setCanLink(false));
    return () => {
      live = false;
    };
  }, []);
  const c = mission.cjis;
  if (!c && !(canLink && !closed)) return null;
  return (
    <section aria-labelledby="cjis-h" className="panel">
      <h2 id="cjis-h">Law enforcement (CJIS)</h2>
      {c?.ref ? (
        <>
          <p>
            Law-enforcement details for this mission are held in the CJIS enclave, outside this
            console. Only screened enclave users can see them, after signing in to the enclave.
          </p>
          {c.url ? (
            <p>
              <a href={c.url} target="_blank" rel="noopener noreferrer">
                Open in the CJIS enclave (new tab)
              </a>
            </p>
          ) : (
            <p>The enclave address is not configured on this platform.</p>
          )}
        </>
      ) : c ? (
        <p>
          <strong>Restricted: CJIS.</strong> Law-enforcement details for this mission are held in
          the CJIS enclave.
        </p>
      ) : (
        <>
          <p>No law-enforcement involvement is linked to this mission.</p>
          <button
            type="button"
            onClick={() => {
              api(`/missions/${mission.id}/cji-link`, { method: 'POST' })
                .then(() =>
                  onChanged(
                    'Linked to the CJIS enclave. Record the law-enforcement details there.',
                    null,
                  ),
                )
                .catch((e: unknown) => onChanged(null, describeFailure(e)));
            }}
          >
            Link to the CJIS enclave
          </button>
        </>
      )}
    </section>
  );
}

export function MissionDetailScreen({ id }: { id: string }) {
  const [m, setM] = useState<Mission | null>(null);
  const [people, setPeople] = useState<
    | {
        id: string;
        role: string;
        displayLabel: string | null;
        injury: string | null;
        transport: string | null;
        status: string;
      }[]
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [narrative, setNarrative] = useState({ role: 'dispatcher', body: '' });
  const [closing, setClosing] = useState({ disposition: 'completed', note: '' });
  const [lockReason, setLockReason] = useState('');
  useEffect(() => {
    let live = true;
    api<Mission>(`/missions/${id}`)
      .then((r) => {
        if (!live) return;
        setM(r);
        setError(null);
      })
      .catch((e: unknown) => live && setError(describeFailure(e)));
    api<typeof people>(`/missions/${id}/people`)
      .then((r) => live && setPeople(r))
      .catch(() => live && setPeople(null));
    return () => {
      live = false;
    };
  }, [id, tick]);
  const reload = () => setTick((n) => n + 1);
  const act = async (path: string, body: unknown, done: string, version = true) => {
    if (!m) return;
    setError(null);
    try {
      await api(path, { body, ...(version ? { version: m.version } : {}) });
      setNotice(done);
      reload();
    } catch (e) {
      setError(describeFailure(e));
      reload();
    }
  };
  if (error && !m) return <Status kind="error">{error}</Status>;
  if (!m) return <p role="status">Loading…</p>;
  const closed = m.state === 'closed' || m.state === 'canceled';
  return (
    <section aria-labelledby="mission-h">
      <h1 id="mission-h">
        {m.reference} · {label(m.kind)}
      </h1>
      {error ? <Status kind="error">{error}</Status> : null}
      {notice ? <Status kind="success">{notice}</Status> : null}
      <dl className="meta">
        <dt>State</dt>
        <dd>{label(m.state)}</dd>
        <dt>Priority</dt>
        <dd>
          {m.priority}, {label(m.urgency)}
        </dd>
        <dt>Summary</dt>
        <dd>{m.summary ?? '—'}</dd>
        <dt>Conditions</dt>
        <dd>{m.conditions ?? '—'}</dd>
        <dt>Where</dt>
        <dd>
          {m.location
            ? [m.location.line1, m.location.city, m.location.landmark].filter(Boolean).join(', ') ||
              '—'
            : '—'}
          {m.location?.usng ? ` · USNG ${m.location.usng}` : ''} ({label(m.locationState)})
        </dd>
        {m.caller ? (
          <>
            <dt>Caller (private)</dt>
            <dd>{[m.caller.name, m.caller.phone].filter(Boolean).join(', ') || '—'}</dd>
          </>
        ) : null}
        <dt>Language</dt>
        <dd>
          {m.callerLanguage ?? '—'}
          {m.interpreterNeeded ? ' · interpreter needed' : ''}
        </dd>
        <dt>Lock</dt>
        <dd>
          {m.lock
            ? `Locked ${fmt(m.lock.at)}${m.lock.reason ? `: ${m.lock.reason}` : ''}`
            : 'Not locked'}
        </dd>
      </dl>
      <CjisPanel
        mission={m}
        closed={closed}
        onChanged={(n, e) => {
          setNotice(n);
          setError(e);
          reload();
        }}
      />
      {m.dispatchBlockers.length ? (
        <Status kind="info">
          Before it can be dispatched: {m.dispatchBlockers.map(label).join('; ')}.
        </Status>
      ) : null}
      {!closed ? (
        <div className="panel">
          <h2>Change</h2>
          <div className="filters">
            <label>
              Priority
              <select
                value={m.priority}
                onChange={(e) =>
                  void act(
                    `/missions/${m.id}/priority`,
                    { priority: e.target.value, urgency: m.urgency },
                    'Priority changed.',
                  )
                }
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            {m.state === 'draft' ? (
              <button
                type="button"
                onClick={() => void act(`/missions/${m.id}/transitions`, { to: 'open' }, 'Opened.')}
              >
                Open for dispatch
              </button>
            ) : null}
            {m.lock ? (
              <button
                type="button"
                onClick={() =>
                  void api(`/missions/${m.id}/lock`, { method: 'DELETE' })
                    .then(() => {
                      setNotice('Unlocked.');
                      reload();
                    })
                    .catch((e: unknown) => setError(describeFailure(e)))
                }
              >
                Unlock
              </button>
            ) : (
              <label>
                Lock while you work on it (reason)
                <span style={{ display: 'flex', gap: '0.5rem' }}>
                  <input value={lockReason} onChange={(e) => setLockReason(e.target.value)} />
                  <button
                    type="button"
                    disabled={lockReason.trim().length < 3}
                    onClick={() =>
                      void act(
                        `/missions/${m.id}/lock`,
                        { reason: lockReason.trim() },
                        'Locked.',
                        false,
                      )
                    }
                  >
                    Lock
                  </button>
                </span>
              </label>
            )}
            <button
              type="button"
              onClick={() => void act(`/missions/${m.id}/cancel`, {}, 'Canceled.')}
            >
              Cancel mission…
            </button>
          </div>
          <div className="filters">
            <label>
              Close as
              <select
                value={closing.disposition}
                onChange={(e) => setClosing({ ...closing, disposition: e.target.value })}
              >
                {DISPOSITIONS.map((d) => (
                  <option key={d} value={d}>
                    {label(d)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Closing note
              <input
                value={closing.note}
                onChange={(e) => setClosing({ ...closing, note: e.target.value })}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                void act(
                  `/missions/${m.id}/close`,
                  {
                    disposition: closing.disposition,
                    ...(closing.note.trim() ? { dispositionNote: closing.note.trim() } : {}),
                  },
                  'Closed.',
                )
              }
            >
              Close mission…
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => void act(`/missions/${m.id}/reopen`, {}, 'Reopened.')}>
          Reopen…
        </button>
      )}
      <h2>Assignments</h2>
      <DataTable
        caption="Who holds this mission"
        rows={m.assignments ?? []}
        rowKey={(a) => a.id}
        empty="Nobody yet. Assign from the dispatch board."
        columns={[
          {
            key: 'who',
            header: 'Resource',
            render: (a) => `${a.resourceKind} ${(a.teamId ?? a.personnelId ?? '').slice(0, 8)}`,
          },
          { key: 'state', header: 'State', render: (a) => label(a.state) },
          { key: 'by', header: 'Sent by', render: (a) => label(a.dispatchMethod) },
          {
            key: 'ack',
            header: 'Acknowledged',
            render: (a) => (a.acknowledgedAt ? fmt(a.acknowledgedAt) : 'Not yet'),
          },
          {
            key: 'act',
            header: 'Action',
            render: (a) =>
              a.state === 'released' || a.state === 'cleared' ? (
                '—'
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    void api(`/assignments/${a.id}/release`, { body: {}, version: a.version })
                      .then(() => {
                        setNotice('Released.');
                        reload();
                      })
                      .catch((e: unknown) => setError(describeFailure(e)))
                  }
                >
                  Release…
                </button>
              ),
          },
        ]}
      />
      <h2>People involved</h2>
      {people === null ? (
        <p className="hint">Your role does not show people involved, or none are recorded.</p>
      ) : (
        <DataTable
          caption="People involved"
          rows={people.filter((p) => p.status === 'active')}
          rowKey={(p) => p.id}
          empty="No people recorded."
          columns={[
            { key: 'r', header: 'Role', render: (p) => label(p.role) },
            { key: 'l', header: 'Label', render: (p) => p.displayLabel ?? '—' },
            { key: 'i', header: 'Injury', render: (p) => label(p.injury) },
            { key: 't', header: 'Transport', render: (p) => label(p.transport) },
          ]}
        />
      )}
      <h2>Timeline</h2>
      <ol>
        {(m.timeline ?? []).map((e) => (
          <li key={e.id}>
            {fmt(e.occurredAt)} — {label(e.kind)}
            {e.toState ? `: ${label(e.fromState)} → ${label(e.toState)}` : ''}
            {e.narrativeRole ? ` (${label(e.narrativeRole)})` : ''}
            {e.body ? ` — ${e.body}` : ''}
            {e.reason ? ` — ${e.reason}` : ''}
          </li>
        ))}
      </ol>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void act(`/missions/${m.id}/narratives`, narrative, 'Narrative added.', false).then(() =>
            setNarrative({ ...narrative, body: '' }),
          );
        }}
      >
        <h2>Add to the narrative</h2>
        <Field label="Written as">
          {({ id: fid }) => (
            <select
              id={fid}
              value={narrative.role}
              onChange={(e) => setNarrative({ ...narrative, role: e.target.value })}
            >
              {['call_taker', 'dispatcher', 'responder', 'supervisor', 'follow_up'].map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Narrative"
          hint="Facts only. It cannot be edited later; add an amendment instead."
        >
          {({ id: fid, describedBy }) => (
            <textarea
              id={fid}
              aria-describedby={describedBy}
              rows={3}
              value={narrative.body}
              onChange={(e) => setNarrative({ ...narrative, body: e.target.value })}
            />
          )}
        </Field>
        <button type="submit" className="primary" disabled={!narrative.body.trim()}>
          Add
        </button>
      </form>
    </section>
  );
}

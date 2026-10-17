/**
 * Field operations in the console (layer-4 plan console 3, 4, 5, 6, 7, 10;
 * PER-01/02, FR-05.01–05.06, FLD-02, FLD-03, DSP-04, DSP-06, DSP-10, F09,
 * FR-09.01–09.05, BDG-01/02, FR-13.01–13.06, AC-13C, RULE-11, RULE-14):
 *
 * - Roster and check-in: teams with status, members and credentials; who is
 *   checked in now, with hours; walk-up check-in at the console; credential
 *   verification.
 * - Net control log (ICS 309 style): status heard and position heard against
 *   a team, entered by net control; no data relay over amateur radio
 *   (FLD-17).
 * - Messages to the field: templates, recipients by person, team, agency,
 *   area or the whole event, and read receipts.
 * - Badges: generate, a print view with the same information in text,
 *   print outcomes, revoke.
 * - Reminders: overdue shown in words and a symbol, never colour or sound
 *   alone; acknowledge, snooze, complete against a note, cancel.
 * - Field devices: last contact and remote wipe of the app's data.
 */
import { QuietHoursPanel } from './settings.tsx';
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import { STATUS_TEXT } from './team-status.ts';
import { EventPicker, useOpenEvents } from './dispatch.tsx';
import { formatDate, fromZoneInput } from '../ui/time.ts';
import { useImage } from '../ui/badge-photo.tsx';
import { QrImage } from '../ui/qr.tsx';

const label = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—');

/** A list that loads when its path changes and again on reload(). */
function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path)
      .then((data) => live && setState({ data, error: null }))
      .catch(
        (e: unknown) => live && setState((s) => ({ data: s.data, error: describeFailure(e) })),
      );
    return () => {
      live = false;
    };
  }, [path, tick]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

function useEvent() {
  const { events, error } = useOpenEvents();
  const [eventId, setEventId] = useState<string | null>(null);
  const current = eventId ?? events?.[0]?.id ?? null;
  const picker = events?.length ? (
    <EventPicker events={events} value={current} onChange={setEventId} />
  ) : null;
  return { eventId: current, picker, error };
}

interface Person {
  id: string;
  name: string;
  agency: string | null;
}
interface Team {
  id: string;
  version: number;
  name: string;
  callsign: string | null;
  agency: string | null;
  kind: string;
  skills: string[];
  current: { status: string; at: string; source: string } | null;
  memberCount: number;
  checkedInCount: number;
  checkInDueAt: string | null;
  members?: {
    personnelId: string;
    name: string;
    role: string;
    checkedIn: boolean;
    credentials: string[];
  }[];
}
interface CheckIn {
  id: string;
  personnelId: string;
  personnelName: string | null;
  teamId: string | null;
  method: string;
  startedAt: string;
  endedAt: string | null;
  hours: number | null;
  credentials: { kind: string; status: string }[];
  locationSharing: boolean;
  locationPermission: 'granted' | 'foreground_only' | 'denied' | 'unavailable' | null;
  locationPermissionAt: string | null;
}
interface LatestPosition {
  checkInId: string;
  recordedAt: string;
  stale: boolean;
}

/**
 * BRD:FR-03.05: where a person's location stands, in words: sharing off, blocked on
 * the phone, no position to be had, an old position, or a recent one.
 */
function locationText(c: CheckIn, p: LatestPosition | undefined): string {
  if (!c.locationSharing) return 'Sharing off for this shift';
  if (c.locationPermission === 'denied')
    return `Blocked on the phone since ${fmt(c.locationPermissionAt)}`;
  if (c.locationPermission === 'unavailable')
    return `Phone cannot get a position since ${fmt(c.locationPermissionAt)}`;
  if (p)
    return p.stale
      ? `Old position, last at ${fmt(p.recordedAt)}`
      : `Shared at ${fmt(p.recordedAt)}`;
  return c.locationPermission === 'foreground_only'
    ? 'Only while the app is open; no position yet'
    : 'No position yet';
}
interface Credential {
  id: string;
  version: number;
  kind: string;
  label: string | null;
  issuer: string | null;
  expiresAt: string | null;
  status: string;
  inForce: boolean;
}

// --------------------------------------------------------------- roster
/**
 * A screen whose event list cannot load keeps its heading (WCAG 1.3.1, 2.4.6),
 * so a screen-reader user still hears where they are before the reason.
 */
function Unavailable({ id, title, error }: { id: string; title: string; error: string }) {
  return (
    <section aria-labelledby={id}>
      <h1 id={id}>{title}</h1>
      <Status kind="error">{error}</Status>
    </section>
  );
}

interface EventCode {
  id: string;
  version: number;
  name: string;
  checkInCode: string | null;
}

/**
 * FLD-03: the code people scan at staging, or type, to check in. Printed as a
 * QR code with the code in large letters beside it; a new code retires the old
 * one at once (a sign that leaked stops working).
 */
function StagingCode({ eventId }: { eventId: string }) {
  const ev = useApi<EventCode>(`/events/${eventId}`);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const replace = async () => {
    if (!ev.data) return;
    try {
      await api(`/events/${eventId}/check-in-code`, { body: {}, version: ev.data.version });
      setMsg({ kind: 'success', text: 'New code made. The old one no longer works.' });
    } catch (e) {
      setMsg({ kind: 'error', text: describeFailure(e) });
    }
    ev.reload();
  };
  const code = ev.data?.checkInCode ?? null;
  return (
    <section className="panel staging-code" aria-labelledby="staging-h">
      <h2 id="staging-h">Staging check-in code</h2>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {ev.error ? <Status kind="error">{ev.error}</Status> : null}
      {code ? (
        <>
          <p>
            People check in to {ev.data?.name} by scanning this code with the field app or typing
            it.
          </p>
          <div className="staging-sign">
            <QrImage text={code} alt={`Check-in code ${code.split('').join(' ')}`} size={200} />
            <p className="staging-code-text">{code}</p>
          </div>
        </>
      ) : (
        <p>This event has no check-in code yet.</p>
      )}
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        {code ? (
          <button type="button" onClick={() => window.print()}>
            Print
          </button>
        ) : null}
        <button type="button" onClick={() => void replace()} disabled={!ev.data}>
          {code ? 'Make a new code' : 'Make a code'}
        </button>
      </div>
    </section>
  );
}

export function RosterScreen() {
  const { eventId, picker, error: evError } = useEvent();
  const teams = useApi<Team[]>(eventId ? `/teams?eventId=${eventId}&limit=200` : null);
  const checkIns = useApi<CheckIn[]>(
    eventId ? `/check-ins?eventId=${eventId}&open=true&limit=200` : null,
  );
  // FR-03.05: latest positions with their stale flag, for roles that may read positions.
  const positions = useApi<LatestPosition[]>(
    eventId ? `/positions/latest?eventId=${eventId}` : null,
  );
  const people = useApi<Person[]>('/personnel?limit=200');
  const [open, setOpen] = useState<string | null>(null);
  const detail = useApi<Team>(open ? `/teams/${open}` : null);
  const [person, setPerson] = useState('');
  const [team, setTeam] = useState('');
  const [credsFor, setCredsFor] = useState<string | null>(null);
  const creds = useApi<Credential[]>(credsFor ? `/personnel/${credsFor}/credentials` : null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string, after: () => void) => {
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
    } catch (e) {
      setMsg({ kind: 'error', text: describeFailure(e) });
    }
    after();
  };
  const checkIn = (e: FormEvent) => {
    e.preventDefault();
    if (!eventId || !person) return;
    void run(
      () =>
        api('/check-ins', {
          body: {
            eventId,
            personnelId: person,
            method: 'console',
            locationSharing: false,
            ...(team ? { teamId: team } : {}),
          },
        }),
      'Checked in.',
      () => {
        checkIns.reload();
        teams.reload();
      },
    );
  };
  if (evError) return <Unavailable id="roster-h" title="Roster and check-in" error={evError} />;
  const nameOf = (id: string | null) =>
    id ? (teams.data?.find((t) => t.id === id)?.name ?? '—') : '—';
  return (
    <section aria-labelledby="roster-h">
      <h1 id="roster-h">Roster and check-in</h1>
      <Toolbar>{picker}</Toolbar>
      {eventId ? <StagingCode eventId={eventId} /> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {teams.error ? <Status kind="error">{teams.error}</Status> : null}
      <h2>Teams</h2>
      <DataTable
        caption="Teams on this event"
        rows={teams.data ?? []}
        rowKey={(t) => t.id}
        empty="No teams yet."
        columns={[
          {
            key: 'n',
            header: 'Team',
            render: (t) => `${t.name}${t.callsign ? ` (${t.callsign})` : ''}`,
          },
          { key: 'a', header: 'Agency', render: (t) => t.agency ?? '—' },
          {
            key: 's',
            header: 'Status',
            render: (t) =>
              t.current
                ? `${STATUS_TEXT[t.current.status] ?? label(t.current.status)} · ${fmt(t.current.at)}`
                : 'No status yet',
          },
          {
            key: 'c',
            header: 'Checked in',
            render: (t) => `${t.checkedInCount} of ${t.memberCount}`,
          },
          { key: 'd', header: 'Next check-in', render: (t) => fmt(t.checkInDueAt) },
          {
            key: 'x',
            header: 'Details',
            render: (t) => (
              <button
                type="button"
                aria-expanded={open === t.id}
                onClick={() => setOpen(open === t.id ? null : t.id)}
              >
                {open === t.id ? 'Hide' : 'Show'} {t.name}
              </button>
            ),
          },
        ]}
      />
      {open && detail.data ? (
        <div className="panel">
          <h3>{detail.data.name}</h3>
          <p>Skills: {detail.data.skills.map(label).join(', ') || '—'}</p>
          <DataTable
            caption={`Members of ${detail.data.name}`}
            rows={detail.data.members ?? []}
            rowKey={(m) => m.personnelId}
            columns={[
              { key: 'n', header: 'Name', render: (m) => m.name },
              { key: 'r', header: 'Role', render: (m) => label(m.role) },
              { key: 'c', header: 'Checked in', render: (m) => (m.checkedIn ? 'Yes' : 'No') },
              {
                key: 'k',
                header: 'Credentials in force',
                render: (m) => m.credentials.map(label).join(', ') || '—',
              },
              {
                key: 'v',
                header: 'Credentials',
                render: (m) => (
                  <button type="button" onClick={() => setCredsFor(m.personnelId)}>
                    Credentials of {m.name}
                  </button>
                ),
              },
            ]}
          />
          <label className="inline">
            Set status (confirmed by you)
            <select
              defaultValue=""
              onChange={(e) => {
                const status = e.target.value;
                if (!status || !detail.data) return;
                void run(
                  () =>
                    api(`/teams/${detail.data!.id}/status`, {
                      body: { status, source: 'console' },
                    }),
                  'Status recorded.',
                  () => {
                    detail.reload();
                    teams.reload();
                  },
                );
              }}
            >
              <option value="">Choose…</option>
              {['available', 'en_route', 'on_task', 'break', 'out_of_service'].map((s) => (
                <option key={s} value={s}>
                  {STATUS_TEXT[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {credsFor && creds.data ? (
        <div className="panel">
          <h3>Credentials</h3>
          <DataTable
            caption="Credentials"
            rows={creds.data}
            rowKey={(c) => c.id}
            empty="No credentials recorded."
            columns={[
              { key: 'k', header: 'Credential', render: (c) => c.label ?? label(c.kind) },
              { key: 'i', header: 'Issuer', render: (c) => c.issuer ?? '—' },
              { key: 'e', header: 'Expires', render: (c) => c.expiresAt ?? '—' },
              {
                key: 's',
                header: 'Status',
                render: (c) => `${label(c.status)}${c.inForce ? ' (in force)' : ''}`,
              },
              {
                key: 'v',
                header: 'Action',
                render: (c) =>
                  c.status === 'recorded' ? (
                    <button
                      type="button"
                      onClick={() =>
                        void run(
                          () =>
                            api(`/credentials/${c.id}/verify`, { body: {}, version: c.version }),
                          'Verified.',
                          creds.reload,
                        )
                      }
                    >
                      Verify {c.label ?? label(c.kind)}
                    </button>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        </div>
      ) : null}
      <h2>Checked in now</h2>
      <DataTable
        caption="People checked in on this event"
        rows={checkIns.data ?? []}
        rowKey={(c) => c.id}
        empty="Nobody is checked in."
        columns={[
          { key: 'n', header: 'Name', render: (c) => c.personnelName ?? '—' },
          { key: 't', header: 'Team', render: (c) => nameOf(c.teamId) },
          { key: 'm', header: 'How', render: (c) => label(c.method) },
          { key: 's', header: 'Since', render: (c) => fmt(c.startedAt) },
          {
            key: 'l',
            header: 'Location',
            render: (c) =>
              locationText(
                c,
                positions.data?.find((p) => p.checkInId === c.id),
              ),
          },
          {
            key: 'h',
            header: 'Hours',
            render: (c) => (c.hours !== null ? c.hours.toFixed(1) : '—'),
          },
          {
            key: 'e',
            header: 'Action',
            render: (c) => (
              <button
                type="button"
                onClick={() =>
                  void run(
                    () => api(`/check-ins/${c.id}/end`, { body: { reason: 'coordinator' } }),
                    'Checked out.',
                    () => {
                      checkIns.reload();
                      teams.reload();
                    },
                  )
                }
              >
                Check out {c.personnelName ?? ''}
              </button>
            ),
          },
        ]}
      />
      <form className="panel" onSubmit={checkIn} aria-labelledby="walkup-h">
        <h2 id="walkup-h">Walk-up check-in</h2>
        <p className="hint">For someone without the app. With the app, they scan the event code.</p>
        <div className="form-grid">
          <Field label="Person">
            {({ id }) => (
              <select id={id} value={person} onChange={(e) => setPerson(e.target.value)} required>
                <option value="">Choose…</option>
                {(people.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.agency ? ` · ${p.agency}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Team (optional)">
            {({ id }) => (
              <select id={id} value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">None</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <button type="submit" className="primary" disabled={!person}>
          Check in
        </button>
      </form>
    </section>
  );
}

// ------------------------------------------------------------ net control
interface CommsEntry {
  id: string;
  net: string;
  entryAt: string;
  fromStation: string | null;
  toStation: string | null;
  teamId: string | null;
  kind: string;
  message: string | null;
}
export function NetControlScreen() {
  const { eventId, picker, error: evError } = useEvent();
  const [net, setNet] = useState('County ARES net');
  const log = useApi<CommsEntry[]>(
    eventId ? `/comms-log?eventId=${eventId}&net=${encodeURIComponent(net)}&limit=100` : null,
  );
  const teams = useApi<Team[]>(eventId ? `/teams?eventId=${eventId}&limit=200` : null);
  const [f, setF] = useState({
    kind: 'status_heard',
    from: '',
    to: 'NCS',
    team: '',
    status: 'available',
    lat: '',
    lon: '',
    usng: '',
    message: '',
  });
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!eventId) return;
    const position = f.lat && f.lon ? { lat: Number(f.lat), lon: Number(f.lon) } : undefined;
    try {
      await api('/comms-log', {
        body: {
          eventId,
          net,
          kind: f.kind,
          ...(f.from.trim() ? { fromStation: f.from.trim() } : {}),
          ...(f.to.trim() ? { toStation: f.to.trim() } : {}),
          ...(f.team ? { teamId: f.team } : {}),
          ...(f.kind === 'status_heard' ? { status: f.status } : {}),
          ...(f.kind === 'position_heard' && position ? { position } : {}),
          ...(f.kind === 'position_heard' && !position && f.usng.trim()
            ? { usng: f.usng.trim() }
            : {}),
          ...(f.message.trim() ? { message: f.message.trim() } : {}),
        },
      });
      setMsg({ kind: 'success', text: 'Logged.' });
      setF({ ...f, from: '', message: '', lat: '', lon: '', usng: '' });
      log.reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const teamName = (id: string | null) =>
    id ? (teams.data?.find((t) => t.id === id)?.name ?? '—') : '—';
  if (evError) return <Unavailable id="net-h" title="Net control log" error={evError} />;
  return (
    <section aria-labelledby="net-h">
      <h1 id="net-h">Net control log</h1>
      <p className="hint">
        ICS 309 style. What a station reports on the radio is entered here by net control; nothing
        is relayed over amateur radio as data.
      </p>
      <Toolbar>
        {picker}
        <label className="inline">
          Net
          <input value={net} onChange={(e) => setNet(e.target.value)} />
        </label>
      </Toolbar>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      <form className="panel" onSubmit={(e) => void submit(e)} aria-labelledby="entry-h">
        <h2 id="entry-h">New entry</h2>
        <div className="form-grid">
          <Field label="Kind">
            {({ id }) => (
              <select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                {[
                  'status_heard',
                  'position_heard',
                  'message',
                  'check_in',
                  'check_out',
                  'traffic',
                  'net_open',
                  'net_close',
                ].map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="From station">
            {({ id }) => (
              <input
                id={id}
                value={f.from}
                onChange={(e) => setF({ ...f, from: e.target.value })}
              />
            )}
          </Field>
          <Field label="To station">
            {({ id }) => (
              <input id={id} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
            )}
          </Field>
          <Field label="Team">
            {({ id }) => (
              <select id={id} value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })}>
                <option value="">None</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.callsign ? ` (${t.callsign})` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {f.kind === 'status_heard' ? (
            <Field label="Status heard">
              {({ id }) => (
                <select
                  id={id}
                  value={f.status}
                  onChange={(e) => setF({ ...f, status: e.target.value })}
                >
                  {['available', 'en_route', 'on_task', 'break', 'out_of_service'].map((s) => (
                    <option key={s} value={s}>
                      {STATUS_TEXT[s]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          {f.kind === 'position_heard' ? (
            <>
              <Field label="Latitude">
                {({ id }) => (
                  <input
                    id={id}
                    inputMode="decimal"
                    value={f.lat}
                    onChange={(e) => setF({ ...f, lat: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Longitude">
                {({ id }) => (
                  <input
                    id={id}
                    inputMode="decimal"
                    value={f.lon}
                    onChange={(e) => setF({ ...f, lon: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Or a USNG reference" hint="For example: 15S XC 849 956">
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={f.usng}
                    onChange={(e) => setF({ ...f, usng: e.target.value })}
                  />
                )}
              </Field>
            </>
          ) : null}
        </div>
        <Field label="Message">
          {({ id }) => (
            <textarea
              id={id}
              rows={2}
              value={f.message}
              onChange={(e) => setF({ ...f, message: e.target.value })}
            />
          )}
        </Field>
        <button type="submit" className="primary">
          Log entry
        </button>
      </form>
      <DataTable
        caption={`Log for ${net}`}
        rows={log.data ?? []}
        rowKey={(e) => e.id}
        empty="No entries on this net yet."
        columns={[
          { key: 't', header: 'Time', render: (e) => fmt(e.entryAt) },
          { key: 'f', header: 'From', render: (e) => e.fromStation ?? '—' },
          { key: 'o', header: 'To', render: (e) => e.toStation ?? '—' },
          { key: 'k', header: 'Kind', render: (e) => label(e.kind) },
          { key: 'm', header: 'Team', render: (e) => teamName(e.teamId) },
          { key: 'x', header: 'Message', render: (e) => e.message ?? '—' },
        ]}
      />
    </section>
  );
}

// --------------------------------------------------------------- messages
interface FieldMessage {
  id: string;
  kind: string;
  template: string | null;
  body: string;
  priority: string;
  audience: {
    kind: string;
    personnelId: string | null;
    teamId: string | null;
    tenantId: string | null;
  };
  requiresAck: boolean;
  sentAt: string;
  recipientCount: number;
  receipts?: {
    personnelId: string;
    channel: string;
    readAt: string | null;
    acknowledgedAt: string | null;
  }[];
}
const TEMPLATES: { key: string; label: string; body: string }[] = [
  {
    key: 'return_to_staging',
    label: 'Return to staging',
    body: 'Please finish your current task safely and return to staging.',
  },
  { key: 'check_in_now', label: 'Check in now', body: 'Please check in with dispatch now.' },
  {
    key: 'weather',
    label: 'Weather change',
    body: 'Weather is changing in your area. Stop work if conditions are unsafe and report your status.',
  },
  {
    key: 'hazard_nearby',
    label: 'Hazard nearby',
    body: 'A hazard has been reported near your area. Check the hazard list before you go on.',
  },
];
export function FieldMessagesScreen() {
  const { eventId, picker, error: evError } = useEvent();
  const list = useApi<FieldMessage[]>(
    eventId ? `/field-messages?eventId=${eventId}&limit=50` : null,
  );
  const teams = useApi<Team[]>(eventId ? `/teams?eventId=${eventId}&limit=200` : null);
  const people = useApi<Person[]>('/personnel?limit=200');
  const [f, setF] = useState({
    template: '',
    body: '',
    priority: 'normal',
    audience: 'team',
    team: '',
    person: '',
    requiresAck: true,
  });
  const [open, setOpen] = useState<string | null>(null);
  // The sender's list carries each message's receipts (DSP-06).
  const opened = list.data?.find((m) => m.id === open) ?? null;
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!eventId) return;
    try {
      await api('/field-messages', {
        body: {
          eventId,
          body: f.body.trim(),
          priority: f.priority,
          requiresAck: f.requiresAck,
          ...(f.template ? { template: f.template } : {}),
          audience: {
            kind: f.audience,
            ...(f.audience === 'team' ? { teamId: f.team } : {}),
            ...(f.audience === 'person' ? { personnelId: f.person } : {}),
          },
        },
      });
      setMsg({ kind: 'success', text: 'Sent. Receipts appear as people read it.' });
      setF({ ...f, template: '', body: '' });
      list.reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  if (evError) return <Unavailable id="fm-h" title="Messages to the field" error={evError} />;
  const ready =
    f.body.trim().length > 0 &&
    (f.audience !== 'team' || !!f.team) &&
    (f.audience !== 'person' || !!f.person);
  return (
    <section aria-labelledby="fm-h">
      <h1 id="fm-h">Messages to the field</h1>
      <Toolbar>{picker}</Toolbar>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      <form className="panel" onSubmit={(e) => void send(e)} aria-labelledby="send-h">
        <h2 id="send-h">Send a message</h2>
        <p className="hint">
          People without the app get it as a text message. Never use this for emergency alerts.
        </p>
        <div className="form-grid">
          <Field label="Template (optional)">
            {({ id }) => (
              <select
                id={id}
                value={f.template}
                onChange={(e) => {
                  const t = TEMPLATES.find((x) => x.key === e.target.value);
                  setF({ ...f, template: e.target.value, body: t ? t.body : f.body });
                }}
              >
                <option value="">None</option>
                {TEMPLATES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Send to">
            {({ id }) => (
              <select
                id={id}
                value={f.audience}
                onChange={(e) => setF({ ...f, audience: e.target.value })}
              >
                <option value="team">A team</option>
                <option value="person">A person</option>
                <option value="event">Everyone on this event</option>
              </select>
            )}
          </Field>
          {f.audience === 'team' ? (
            <Field label="Team">
              {({ id }) => (
                <select
                  id={id}
                  value={f.team}
                  onChange={(e) => setF({ ...f, team: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {(teams.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          {f.audience === 'person' ? (
            <Field label="Person">
              {({ id }) => (
                <select
                  id={id}
                  value={f.person}
                  onChange={(e) => setF({ ...f, person: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {(people.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          <Field label="Priority">
            {({ id }) => (
              <select
                id={id}
                value={f.priority}
                onChange={(e) => setF({ ...f, priority: e.target.value })}
              >
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            )}
          </Field>
        </div>
        <Field label="Message">
          {({ id }) => (
            <textarea
              id={id}
              rows={3}
              maxLength={1000}
              value={f.body}
              onChange={(e) => setF({ ...f, body: e.target.value })}
            />
          )}
        </Field>
        <label className="inline" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={f.requiresAck}
            onChange={(e) => setF({ ...f, requiresAck: e.target.checked })}
          />{' '}
          Ask for “Got it”
        </label>
        <button type="submit" className="primary" disabled={!ready}>
          Send
        </button>
      </form>
      <DataTable
        caption="Sent messages"
        rows={list.data ?? []}
        rowKey={(m) => m.id}
        empty="No messages sent on this event."
        columns={[
          { key: 't', header: 'Sent', render: (m) => fmt(m.sentAt) },
          { key: 'a', header: 'To', render: (m) => label(m.audience.kind) },
          { key: 'b', header: 'Message', render: (m) => m.body },
          { key: 'p', header: 'Priority', render: (m) => m.priority },
          { key: 'n', header: 'Recipients', render: (m) => String(m.recipientCount) },
          {
            key: 'r',
            header: 'Receipts',
            render: (m) => (
              <button
                type="button"
                aria-expanded={open === m.id}
                onClick={() => setOpen(open === m.id ? null : m.id)}
              >
                Receipts for the message sent {fmt(m.sentAt)}
              </button>
            ),
          },
        ]}
      />
      {opened?.receipts ? (
        <div className="panel">
          <h2>Receipts</h2>
          <p>
            Read: {opened.receipts.filter((r) => r.readAt).length} of {opened.receipts.length} ·
            “Got it”: {opened.receipts.filter((r) => r.acknowledgedAt).length}
          </p>
          <DataTable
            caption="Receipt per person"
            rows={opened.receipts}
            rowKey={(r) => r.personnelId}
            columns={[
              {
                key: 'p',
                header: 'Person',
                render: (r) =>
                  people.data?.find((p) => p.id === r.personnelId)?.name ??
                  r.personnelId.slice(0, 8),
              },
              { key: 'c', header: 'By', render: (r) => label(r.channel) },
              { key: 'r', header: 'Read', render: (r) => fmt(r.readAt) },
              { key: 'a', header: 'Got it', render: (r) => fmt(r.acknowledgedAt) },
            ]}
          />
        </div>
      ) : null}
    </section>
  );
}

// ----------------------------------------------------------------- badges
interface Badge {
  id: string;
  version: number;
  personnelId: string;
  displayName: string;
  agency: string | null;
  roleLabel: string | null;
  accessLabel: string | null;
  credentials: string[];
  validFrom: string;
  validTo: string;
  state: string;
  code?: string;
  printFailedReason: string | null;
  /** BRD:FR-13.01: the approved photo the badge was generated with, if any. */
  photoKey: string | null;
}
/** FR-13.04: the photo printed on the badge, through the API. */
function BadgeImage({ badge }: { badge: Badge }) {
  const src = useImage(badge.photoKey ? `/badges/${badge.id}/photo` : null);
  return src ? <img src={src} alt={`Photo of ${badge.displayName}`} width={96} /> : null;
}
export function BadgesScreen() {
  const { eventId, picker } = useEvent();
  const badges = useApi<Badge[]>('/badges?limit=200');
  const people = useApi<Person[]>('/personnel?limit=200');
  const [f, setF] = useState({ person: '', role: '', access: '', days: 14 });
  const [printing, setPrinting] = useState<Badge | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
    } catch (e) {
      setMsg({ kind: 'error', text: describeFailure(e) });
    }
    badges.reload();
  };
  const generate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const b = await api<Badge>('/badges', {
        body: {
          personnelId: f.person,
          validDays: f.days,
          ...(eventId ? { eventId } : {}),
          ...(f.role.trim() ? { roleLabel: f.role.trim() } : {}),
          ...(f.access.trim() ? { accessLabel: f.access.trim() } : {}),
        },
      });
      setPrinting(b);
      setMsg({
        kind: 'success',
        text: 'Badge generated. Print it now: the code is shown only this once.',
      });
      badges.reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const outcome = (b: Badge, o: string, reason?: string) =>
    run(
      () =>
        api(`/badges/${b.id}/print`, {
          body: { outcome: o, ...(reason ? { reason } : {}) },
          version: b.version,
        }),
      `Recorded: ${label(o)}.`,
    );
  return (
    <section aria-labelledby="badges-h">
      <h1 id="badges-h">Badges</h1>
      <Toolbar>{picker}</Toolbar>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      <form className="panel" onSubmit={(e) => void generate(e)} aria-labelledby="gen-h">
        <h2 id="gen-h">Generate a badge</h2>
        <p className="hint">
          The access label is printed on the badge; it does not change what the person may do in the
          system.
        </p>
        <div className="form-grid">
          <Field label="Person">
            {({ id }) => (
              <select
                id={id}
                value={f.person}
                onChange={(e) => setF({ ...f, person: e.target.value })}
                required
              >
                <option value="">Choose…</option>
                {(people.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Role on the badge">
            {({ id }) => (
              <input
                id={id}
                value={f.role}
                onChange={(e) => setF({ ...f, role: e.target.value })}
              />
            )}
          </Field>
          <Field label="Access label">
            {({ id }) => (
              <input
                id={id}
                value={f.access}
                onChange={(e) => setF({ ...f, access: e.target.value })}
              />
            )}
          </Field>
          <Field label="Valid for (days)">
            {({ id }) => (
              <input
                id={id}
                type="number"
                min={1}
                max={366}
                value={f.days}
                onChange={(e) => setF({ ...f, days: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
        <button type="submit" className="primary" disabled={!f.person}>
          Generate
        </button>
      </form>
      {printing ? (
        <section className="panel badge-print" aria-labelledby="print-h">
          <h2 id="print-h">Print view</h2>
          <div className="badge-card">
            <BadgeImage badge={printing} />
            <p className="badge-name">{printing.displayName}</p>
            <p>{printing.agency ?? ''}</p>
            <p>{printing.roleLabel ?? ''}</p>
            <p>Access: {printing.accessLabel ?? 'none'}</p>
            <p>Credentials: {printing.credentials.map(label).join(', ') || 'none recorded'}</p>
            <p>
              Valid {formatDate(new Date(printing.validFrom))} to{' '}
              {formatDate(new Date(printing.validTo))}
            </p>
            {printing.code ? (
              <>
                <QrImage
                  text={printing.code}
                  alt={`Badge code ${printing.code.split('').join(' ')}`}
                  size={120}
                />
                <p>
                  Code: <strong>{printing.code}</strong>
                </p>
              </>
            ) : null}
          </div>
          <p className="hint">The same information is printed in text beside the code (AC-13C).</p>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" onClick={() => void outcome(printing, 'requested')}>
              Print requested
            </button>
            <button
              type="button"
              onClick={() => void outcome(printing, 'confirmed').then(() => setPrinting(null))}
            >
              Printed correctly
            </button>
            <button
              type="button"
              onClick={() =>
                void outcome(printing, 'failed', 'Printer problem').then(() => setPrinting(null))
              }
            >
              Print failed
            </button>
          </div>
        </section>
      ) : null}
      <DataTable
        caption="Badges"
        rows={badges.data ?? []}
        rowKey={(b) => b.id}
        empty="No badges yet."
        columns={[
          { key: 'n', header: 'Name', render: (b) => b.displayName },
          { key: 'a', header: 'Agency', render: (b) => b.agency ?? '—' },
          { key: 's', header: 'State', render: (b) => label(b.state) },
          { key: 'v', header: 'Valid to', render: (b) => fmt(b.validTo) },
          {
            key: 'x',
            header: 'Action',
            render: (b) =>
              b.state === 'revoked' || b.state === 'expired' ? (
                '—'
              ) : (
                <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {b.state === 'print_confirmed' ? (
                    <button type="button" onClick={() => void outcome(b, 'handed_out')}>
                      Handed out to {b.displayName}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () => api(`/badges/${b.id}/revoke`, { body: {}, version: b.version }),
                        'Revoked.',
                      )
                    }
                  >
                    Revoke badge of {b.displayName}…
                  </button>
                </span>
              ),
          },
        ]}
      />
    </section>
  );
}

// -------------------------------------------------------------- reminders
interface Reminder {
  id: string;
  version: number;
  kind: string;
  title: string;
  note: string | null;
  dueAt: string;
  state: string;
  overdue: boolean;
  snoozedUntil: string | null;
}
export function RemindersScreen() {
  const { eventId, picker } = useEvent();
  const [mine, setMine] = useState(true);
  const list = useApi<Reminder[]>(
    `/reminders?open=true&limit=100${mine ? '&mine=true' : ''}${eventId ? `&eventId=${eventId}` : ''}`,
  );
  const [f, setF] = useState({ title: '', note: '', due: '' });
  const [done, setDone] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
    } catch (e) {
      setMsg({ kind: 'error', text: describeFailure(e) });
    }
    list.reload();
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        api('/reminders', {
          body: {
            title: f.title.trim(),
            dueAt: fromZoneInput(f.due).toISOString(),
            ...(f.note.trim() ? { note: f.note.trim() } : {}),
            ...(eventId ? { eventId } : {}),
          },
        }),
      'Reminder set.',
    ).then(() => setF({ title: '', note: '', due: '' }));
  };
  return (
    <section aria-labelledby="rem-h">
      <h1 id="rem-h">Reminders</h1>
      <Toolbar>
        {picker}
        <label className="inline" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only
          mine
        </label>
      </Toolbar>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {list.error ? <Status kind="error">{list.error}</Status> : null}
      <DataTable
        caption="Open reminders, soonest first"
        rows={[...(list.data ?? [])].sort((a, b) => a.dueAt.localeCompare(b.dueAt))}
        rowKey={(r) => r.id}
        empty="No open reminders."
        columns={[
          {
            key: 'd',
            header: 'Due',
            render: (r) => (
              <>
                {r.overdue ? (
                  <strong>
                    <span aria-hidden="true">⚠ </span>Overdue ·{' '}
                  </strong>
                ) : null}
                {fmt(r.dueAt)}
                {r.snoozedUntil ? ` (snoozed to ${fmt(r.snoozedUntil)})` : ''}
              </>
            ),
          },
          {
            key: 't',
            header: 'Reminder',
            render: (r) => `${r.title}${r.note ? ` — ${r.note}` : ''}`,
          },
          { key: 'k', header: 'Kind', render: (r) => label(r.kind) },
          { key: 's', header: 'State', render: (r) => label(r.state) },
          {
            key: 'x',
            header: 'Action',
            render: (r) => (
              <span
                style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
              >
                {r.state !== 'acknowledged' ? (
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () =>
                          api(`/reminders/${r.id}/acknowledge`, { body: {}, version: r.version }),
                        'Acknowledged.',
                      )
                    }
                  >
                    Acknowledge “{r.title}”
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    void run(
                      () =>
                        api(`/reminders/${r.id}/snooze`, {
                          body: { minutes: 30 },
                          version: r.version,
                        }),
                      'Snoozed 30 minutes.',
                    )
                  }
                >
                  Snooze 30 min
                </button>
                <input
                  aria-label={`What was done for “${r.title}”`}
                  placeholder="What was done"
                  value={done[r.id] ?? ''}
                  onChange={(e) => setDone({ ...done, [r.id]: e.target.value })}
                />
                <button
                  type="button"
                  disabled={(done[r.id] ?? '').trim().length < 3}
                  onClick={() =>
                    void run(
                      () =>
                        api(`/reminders/${r.id}/complete`, {
                          body: { completion: { kind: 'note', note: done[r.id]!.trim() } },
                          version: r.version,
                        }),
                      'Completed.',
                    )
                  }
                >
                  Complete
                </button>
              </span>
            ),
          },
        ]}
      />
      <form className="panel" onSubmit={create} aria-labelledby="newrem-h">
        <h2 id="newrem-h">New reminder</h2>
        <div className="form-grid">
          <Field label="Title">
            {({ id }) => (
              <input
                id={id}
                value={f.title}
                onChange={(e) => setF({ ...f, title: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Due">
            {({ id }) => (
              <input
                id={id}
                type="datetime-local"
                value={f.due}
                onChange={(e) => setF({ ...f, due: e.target.value })}
                required
              />
            )}
          </Field>
        </div>
        <Field label="Note (optional)">
          {({ id }) => (
            <textarea
              id={id}
              rows={2}
              value={f.note}
              onChange={(e) => setF({ ...f, note: e.target.value })}
            />
          )}
        </Field>
        <button type="submit" className="primary" disabled={!f.title.trim() || !f.due}>
          Set reminder
        </button>
      </form>
      <QuietHoursPanel />
    </section>
  );
}

// ---------------------------------------------------------------- devices
interface Device {
  id: string;
  version: number;
  accountId: string;
  platform: string;
  managed: boolean;
  model: string | null;
  appVersion: string | null;
  status: string;
  registeredAt: string;
  lastContactAt: string | null;
  wipeRequestedAt: string | null;
  wipeConfirmedAt: string | null;
}
export function DevicesScreen() {
  const list = useApi<Device[]>('/devices?limit=200');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  return (
    <section aria-labelledby="dev-h">
      <h1 id="dev-h">Field devices</h1>
      <p className="hint">
        A remote wipe clears this app’s data on the phone at its next contact, and nothing else on
        the phone.
      </p>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {list.error ? <Status kind="error">{list.error}</Status> : null}
      <DataTable
        caption="Registered devices"
        rows={list.data ?? []}
        rowKey={(d) => d.id}
        empty="No devices registered."
        columns={[
          {
            key: 'p',
            header: 'Device',
            render: (d) =>
              `${label(d.platform)}${d.model ? ` · ${d.model}` : ''}${d.managed ? ' · managed' : ' · personal'}`,
          },
          { key: 'v', header: 'App', render: (d) => d.appVersion ?? '—' },
          { key: 's', header: 'State', render: (d) => label(d.status) },
          { key: 'l', header: 'Last contact', render: (d) => fmt(d.lastContactAt) },
          {
            key: 'w',
            header: 'Wipe',
            render: (d) =>
              d.wipeConfirmedAt
                ? `Done ${fmt(d.wipeConfirmedAt)}`
                : d.wipeRequestedAt
                  ? `Requested ${fmt(d.wipeRequestedAt)}`
                  : '—',
          },
          {
            key: 'x',
            header: 'Action',
            render: (d) =>
              d.status === 'active' ? (
                <button
                  type="button"
                  onClick={() =>
                    void api(`/devices/${d.id}/wipe`, { body: {}, version: d.version })
                      .then(() =>
                        setMsg({
                          kind: 'success',
                          text: 'Wipe requested. It happens at the next contact.',
                        }),
                      )
                      .catch((e: unknown) => setMsg({ kind: 'error', text: describeFailure(e) }))
                      .finally(list.reload)
                  }
                >
                  Wipe app data on this {label(d.platform)} device…
                </button>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </section>
  );
}

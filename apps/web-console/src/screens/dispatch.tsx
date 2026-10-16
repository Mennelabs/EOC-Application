/**
 * Dispatch board (layer-4 plan console 1 and 11; mockup Dispatch.dc.html;
 * DSP-01, DSP-02, DSP-03, DSP-04, DSP-07, DSP-08, DSP-12, FLD-16, WCAG 2.5.7):
 * volunteer and resource coordination, never 911 dispatch. Teams by status
 * with shape and text as well as colour, the work nobody holds yet with the
 * suggested teams and their reasons, and the open alerts, which take over
 * the screen until someone acknowledges them. Assigning works with the
 * "Assign…" button and the keyboard, or by dragging a mission onto a team;
 * both open the same confirmation. The board follows the live stream and
 * reloads what changed; the map is optional and every layer has a list.
 * Replay walks the board through a past window for briefings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { openStream, type StreamState } from '../api/stream.ts';
import { DataTable, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import type { ConsoleMap, MapPoint } from '../ui/map.ts';
import { fromZoneInput, toZoneInput } from '../ui/time.ts';

interface Point {
  lat: number;
  lon: number;
}
export interface BoardTeam {
  id: string;
  version: number;
  key: string;
  name: string;
  kind: string;
  agency: string | null;
  callsign: string | null;
  skills: string[];
  equipment: string[];
  status: string | null;
  statusAt: string | null;
  suggestedStatus: string | null;
  checkedInCount: number;
  memberCount: number;
  checkInDueAt: string | null;
  position: (Point & { accuracyM: number | null; recordedAt: string; stale: boolean }) | null;
  assignments: { id: string; missionId: string; reference: string; state: string }[];
}
export interface BoardMission {
  id: string;
  version: number;
  reference: string;
  kind: string;
  state: string;
  priority: string;
  urgency: string;
  summary: string | null;
  requiredCredentials: string[];
  position: Point | null;
  assignedCount: number;
  createdAt: string;
}
interface Board {
  asOf: string;
  eventId: string;
  cursor: number;
  teams: BoardTeam[];
  queue: BoardMission[];
  active: BoardMission[];
  hazards: {
    id: string;
    kind: string;
    state: string;
    severity: string;
    summary: string | null;
    position: Point | null;
  }[];
  sites: { id: string; name: string; kind: string; status: string; position: Point | null }[];
  alerts: {
    id: string;
    version: number;
    kind: string;
    state: string;
    teamId: string | null;
    personnelId: string | null;
    raisedAt: string;
    position: Point | null;
  }[];
  /** DSP-03, MIS-01: open needs that are no mission yet (absent for roles that cannot read needs). */
  needs?: {
    id: string;
    category: string;
    referenceCode: string | null;
    createdAt: string;
    position: Point | null;
  }[];
  /** DSP-01: roads reported closed, impassable or down to one lane. */
  closures?: {
    id: string;
    name: string;
    status: string;
    reason: string | null;
    position: Point | null;
    reportedAt: string;
  }[];
  /** FLD-11: what workers saw at sites and resources they came across, not yet noted. */
  fieldReports?: {
    id: string;
    category: 'site_status' | 'resource_seen';
    siteId: string | null;
    siteName: string | null;
    siteStatus: string | null;
    resourceKind: string | null;
    place: string | null;
    note: string | null;
    position: Point | null;
    reportedAt: string;
  }[];
  counts: {
    teamsByStatus: Record<string, number>;
    queue: number;
    active: number;
    hazards: number;
    openAlerts: number;
    needs?: number;
    closures?: number;
    fieldReports?: number;
  };
}
interface Suggestion {
  teamId: string;
  name: string;
  agency: string | null;
  status: string | null;
  distanceM: number | null;
  etaMinutes: number | null;
  reasons: string[];
  cautions: string[];
}
interface EventRow {
  id: string;
  name: string;
  status: string;
}

export const STATUS_TEXT: Record<string, string> = {
  available: 'Available',
  en_route: 'En route',
  on_task: 'On task',
  break: 'On break',
  out_of_service: 'Out of service',
  overdue: 'Overdue check-in',
};
/** Shape and a letter for each status, so the board never relies on colour (WCAG 1.4.1). */
const STATUS_MARK: Record<
  string,
  { shape: MapPoint['shape']; mark: string; tone: MapPoint['tone'] }
> = {
  available: { shape: 'circle', mark: 'A', tone: 'ok' },
  en_route: { shape: 'diamond', mark: 'E', tone: 'busy' },
  on_task: { shape: 'square', mark: 'T', tone: 'busy' },
  break: { shape: 'circle', mark: 'B', tone: 'info' },
  out_of_service: { shape: 'square', mark: 'X', tone: 'danger' },
  overdue: { shape: 'triangle', mark: '!', tone: 'danger' },
};
const ALERT_TEXT: Record<string, string> = {
  help_button: 'Help button pressed',
  missed_check_in: 'Missed check-in',
  unacknowledged_assignment: 'Assignment not acknowledged',
  hazard_entry: 'Entered a hazard area',
  device_lost: 'Device reported lost',
};
const label = (s: string) => s.replace(/_/g, ' ');

export function useOpenEvents() {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<EventRow[]>('/events?limit=50')
      .then((rows) => live && setEvents(rows.filter((e) => e.status !== 'closed')))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, []);
  return { events, error };
}

export function EventPicker({
  events,
  value,
  onChange,
}: {
  events: EventRow[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <label className="inline">
      Event
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {events.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const s = status ?? 'unknown';
  const m = STATUS_MARK[s];
  return (
    <span className={`badge badge-team-${s}`}>
      <span aria-hidden="true">{m ? `${m.mark} ` : ''}</span>
      {STATUS_TEXT[s] ?? 'No status yet'}
    </span>
  );
}

function AssignPanel({
  mission,
  presetTeam,
  teams,
  onDone,
  onCancel,
}: {
  mission: BoardMission;
  presetTeam: string | null;
  teams: BoardTeam[];
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [teamId, setTeamId] = useState<string | null>(presetTeam);
  const [method, setMethod] = useState('app');
  const [override, setOverride] = useState('');
  const [conflicts, setConflicts] = useState<{ kind: string; detail: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    let live = true;
    api<{ suggestions: Suggestion[] }>(`/dispatch/suggest?missionId=${mission.id}`)
      .then((r) => live && setSuggestions(r.suggestions))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [mission.id]);
  const chosen = suggestions?.find((s) => s.teamId === teamId);
  const assign = async () => {
    if (!teamId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/missions/${mission.id}/assignments`, {
        body: {
          resources: [{ kind: 'team', id: teamId }],
          dispatch: { method },
          suggested: !!chosen,
          suggestionReasons: chosen?.reasons.slice(0, 10) ?? [],
          ...(override.trim() ? { overrideReason: override.trim() } : {}),
        },
      });
      const name = teams.find((t) => t.id === teamId)?.name ?? 'the team';
      onDone(`${mission.reference} sent to ${name}, awaiting acknowledgement.`);
    } catch (e) {
      // AC-06C: the server names each resource's conflicts; an override needs a reason.
      const envelope = (e as { envelope?: { code?: string; details?: unknown } }).envelope;
      const found = (
        envelope?.details as
          { conflicts?: { conflicts: { kind: string; detail: string }[] }[] } | undefined
      )?.conflicts?.flatMap((c) => c.conflicts);
      if (envelope?.code === 'assignment_conflicts' && found?.length) setConflicts(found);
      setError(describeFailure(e));
    } finally {
      setBusy(false);
    }
  };
  const others = teams.filter((t) => !suggestions?.some((s) => s.teamId === t.id));
  return (
    <section className="panel" aria-labelledby="assign-h">
      <h2 id="assign-h" tabIndex={-1} ref={heading}>
        Assign {mission.reference}
      </h2>
      <p>{mission.summary ?? label(mission.kind)}</p>
      {error ? <Status kind="error">{error}</Status> : null}
      {suggestions === null && !error ? <p role="status">Finding teams…</p> : null}
      <fieldset>
        <legend>Team</legend>
        {suggestions?.map((s) => (
          <label key={s.teamId} className="inline" style={{ display: 'block', margin: '0.5rem 0' }}>
            <input
              type="radio"
              name="team"
              value={s.teamId}
              checked={teamId === s.teamId}
              onChange={() => setTeamId(s.teamId)}
            />{' '}
            <strong>{s.name}</strong>
            {s.agency ? ` · ${s.agency}` : ''} · {STATUS_TEXT[s.status ?? ''] ?? 'No status'}
            {s.etaMinutes !== null ? ` · about ${Math.round(s.etaMinutes)} min away` : ''}
            {s.reasons.length ? (
              <span className="hint"> — Suggested: {s.reasons.join('; ')}</span>
            ) : null}
            {s.cautions.length ? (
              <span className="hint"> — Check: {s.cautions.join('; ')}</span>
            ) : null}
          </label>
        ))}
        {others.length ? (
          <label className="inline">
            Another team
            <select
              value={others.some((t) => t.id === teamId) ? (teamId ?? '') : ''}
              onChange={(e) => setTeamId(e.target.value || null)}
            >
              <option value="">Choose…</option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({STATUS_TEXT[t.status ?? ''] ?? 'no status'})
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </fieldset>
      <label className="inline">
        Send by
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="app">Field app</option>
          <option value="text">Text message</option>
          <option value="radio">Radio</option>
          <option value="phone">Phone call</option>
          <option value="in_person">In person</option>
        </select>
      </label>
      {conflicts ? (
        <div className="panel">
          <p>
            <strong>This team has conflicts:</strong>
          </p>
          <ul>
            {conflicts.map((c, i) => (
              <li key={i}>{c.detail}</li>
            ))}
          </ul>
          <label className="inline">
            Why assign anyway (recorded)
            <textarea value={override} onChange={(e) => setOverride(e.target.value)} rows={2} />
          </label>
        </div>
      ) : null}
      <div className="actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!teamId || busy || (!!conflicts && override.trim().length < 3)}
          onClick={() => void assign()}
        >
          Assign and send
        </button>
      </div>
    </section>
  );
}

function AlertTakeover({
  alerts,
  teams,
  onAcknowledged,
}: {
  alerts: Board['alerts'];
  teams: BoardTeam[];
  onAcknowledged: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = alerts.filter((a) => a.state === 'open');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open.length && !d.open) d.showModal();
    if (!open.length && d.open) d.close();
  }, [open.length]);
  const ack = async (a: Board['alerts'][number]) => {
    try {
      await api(`/safety-alerts/${a.id}/acknowledge`, { body: {}, version: a.version });
      setError(null);
      onAcknowledged();
    } catch (e) {
      setError(describeFailure(e));
    }
  };
  return (
    <dialog
      ref={ref}
      className="takeover"
      aria-labelledby="takeover-h"
      // DSP-07, FLD-16: the alert stays until someone acknowledges it.
      onCancel={(e) => e.preventDefault()}
    >
      <h2 id="takeover-h">Alert: a team needs attention</h2>
      {error ? <Status kind="error">{error}</Status> : null}
      <ul>
        {open.map((a) => {
          const team = teams.find((t) => t.id === a.teamId);
          return (
            <li key={a.id} style={{ marginBottom: '0.75rem' }}>
              <strong>{ALERT_TEXT[a.kind] ?? label(a.kind)}</strong>
              {team ? ` — ${team.name}${team.callsign ? ` (${team.callsign})` : ''}` : ''} at{' '}
              {fmt(a.raisedAt)}
              {a.position
                ? ` · position ${a.position.lat.toFixed(5)}, ${a.position.lon.toFixed(5)}`
                : ''}
              <div className="actions" style={{ justifyContent: 'flex-start' }}>
                <button type="button" className="primary" onClick={() => void ack(a)}>
                  Acknowledge — I am handling this
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="hint">
        If anyone is in danger, call 911. This board does not dispatch police, fire or EMS.
      </p>
    </dialog>
  );
}

function BoardMap({ board }: { board: Board }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<ConsoleMap | null>(null);
  const [layers, setLayers] = useState<Set<string>>(
    new Set(['teams', 'work', 'needs', 'hazards', 'closures', 'sites', 'reports']),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const points = useMemo<MapPoint[]>(() => {
    const out: MapPoint[] = [];
    for (const t of board.teams)
      if (t.position) {
        const m = STATUS_MARK[t.status ?? ''] ?? {
          shape: 'circle' as const,
          mark: '?',
          tone: 'info' as const,
        };
        out.push({
          id: t.id,
          lat: t.position.lat,
          lon: t.position.lon,
          label: `${t.name}: ${STATUS_TEXT[t.status ?? ''] ?? 'no status'}${t.position.stale ? ', position is old' : ''}`,
          mark: m.mark,
          shape: m.shape,
          tone: m.tone,
          layer: 'teams',
        });
      }
    for (const m of [...board.queue, ...board.active])
      if (m.position)
        out.push({
          id: m.id,
          lat: m.position.lat,
          lon: m.position.lon,
          label: `${m.reference}: ${label(m.kind)}, ${m.assignedCount ? 'assigned' : 'not assigned'}`,
          mark: m.assignedCount ? 'W' : 'Q',
          shape: 'square',
          tone: m.assignedCount ? 'info' : 'warn',
          layer: 'work',
        });
    for (const h of board.hazards)
      if (h.position)
        out.push({
          id: h.id,
          lat: h.position.lat,
          lon: h.position.lon,
          label: `Hazard: ${label(h.kind)}, ${h.severity}`,
          mark: 'H',
          shape: 'triangle',
          tone: 'danger',
          layer: 'hazards',
        });
    for (const s of board.sites)
      if (s.position)
        out.push({
          id: s.id,
          lat: s.position.lat,
          lon: s.position.lon,
          label: `${s.name}: ${label(s.status)}`,
          mark: 'S',
          shape: 'circle',
          tone: 'info',
          layer: 'sites',
        });
    // DSP-01: open needs (at about a block), road closures and field reports, each also a list.
    for (const n of board.needs ?? [])
      if (n.position)
        out.push({
          id: n.id,
          lat: n.position.lat,
          lon: n.position.lon,
          label: `Need: ${label(n.category)}${n.referenceCode ? ` (${n.referenceCode})` : ''}, no mission yet`,
          mark: 'N',
          shape: 'diamond',
          tone: 'warn',
          layer: 'needs',
        });
    for (const c of board.closures ?? [])
      if (c.position)
        out.push({
          id: c.id,
          lat: c.position.lat,
          lon: c.position.lon,
          label: `Road ${c.name}: ${label(c.status)}`,
          mark: 'X',
          shape: 'square',
          tone: 'danger',
          layer: 'closures',
        });
    for (const r of board.fieldReports ?? [])
      if (r.position)
        out.push({
          id: r.id,
          lat: r.position.lat,
          lon: r.position.lon,
          label:
            r.category === 'site_status'
              ? `Field report: ${r.siteName ?? 'a site'} seen ${label(r.siteStatus ?? 'other')}`
              : `Field report: ${label(r.resourceKind ?? 'resource')} seen${r.place ? ` at ${r.place}` : ''}`,
          mark: 'R',
          shape: 'diamond',
          tone: 'info',
          layer: 'reports',
        });
    return out;
  }, [board]);
  useEffect(() => {
    let alive = true;
    void import('../ui/map.ts').then(({ openMap }) => {
      if (!alive || !box.current) return;
      map.current = openMap(box.current, (p) => setPicked(p.label));
      map.current.setPoints(points, layers);
    });
    return () => {
      alive = false;
      map.current?.destroy();
      map.current = null;
    };
    // The map is created once; points and layers update it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    map.current?.setPoints(points, layers);
  }, [points, layers]);
  const toggle = (l: string) =>
    setLayers((cur) => {
      const next = new Set(cur);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });
  return (
    <section aria-labelledby="map-h">
      <h2 id="map-h">Map</h2>
      <div className="layer-toggles" role="group" aria-label="Map layers">
        {[
          ['teams', 'Teams'],
          ['work', 'Work'],
          ['needs', 'Needs'],
          ['hazards', 'Hazards'],
          ['closures', 'Road closures'],
          ['sites', 'Sites'],
          ['reports', 'Field reports'],
        ].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={layers.has(k!)} onClick={() => toggle(k!)}>
            {l}
          </button>
        ))}
      </div>
      {picked ? <p role="status">{picked}</p> : null}
      <div
        ref={box}
        className="map"
        role="region"
        aria-label="Map of teams, work, needs, hazards, road closures, sites and field reports. The lists below show the same."
      />
    </section>
  );
}

export function DispatchScreen() {
  const { events, error: eventsError } = useOpenEvents();
  const [eventId, setEventId] = useState<string | null>(null);
  const currentEvent = eventId ?? events?.[0]?.id ?? null;
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<StreamState>('connecting');
  const [assigning, setAssigning] = useState<{ mission: BoardMission; team: string | null } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [filter, setFilter] = useState({ status: '', agency: '', skill: '', text: '' });
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!currentEvent) return;
    let liveFlag = true;
    api<Board>(`/dispatch/board?eventId=${currentEvent}`)
      .then((b) => {
        if (!liveFlag) return;
        setBoard(b);
        setError(null);
      })
      .catch((e: unknown) => liveFlag && setError(describeFailure(e)));
    return () => {
      liveFlag = false;
    };
  }, [currentEvent, tick]);
  // DSP-01: follow the live stream; any change reloads the snapshot (debounced).
  const cursor = board?.cursor ?? null;
  const hasBoard = cursor !== null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hasBoard || cursor === null) return;
    const stop = openStream({
      from: cursor,
      types: [
        'team',
        'team_status',
        'mission',
        'assignment',
        'hazard',
        'safety_alert',
        'site',
        'check_in',
      ],
      onState: setLive,
      onChange: () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(reload, 600);
      },
    });
    return () => {
      stop();
      if (timer.current) clearTimeout(timer.current);
    };
    // Reconnect only when the event changes; the stream resumes from its own last id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBoard, currentEvent, reload]);
  const teams = useMemo(() => {
    if (!board) return [];
    return board.teams.filter(
      (t) =>
        (!filter.status || t.status === filter.status) &&
        (!filter.agency || (t.agency ?? '') === filter.agency) &&
        (!filter.skill || t.skills.includes(filter.skill)) &&
        (!filter.text ||
          `${t.name} ${t.callsign ?? ''}`.toLowerCase().includes(filter.text.toLowerCase())),
    );
  }, [board, filter]);
  const agencies = useMemo(
    () => [...new Set((board?.teams ?? []).map((t) => t.agency ?? ''))].filter(Boolean),
    [board],
  );
  const skills = useMemo(
    () => [...new Set((board?.teams ?? []).flatMap((t) => t.skills))].sort(),
    [board],
  );
  if (eventsError) return <Status kind="error">{eventsError}</Status>;
  return (
    <section aria-labelledby="dispatch-h">
      <h1 id="dispatch-h">Dispatch board</h1>
      <p className="hint">Volunteer and resource coordination, not 911 dispatch.</p>
      <Toolbar>
        {events?.length ? (
          <EventPicker events={events} value={currentEvent} onChange={setEventId} />
        ) : null}
        <span role="status" aria-live="polite">
          {live === 'live'
            ? 'Live'
            : live === 'reconnecting'
              ? 'Reconnecting… (the board is still shown)'
              : 'Connecting…'}
          {board ? ` · as of ${fmt(board.asOf)}` : ''}
        </span>
        <button type="button" aria-pressed={showMap} onClick={() => setShowMap((v) => !v)}>
          {showMap ? 'Hide map' : 'Show map'}
        </button>
      </Toolbar>
      {error ? <Status kind="error">{error}</Status> : null}
      {notice ? <Status kind="success">{notice}</Status> : null}
      {events?.length === 0 ? <p>No open events.</p> : null}
      {board ? (
        <>
          <AlertTakeover alerts={board.alerts} teams={board.teams} onAcknowledged={reload} />
          <dl className="meta">
            <dt>Teams</dt>
            <dd>
              {Object.entries(board.counts.teamsByStatus)
                .map(([k, v]) => `${STATUS_TEXT[k] ?? label(k)}: ${v}`)
                .join(' · ') || 'none'}
            </dd>
            <dt>Waiting for a team</dt>
            <dd>{board.counts.queue}</dd>
            <dt>In progress</dt>
            <dd>{board.counts.active}</dd>
            <dt>Open alerts</dt>
            <dd>{board.counts.openAlerts}</dd>
            <dt>Needs with no mission</dt>
            <dd>{board.counts.needs ?? 0}</dd>
            <dt>Road closures</dt>
            <dd>{board.counts.closures ?? 0}</dd>
            <dt>Reports from the field not yet noted</dt>
            <dd>{board.counts.fieldReports ?? 0}</dd>
          </dl>
          {showMap ? <BoardMap board={board} /> : null}
          {assigning ? (
            <AssignPanel
              key={`${assigning.mission.id}-${assigning.team ?? ''}`}
              mission={assigning.mission}
              presetTeam={assigning.team}
              teams={board.teams}
              onCancel={() => setAssigning(null)}
              onDone={(m) => {
                setAssigning(null);
                setNotice(m);
                reload();
              }}
            />
          ) : null}
          <h2>Waiting for a team</h2>
          <p className="hint">Use “Assign…”, or drag a mission onto a team below.</p>
          <DataTable
            caption="Open work nobody holds, most urgent first"
            rows={board.queue}
            rowKey={(m) => m.id}
            empty="Nothing is waiting."
            columns={[
              {
                key: 'ref',
                header: 'Mission',
                render: (m) => (
                  <span draggable onDragStart={(e) => e.dataTransfer.setData('text/mission', m.id)}>
                    <a href={`/console/missions/${m.id}`}>{m.reference}</a>
                  </span>
                ),
              },
              { key: 'kind', header: 'Kind', render: (m) => label(m.kind) },
              {
                key: 'pri',
                header: 'Priority',
                render: (m) => `${m.priority}, ${label(m.urgency)}`,
              },
              { key: 'sum', header: 'Summary', render: (m) => m.summary ?? '—' },
              { key: 'age', header: 'Waiting since', render: (m) => fmt(m.createdAt) },
              {
                key: 'act',
                header: 'Action',
                render: (m) => (
                  <button type="button" onClick={() => setAssigning({ mission: m, team: null })}>
                    Assign {m.reference}…
                  </button>
                ),
              },
            ]}
          />
          {board.needs?.length ? (
            <>
              <h2>Needs with no mission yet</h2>
              <p className="hint">
                Making a mission links it to the need and its report, at the need&rsquo;s place;
                then assign it like any other.
              </p>
              <DataTable
                caption="Open needs nobody has made a mission for, oldest first"
                rows={board.needs}
                rowKey={(n) => n.id}
                columns={[
                  {
                    key: 'need',
                    header: 'Need',
                    render: (n) =>
                      `${label(n.category)}${n.referenceCode ? ` (${n.referenceCode})` : ''}`,
                  },
                  { key: 'age', header: 'Waiting since', render: (n) => fmt(n.createdAt) },
                  {
                    key: 'act',
                    header: 'Action',
                    render: (n) => (
                      <button
                        type="button"
                        onClick={() =>
                          void api<{ reference: string }>(`/needs/${n.id}/mission`, { body: {} })
                            .then((m) => setNotice(`Mission ${m.reference} made for the need.`))
                            .catch((e: unknown) => setNotice(describeFailure(e)))
                            .finally(reload)
                        }
                      >
                        Make a mission for {n.referenceCode ?? label(n.category)}
                      </button>
                    ),
                  },
                ]}
              />
            </>
          ) : null}
          {board.closures?.length ? (
            <>
              <h2>Road closures</h2>
              <DataTable
                caption="Roads reported closed, impassable or down to one lane"
                rows={board.closures}
                rowKey={(c) => c.id}
                columns={[
                  { key: 'road', header: 'Road', render: (c) => c.name },
                  { key: 'st', header: 'Status', render: (c) => label(c.status) },
                  { key: 'why', header: 'Reason', render: (c) => c.reason ?? '—' },
                  { key: 'at', header: 'Reported', render: (c) => fmt(c.reportedAt) },
                ]}
              />
            </>
          ) : null}
          {board.fieldReports?.length ? (
            <>
              <h2>Reports from the field</h2>
              <p className="hint">
                What workers saw at a site or a resource they came across. A site report is not the
                site&rsquo;s status: the site&rsquo;s lead confirms that.
              </p>
              <DataTable
                caption="Site status and resources seen, newest first"
                rows={board.fieldReports}
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: 'what',
                    header: 'Report',
                    render: (r) =>
                      r.category === 'site_status'
                        ? `${r.siteName ?? 'A site'}: seen ${label(r.siteStatus ?? 'other')}`
                        : `Resource seen: ${label(r.resourceKind ?? 'other')}${r.place ? ` at ${r.place}` : ''}`,
                  },
                  { key: 'note', header: 'Note', render: (r) => r.note ?? '—' },
                  {
                    key: 'where',
                    header: 'Where',
                    render: (r) =>
                      r.position
                        ? `${r.position.lat.toFixed(4)}, ${r.position.lon.toFixed(4)}`
                        : 'No pin',
                  },
                  { key: 'at', header: 'Reported', render: (r) => fmt(r.reportedAt) },
                  {
                    key: 'act',
                    header: 'Action',
                    render: (r) => (
                      <button
                        type="button"
                        onClick={() =>
                          void api(`/field-records/field_report/${r.id}/note`, { body: {} })
                            .then(() => setNotice('Report marked noted.'))
                            .catch((e: unknown) => setNotice(describeFailure(e)))
                            .finally(reload)
                        }
                      >
                        Mark noted:{' '}
                        {r.category === 'site_status'
                          ? (r.siteName ?? 'site report')
                          : label(r.resourceKind ?? 'resource')}
                      </button>
                    ),
                  },
                ]}
              />
            </>
          ) : null}
          <h2>Teams</h2>
          <div className="filters">
            <label>
              Status
              <select
                value={filter.status}
                onChange={(e) => setFilter({ ...filter, status: e.target.value })}
              >
                <option value="">All</option>
                {Object.entries(STATUS_TEXT).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Agency
              <select
                value={filter.agency}
                onChange={(e) => setFilter({ ...filter, agency: e.target.value })}
              >
                <option value="">All</option>
                {agencies.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Skill
              <select
                value={filter.skill}
                onChange={(e) => setFilter({ ...filter, skill: e.target.value })}
              >
                <option value="">All</option>
                {skills.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name or callsign
              <input
                value={filter.text}
                onChange={(e) => setFilter({ ...filter, text: e.target.value })}
              />
            </label>
          </div>
          <div className="table-wrap" role="region" aria-label="Teams" tabIndex={0}>
            <table>
              <caption>Teams on this event</caption>
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  <th scope="col">Status</th>
                  <th scope="col">Checked in</th>
                  <th scope="col">Next check-in</th>
                  <th scope="col">Position</th>
                  <th scope="col">Work held</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <tr
                    key={t.id}
                    className={dragOver === t.id ? 'drop-target' : undefined}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('text/mission')) {
                        e.preventDefault();
                        setDragOver(t.id);
                      }
                    }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(null);
                      const m = board.queue.find(
                        (x) => x.id === e.dataTransfer.getData('text/mission'),
                      );
                      if (m) setAssigning({ mission: m, team: t.id });
                    }}
                  >
                    <th scope="row">
                      {t.name}
                      {t.callsign ? ` (${t.callsign})` : ''}
                      {t.agency ? <span className="hint"> · {t.agency}</span> : null}
                    </th>
                    <td>
                      <StatusBadge status={t.status} />
                      {t.suggestedStatus && t.suggestedStatus !== t.status ? (
                        <span className="hint"> · may be {STATUS_TEXT[t.suggestedStatus]}</span>
                      ) : null}
                    </td>
                    <td>
                      {t.checkedInCount} of {t.memberCount}
                    </td>
                    <td>{t.checkInDueAt ? fmt(t.checkInDueAt) : '—'}</td>
                    <td>
                      {t.position
                        ? `${t.position.lat.toFixed(4)}, ${t.position.lon.toFixed(4)}${t.position.stale ? ' (old)' : ''}`
                        : 'Not shared'}
                    </td>
                    <td>
                      {t.assignments.map((a) => `${a.reference} (${label(a.state)})`).join(', ') ||
                        '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>In progress</h2>
          <DataTable
            caption="Open missions with a team"
            rows={board.active}
            rowKey={(m) => m.id}
            empty="Nothing in progress."
            columns={[
              {
                key: 'ref',
                header: 'Mission',
                render: (m) => <a href={`/console/missions/${m.id}`}>{m.reference}</a>,
              },
              { key: 'kind', header: 'Kind', render: (m) => label(m.kind) },
              { key: 'state', header: 'State', render: (m) => label(m.state) },
              { key: 'sum', header: 'Summary', render: (m) => m.summary ?? '—' },
            ]}
          />
          <h2>Hazards</h2>
          <DataTable
            caption="Hazards on this event"
            rows={board.hazards}
            rowKey={(h) => h.id}
            empty="No hazards."
            columns={[
              { key: 'kind', header: 'Hazard', render: (h) => label(h.kind) },
              { key: 'sev', header: 'Severity', render: (h) => h.severity },
              { key: 'state', header: 'State', render: (h) => label(h.state) },
              { key: 'sum', header: 'Summary', render: (h) => h.summary ?? '—' },
            ]}
          />
        </>
      ) : !error ? (
        <p role="status">Loading the board…</p>
      ) : null}
    </section>
  );
}

interface Replay {
  from: string;
  to: string;
  initial: { teamId: string; status: string | null; at: string | null }[];
  facts: {
    at: string;
    kind: string;
    recordType: string;
    teamId: string | null;
    missionId: string | null;
    from: string | null;
    to: string | null;
    summary: string | null;
  }[];
  truncated: boolean;
}

/** DSP-12: the board as it was, step by step, for briefings and after-action reviews. */
export function ReplayScreen() {
  const { events } = useOpenEvents();
  const [eventId, setEventId] = useState<string | null>(null);
  const currentEvent = eventId ?? events?.[0]?.id ?? null;
  const [from, setFrom] = useState(() => toZoneInput(new Date(Date.now() - 4 * 3_600_000)));
  const [to, setTo] = useState(() => toZoneInput(new Date()));
  const [replay, setReplay] = useState<Replay | null>(null);
  const [teams, setTeams] = useState<BoardTeam[]>([]);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (!currentEvent) return;
    try {
      const [r, b] = await Promise.all([
        api<Replay>(
          `/dispatch/replay?eventId=${currentEvent}&from=${fromZoneInput(from).toISOString()}&to=${fromZoneInput(to).toISOString()}`,
        ),
        api<Board>(`/dispatch/board?eventId=${currentEvent}`),
      ]);
      setReplay(r);
      setTeams(b.teams);
      setStep(r.facts.length);
      setError(null);
    } catch (e) {
      setError(describeFailure(e));
    }
  };
  const statusAt = useMemo(() => {
    const m = new Map<string, string | null>();
    if (!replay) return m;
    for (const i of replay.initial) m.set(i.teamId, i.status);
    for (const f of replay.facts.slice(0, step))
      if (f.teamId && f.recordType === 'team_status' && f.to) m.set(f.teamId, f.to);
    return m;
  }, [replay, step]);
  const at = replay ? (replay.facts[step - 1]?.at ?? replay.from) : null;
  return (
    <section aria-labelledby="replay-h">
      <h1 id="replay-h">Board replay</h1>
      <p className="hint">
        Step through what happened, for briefings. Nothing here changes a record.
      </p>
      <div className="filters">
        {events?.length ? (
          <EventPicker events={events} value={currentEvent} onChange={setEventId} />
        ) : null}
        <label>
          From
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="primary" onClick={() => void load()}>
          Load
        </button>
      </div>
      {error ? <Status kind="error">{error}</Status> : null}
      {replay ? (
        <>
          <label className="inline">
            Step {step} of {replay.facts.length}
            {at ? ` · ${fmt(at)}` : ''}
            <input
              type="range"
              min={0}
              max={replay.facts.length}
              value={step}
              onChange={(e) => setStep(Number(e.target.value))}
            />
          </label>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))}>
              Previous
            </button>
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(replay.facts.length, s + 1))}
            >
              Next
            </button>
          </div>
          {replay.truncated ? (
            <Status kind="info">
              Only the first part of this window is shown; choose a shorter window.
            </Status>
          ) : null}
          <DataTable
            caption={`Team status at ${at ? fmt(at) : 'the start'}`}
            rows={teams}
            rowKey={(t) => t.id}
            columns={[
              { key: 'n', header: 'Team', render: (t) => t.name },
              {
                key: 's',
                header: 'Status',
                render: (t) => <StatusBadge status={statusAt.get(t.id) ?? null} />,
              },
            ]}
          />
          <h2>What happened</h2>
          <ol aria-label="Events in order">
            {replay.facts.slice(Math.max(0, step - 15), step).map((f, i) => (
              <li key={`${f.at}-${i}`}>
                {fmt(f.at)} —{' '}
                {f.summary ??
                  `${label(f.recordType)} ${label(f.kind)}${f.to ? ` → ${label(f.to)}` : ''}`}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}

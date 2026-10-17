/**
 * The wall display (CON-11; layer-8 plan §5): one event's briefing for the
 * EOC wall, in large type with high contrast, refreshed on the county's
 * interval and announced politely; motion reduced. Counts, place names and
 * the event log only: the payload holds no resident, no home address and no
 * staff contact. Meant for a display account that holds `briefing.read`
 * and nothing else, so the shared screen never carries a person's session.
 */
import { useCallback, useEffect, useState } from 'react';
import { applyMode, StatTile, Tiles } from '@cg/ui';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Status, fmt } from '../ui/primitives.tsx';

interface EventRow {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'closed';
}
interface Briefing {
  asOf: string;
  refreshSeconds: number;
  event: { id: string; name: string; hazardType: string; status: string; openedAt: string | null };
  damage: { byDegree: Record<string, number>; verified: number; awaitingReview: number };
  shelters: { name: string; status: string; capacity: number | null; occupancy: number | null }[];
  needs: { open: number; byCategory: Record<string, number> };
  missions: { byState: Record<string, number> };
  resourceRequests: { byStatus: Record<string, number> };
  objectives: { position: number; objective: string; owner: string | null; status: string }[];
  significantEvents: { occurredAt: string; kind: string; summary: string }[];
  liveConditions: { kind: string; summary: string; source: string; asOf: string }[];
}

const DEGREE: [string, string][] = [
  ['destroyed', 'Destroyed'],
  ['major', 'Major'],
  ['minor', 'Minor'],
  ['affected', 'Affected'],
];
const words = (k: string) => k.replace(/_/g, ' ');
const sum = (o: Record<string, number>, keys: string[]) =>
  keys.reduce((a, k) => a + (o[k] ?? 0), 0);

export function WallScreen({ eventId: wanted }: { eventId?: string | undefined }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [eventId, setEventId] = useState(wanted ?? '');
  const [data, setData] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    applyMode('briefing');
    return () => applyMode('normal');
  }, []);

  useEffect(() => {
    let live = true;
    api<EventRow[]>('/events')
      .then((d) => {
        if (!live) return;
        setEvents(d);
        const first = d.find((e) => e.status === 'active') ?? d[0];
        if (first) setEventId((cur) => cur || first.id);
      })
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(() => {
    if (!eventId) return;
    api<Briefing>(`/briefing?eventId=${eventId}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(describeFailure(e)));
  }, [eventId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!data) return;
    const id = window.setInterval(load, Math.max(15, data.refreshSeconds) * 1000);
    return () => window.clearInterval(id);
  }, [data, load]);

  const open = data ? sum(data.missions.byState, ['open', 'en_route', 'on_scene']) : 0;
  const requestsOpen = data
    ? sum(data.resourceRequests.byStatus, ['submitted', 'approved', 'placed', 'en_route'])
    : 0;
  const sheltered = data ? data.shelters.reduce((a, s) => a + (s.occupancy ?? 0), 0) : 0;

  return (
    <section aria-labelledby="wall-h" className="cg-wall">
      <h1 id="wall-h">Wall display{data ? `: ${data.event.name}` : ''}</h1>
      {events && events.length > 1 ? (
        <p>
          <label>
            Event{' '}
            <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </select>
          </label>
        </p>
      ) : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {!data && !error ? <p role="status">Loading the briefing…</p> : null}
      {data ? (
        <>
          <p className="cg-briefing-bar" role="status" aria-live="polite">
            As of {fmt(data.asOf)}; refreshes every {data.refreshSeconds} seconds. Counts, places
            and the event log only: no personal details.
          </p>
          <Tiles>
            <StatTile
              label="Homes with verified damage"
              value={data.damage.verified}
              detail={DEGREE.map(([k, l]) => `${l} ${data.damage.byDegree[k] ?? 0}`).join(' · ')}
            />
            <StatTile
              label="Reports awaiting review"
              value={data.damage.awaitingReview}
              {...(data.damage.awaitingReview > 100 ? { tone: 'warn' as const } : {})}
            />
            <StatTile label="Open needs" value={data.needs.open} />
            <StatTile
              label="People in shelters"
              value={sheltered}
              detail={`${data.shelters.length} shelter${data.shelters.length === 1 ? '' : 's'} open`}
            />
            <StatTile
              label="Missions under way"
              value={open}
              detail={Object.entries(data.missions.byState)
                .map(([k, n]) => `${words(k)} ${n}`)
                .join(' · ')}
            />
            <StatTile
              label="Resource requests open"
              value={requestsOpen}
              detail={Object.entries(data.resourceRequests.byStatus)
                .map(([k, n]) => `${words(k)} ${n}`)
                .join(' · ')}
            />
          </Tiles>

          <section aria-labelledby="wall-shelters-h" className="panel">
            <h2 id="wall-shelters-h">Shelters</h2>
            <DataTable
              caption="Shelters open"
              rows={data.shelters}
              rowKey={(s) => s.name}
              empty="No shelter open."
              columns={[
                { key: 'n', header: 'Shelter', render: (s) => s.name },
                { key: 's', header: 'Status', render: (s) => words(s.status) },
                {
                  key: 'o',
                  header: 'Occupancy',
                  render: (s) =>
                    `${s.occupancy ?? '—'}${s.capacity !== null ? ` of ${s.capacity}` : ''}`,
                },
              ]}
            />
          </section>

          <section aria-labelledby="wall-obj-h" className="panel">
            <h2 id="wall-obj-h">Objectives of the operational period</h2>
            {data.objectives.length ? (
              <ol>
                {data.objectives.map((o) => (
                  <li key={o.position}>
                    {o.objective}
                    {o.owner ? ` — ${o.owner}` : ''}
                    {o.status !== 'open' ? ` (${o.status})` : ''}
                  </li>
                ))}
              </ol>
            ) : (
              <p>No objectives set for this period.</p>
            )}
          </section>

          <section aria-labelledby="wall-log-h" className="panel">
            <h2 id="wall-log-h">Last six hours</h2>
            <DataTable
              caption="Significant events, latest first"
              rows={data.significantEvents}
              rowKey={(e) => `${e.occurredAt}-${e.summary}`}
              empty="Nothing logged in the last six hours."
              columns={[
                { key: 'w', header: 'When', render: (e) => fmt(e.occurredAt) },
                { key: 'k', header: 'Kind', render: (e) => words(e.kind) },
                { key: 's', header: 'What', render: (e) => e.summary },
              ]}
            />
          </section>

          <section aria-labelledby="wall-live-h" className="panel">
            <h2 id="wall-live-h">Live conditions</h2>
            <DataTable
              caption="Live conditions with their source and age"
              rows={data.liveConditions}
              rowKey={(c) => `${c.kind}-${c.summary}`}
              empty="No live conditions feed is connected for this county."
              columns={[
                { key: 'k', header: 'Kind', render: (c) => words(c.kind) },
                { key: 's', header: 'Condition', render: (c) => c.summary },
                { key: 'src', header: 'Source', render: (c) => c.source },
                { key: 'a', header: 'As of', render: (c) => fmt(c.asOf) },
              ]}
            />
          </section>
        </>
      ) : null}
    </section>
  );
}

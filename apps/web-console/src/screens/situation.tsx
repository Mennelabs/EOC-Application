/**
 * Situation map (layer-4 plan console 12; CON-03, AC-03C, ACC-07, PUB-05,
 * CON-10): reports, danger flags, verified damage, needs, sites, teams,
 * hazards and the event's area. Each layer is a button with aria-pressed and
 * a table with the same items, so the map is never the only way to read it.
 * A layer the role does not include says so. Points marked approximate were
 * rounded for privacy. Danger flags are awareness only.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Status, Toolbar } from '../ui/primitives.tsx';
import type { ConsoleMap, MapPoint } from '../ui/map.ts';
import { EventPicker, useOpenEvents } from './dispatch.tsx';

interface Item {
  id: string;
  position: { lat: number; lon: number };
  approximate: boolean;
  label: string;
  state: string | null;
  detail: string | null;
}
interface Situation {
  asOf: string;
  layers: Record<string, { available: boolean; items: Item[] }>;
  footprint: unknown;
}
const LAYERS: {
  key: string;
  title: string;
  mark: string;
  shape: MapPoint['shape'];
  tone: MapPoint['tone'];
}[] = [
  { key: 'reports', title: 'Reports', mark: 'R', shape: 'circle', tone: 'info' },
  { key: 'dangerFlags', title: 'Danger flags', mark: '!', shape: 'triangle', tone: 'danger' },
  { key: 'verifiedDamage', title: 'Verified damage', mark: 'V', shape: 'square', tone: 'warn' },
  { key: 'needs', title: 'Needs', mark: 'N', shape: 'diamond', tone: 'busy' },
  { key: 'sites', title: 'Sites', mark: 'S', shape: 'circle', tone: 'ok' },
  { key: 'teams', title: 'Teams', mark: 'T', shape: 'square', tone: 'ok' },
  { key: 'hazards', title: 'Hazards', mark: 'H', shape: 'triangle', tone: 'danger' },
];
const label = (s: string | null) => (s ? s.replace(/_/g, ' ') : '—');

export function SituationScreen() {
  const { events } = useOpenEvents();
  const [eventId, setEventId] = useState<string | null>(null);
  const currentEvent = eventId ?? events?.[0]?.id ?? null;
  const [data, setData] = useState<Situation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<Set<string>>(
    new Set(['reports', 'dangerFlags', 'sites', 'hazards']),
  );
  const [showMap, setShowMap] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<ConsoleMap | null>(null);
  useEffect(() => {
    if (!currentEvent) return;
    let live = true;
    api<Situation>(`/situation?eventId=${currentEvent}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [currentEvent]);
  const points = useMemo<MapPoint[]>(() => {
    if (!data) return [];
    return LAYERS.flatMap((l) =>
      (data.layers[l.key]?.items ?? []).map((i) => ({
        id: `${l.key}-${i.id}`,
        lat: i.position.lat,
        lon: i.position.lon,
        label: `${l.title}: ${i.label}${i.state ? `, ${label(i.state)}` : ''}${i.approximate ? ' (approximate)' : ''}`,
        mark: l.mark,
        shape: l.shape,
        tone: l.tone,
        layer: l.key,
      })),
    );
  }, [data]);
  useEffect(() => {
    if (!showMap) return;
    let alive = true;
    void import('../ui/map.ts').then(({ openMap }) => {
      if (!alive || !box.current) return;
      map.current = openMap(box.current, (p) => setPicked(p.label));
      map.current.setPoints(points, visible);
      map.current.setArea(data?.footprint ?? null);
    });
    return () => {
      alive = false;
      map.current?.destroy();
      map.current = null;
    };
    // Created when shown; points, layers and the area update it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMap]);
  useEffect(() => {
    map.current?.setPoints(points, visible);
  }, [points, visible]);
  useEffect(() => {
    map.current?.setArea(data?.footprint ?? null);
  }, [data]);
  const toggle = (k: string) =>
    setVisible((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  return (
    <section aria-labelledby="sit-h">
      <h1 id="sit-h">Situation map</h1>
      <p className="hint">
        Danger flags are for awareness: the resident was told to call 911. Approximate points were
        rounded to protect privacy.
      </p>
      <Toolbar>
        {events?.length ? (
          <EventPicker events={events} value={currentEvent} onChange={setEventId} />
        ) : null}
        <button type="button" aria-pressed={showMap} onClick={() => setShowMap((v) => !v)}>
          {showMap ? 'Hide map' : 'Show map'}
        </button>
      </Toolbar>
      {error ? <Status kind="error">{error}</Status> : null}
      <div className="layer-toggles" role="group" aria-label="Layers">
        {LAYERS.map((l) => (
          <button
            key={l.key}
            type="button"
            aria-pressed={visible.has(l.key)}
            onClick={() => toggle(l.key)}
          >
            {l.title}
            {data
              ? ` (${data.layers[l.key]?.available ? (data.layers[l.key]?.items.length ?? 0) : 'not in your role'})`
              : ''}
          </button>
        ))}
      </div>
      {data ? (
        <p>
          {data.footprint ? 'The event area is outlined on the map.' : 'No event area drawn yet.'}
        </p>
      ) : null}
      {picked ? <p role="status">{picked}</p> : null}
      {showMap ? (
        <div
          ref={box}
          className="map"
          role="region"
          aria-label="Situation map. The tables below show the same items."
        />
      ) : null}
      {data ? (
        LAYERS.filter((l) => visible.has(l.key)).map((l) => {
          const layer = data.layers[l.key];
          if (!layer?.available)
            return (
              <p key={l.key} className="hint">
                {l.title}: not included in your role.
              </p>
            );
          return (
            <DataTable
              key={l.key}
              caption={l.title}
              rows={layer.items}
              rowKey={(i) => i.id}
              empty={`No ${l.title.toLowerCase()} for this event.`}
              columns={[
                { key: 'l', header: 'Item', render: (i) => i.label },
                { key: 's', header: 'State', render: (i) => label(i.state) },
                { key: 'd', header: 'Detail', render: (i) => i.detail ?? '—' },
                {
                  key: 'p',
                  header: 'Where',
                  render: (i) =>
                    `${i.position.lat.toFixed(i.approximate ? 2 : 5)}, ${i.position.lon.toFixed(i.approximate ? 2 : 5)}${i.approximate ? ' (approximate)' : ''}`,
                },
              ]}
            />
          );
        })
      ) : !error ? (
        <p role="status">Loading…</p>
      ) : null}
    </section>
  );
}

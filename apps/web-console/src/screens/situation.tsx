/**
 * Situation map (layer-4 plan console 12; CON-03, AC-03C, ACC-07, PUB-05,
 * CON-10): reports, danger flags, verified damage, needs, sites, teams,
 * hazards, road closures, outages and the event's area. Each layer is a button with
 * aria-pressed and a table with the same items, so the map is never the only
 * way to read it. A layer the role does not include says so. Points marked
 * approximate were rounded for privacy. Danger flags are awareness only.
 *
 * Layer 6 (task J): the tracts can be shaded by damaged housing units, by
 * reports per 100 homes (the equity map, under-reported tracts outlined, small
 * numbers hidden, EQ-13), or by the Census profile; each shading names its
 * source and time and has a legend in words and a table by tract.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import { SHADE_COLORS, SHADE_UNKNOWN, type ConsoleMap, type MapPoint } from '../ui/map.ts';
import { EventPicker, useOpenEvents } from './dispatch.tsx';

interface Item {
  id: string;
  /** Null for an outage whose facility is not known: listed, not placed. */
  position: { lat: number; lon: number } | null;
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
  { key: 'roadClosures', title: 'Road closures', mark: 'X', shape: 'square', tone: 'danger' },
  // FL:FR-01: structures searched, so no block is searched twice.
  { key: 'searched', title: 'Searched', mark: 'SR', shape: 'circle', tone: 'ok' },
  { key: 'outages', title: 'Outages', mark: 'O', shape: 'diamond', tone: 'warn' },
];
const label = (s: string | null) => (s ? s.replace(/_/g, ' ') : '—');

type ShadeKey = 'damage' | 'coverage' | 'poverty' | 'limitedEnglish';
interface AreaLayer {
  available: boolean;
  title: string;
  unit: string;
  source: string | null;
  asOf: string | null;
  items: { geoid: string; value: number | null; flagged: boolean; detail: string | null }[];
}
interface Areas {
  basis: 'footprint' | 'county' | 'none';
  tracts: { geoid: string; name: string | null; geometry: unknown }[];
  tractSource: string | null;
  layers: Record<ShadeKey, AreaLayer>;
  outages: { available: boolean; source: string | null; asOf: string | null; items: Item[] };
}
const SHADES: { key: ShadeKey; title: string }[] = [
  { key: 'damage', title: 'Damaged housing units' },
  { key: 'coverage', title: 'Reports per 100 homes (equity)' },
  { key: 'poverty', title: 'Share below poverty' },
  { key: 'limitedEnglish', title: 'Limited-English households' },
];
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Five equal steps from the lowest to the highest value shown. */
function classes(values: (number | null)[]) {
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return { band: () => null, ranges: [] as string[] };
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const step = (hi - lo) / 5;
  const band = (v: number | null) =>
    v === null ? null : step === 0 ? 2 : Math.min(4, Math.floor((v - lo) / step));
  const ranges =
    step === 0
      ? [`${num(lo)} (every tract)`]
      : [0, 1, 2, 3, 4].map(
          (i) => `${num(lo + step * i)} to ${num(i === 4 ? hi : lo + step * (i + 1))}`,
        );
  return { band, ranges };
}

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
  const [areas, setAreas] = useState<Areas | null>(null);
  const [areasNote, setAreasNote] = useState<string | null>(null);
  const [shade, setShade] = useState<ShadeKey | 'none'>('none');
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<ConsoleMap | null>(null);
  // CON-02: an event made from a template opens with the template's layers on.
  const [layersFrom, setLayersFrom] = useState<string | null>(null);
  useEffect(() => {
    if (!currentEvent) return;
    let live = true;
    api<{ name: string; mapLayers: string[] }>(`/events/${currentEvent}/template`)
      .then((t) => {
        if (!live || !t.mapLayers.length) return;
        setVisible(new Set(t.mapLayers));
        setLayersFrom(t.name);
      })
      .catch(() => live && setLayersFrom(null));
    return () => {
      live = false;
    };
  }, [currentEvent]);
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
    api<Areas>(`/situation/areas?eventId=${currentEvent}`)
      .then((d) => {
        if (!live) return;
        setAreas(d);
        setAreasNote(null);
      })
      .catch(() => {
        if (!live) return;
        setAreas(null);
        setAreasNote('Tract shading and outages are not included in your role.');
      });
    return () => {
      live = false;
    };
  }, [currentEvent]);
  // Outages come with the area layers; those placed at a known facility go on the map.
  const layers = useMemo<Situation['layers'] | null>(
    () =>
      data
        ? {
            ...data.layers,
            outages: {
              available: areas?.outages.available ?? false,
              items: areas?.outages.items ?? [],
            },
          }
        : null,
    [data, areas],
  );
  const points = useMemo<MapPoint[]>(() => {
    if (!layers) return [];
    return LAYERS.flatMap((l) =>
      (layers[l.key]?.items ?? [])
        .flatMap((i) => (i.position ? [{ ...i, position: i.position }] : []))
        .map((i) => ({
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
  }, [layers]);
  const shading = useMemo(() => {
    if (!areas || shade === 'none') return null;
    const layer = areas.layers[shade];
    if (!layer.available) return null;
    const byTract = new Map(layer.items.map((i) => [i.geoid, i]));
    const { band, ranges } = classes(layer.items.map((i) => i.value));
    const rows = areas.tracts.map((t) => {
      const item = byTract.get(t.geoid);
      const value = item?.value ?? null;
      return {
        geoid: t.geoid,
        name: t.name ?? t.geoid,
        geometry: t.geometry,
        value,
        band: band(value),
        flagged: item?.flagged ?? false,
        detail: item?.detail ?? null,
      };
    });
    return { layer, rows, ranges };
  }, [areas, shade]);
  const areaLabel = useCallback(
    (r: { name: string; value: number | null; flagged: boolean }, layer: AreaLayer) =>
      `${r.name}: ${r.value === null ? 'unknown or fewer than 11' : `${num(r.value)} ${layer.unit}`}${r.flagged ? ', under-reported' : ''}`,
    [],
  );
  useEffect(() => {
    if (!showMap) return;
    let alive = true;
    void import('../ui/map.ts').then(({ openMap }) => {
      if (!alive || !box.current) return;
      map.current = openMap(box.current, (p) => setPicked(p.label));
      map.current.setPoints(points, visible);
      map.current.setArea(data?.footprint ?? null);
      map.current.setShading(
        shading
          ? shading.rows.map((r) => ({
              id: r.geoid,
              geometry: r.geometry,
              band: r.band,
              flagged: r.flagged,
              label: areaLabel(r, shading.layer),
            }))
          : null,
        setPicked,
      );
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
  useEffect(() => {
    map.current?.setShading(
      shading
        ? shading.rows.map((r) => ({
            id: r.geoid,
            geometry: r.geometry,
            band: r.band,
            flagged: r.flagged,
            label: areaLabel(r, shading.layer),
          }))
        : null,
      setPicked,
    );
  }, [shading, areaLabel]);
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
      {layersFrom ? (
        <p className="hint">Layers first shown are those of the {layersFrom} template.</p>
      ) : null}
      <div className="layer-toggles" role="group" aria-label="Layers">
        {LAYERS.map((l) => (
          <button
            key={l.key}
            type="button"
            aria-pressed={visible.has(l.key)}
            onClick={() => toggle(l.key)}
          >
            {l.title}
            {layers
              ? ` (${layers[l.key]?.available ? (layers[l.key]?.items.length ?? 0) : 'not in your role'})`
              : ''}
          </button>
        ))}
      </div>
      {areas ? (
        <fieldset className="shade-choice">
          <legend>Shade the tracts by</legend>
          <label className="inline">
            <input
              type="radio"
              name="shade"
              checked={shade === 'none'}
              onChange={() => setShade('none')}
            />{' '}
            Nothing
          </label>
          {SHADES.map((x) => (
            <label key={x.key} className="inline">
              <input
                type="radio"
                name="shade"
                checked={shade === x.key}
                disabled={!areas.layers[x.key].available}
                onChange={() => setShade(x.key)}
              />{' '}
              {x.title}
              {areas.layers[x.key].available ? '' : ' (not in your role)'}
            </label>
          ))}
        </fieldset>
      ) : areasNote ? (
        <p className="hint">{areasNote}</p>
      ) : null}
      {shading ? (
        <section aria-labelledby="shade-h">
          <h2 id="shade-h">{shading.layer.title} by tract</h2>
          <p className="hint">
            Source: {shading.layer.source ?? 'not loaded yet'}; as of {fmt(shading.layer.asOf)}.
            Tracts: {areas?.basis === 'footprint' ? "those in the event's area" : 'the county'}
            {areas?.tractSource ? ` (${areas.tractSource})` : ''}.
          </p>
          <ul className="legend" aria-label="Legend">
            {shading.ranges.map((r, i) => (
              <li key={r}>
                <span
                  className="swatch"
                  aria-hidden="true"
                  style={{ background: SHADE_COLORS[shading.ranges.length === 1 ? 2 : i] }}
                />{' '}
                {r} {shading.layer.unit}
              </li>
            ))}
            <li>
              <span className="swatch" aria-hidden="true" style={{ background: SHADE_UNKNOWN }} />{' '}
              {shade === 'coverage' ? 'Unknown or fewer than 11 reports' : 'Unknown'}
            </li>
            {shade === 'coverage' ? (
              <li>
                <span className="swatch flagged" aria-hidden="true" /> Heavy dashed outline:
                under-reported against the county&apos;s coverage threshold
              </li>
            ) : null}
          </ul>
          <DataTable
            caption={`${shading.layer.title} by tract`}
            rows={shading.rows}
            rowKey={(r) => r.geoid}
            empty="No tracts are loaded for this county yet."
            columns={[
              { key: 't', header: 'Tract', render: (r) => r.name },
              {
                key: 'v',
                header: shading.layer.unit.charAt(0).toUpperCase() + shading.layer.unit.slice(1),
                render: (r) =>
                  r.value === null
                    ? shade === 'coverage'
                      ? 'Unknown or fewer than 11'
                      : 'Unknown'
                    : num(r.value),
              },
              ...(shade === 'coverage'
                ? [
                    {
                      key: 'f',
                      header: 'Under-reported',
                      render: (r: { flagged: boolean }) => (r.flagged ? 'Yes' : 'No'),
                    },
                  ]
                : []),
              { key: 'd', header: 'Detail', render: (r) => r.detail ?? '—' },
            ]}
          />
        </section>
      ) : null}
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
      {layers ? (
        LAYERS.filter((l) => visible.has(l.key)).map((l) => {
          const layer = layers[l.key];
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
                    i.position
                      ? `${i.position.lat.toFixed(i.approximate ? 2 : 5)}, ${i.position.lon.toFixed(i.approximate ? 2 : 5)}${i.approximate ? ' (approximate)' : ''}`
                      : 'Place not known',
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

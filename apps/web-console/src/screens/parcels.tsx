/**
 * Parcels and route areas from the county's GIS (CON-17, SCL-13): the GIS
 * lead loads the county's parcel layer as GeoJSON exported from ArcGIS or
 * QGIS, choosing which of its properties hold the parcel id, address, city,
 * ZIP and units; the file goes up in batches and the screen says how many
 * were added, updated or refused, and why. Route polygons name the parcels
 * inside them; a draft verification route can open for each. Loading needs
 * a reason, written once for the whole file.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status } from '../ui/primitives.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';

interface Summary {
  parcels: number;
  bySource: { source: string; parcels: number }[];
  areas: { areaKey: string; parcels: number }[];
}
interface Feature {
  type: 'Feature';
  geometry: unknown;
  properties: Record<string, unknown> | null;
}
interface Problem {
  index: number;
  reason: string;
}

const BATCH = 1000;

/** Reads a GeoJSON FeatureCollection from a chosen file; null when it is not one. */
async function readFeatures(file: File): Promise<Feature[] | null> {
  try {
    const parsed = JSON.parse(await file.text()) as { type?: string; features?: Feature[] };
    return parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)
      ? parsed.features
      : null;
  } catch {
    return null;
  }
}
const propertiesOf = (features: Feature[]) =>
  [...new Set(features.slice(0, 50).flatMap((f) => Object.keys(f.properties ?? {})))].sort();

export function ParcelsScreen() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<Summary>('/parcels/summary')
      .then((s) => live && (setSummary(s), setError(null)))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [tick]);
  return (
    <section aria-labelledby="parcels-h">
      <h1 id="parcels-h">Parcels and routes</h1>
      <p>
        Load the county&apos;s parcel layer and its route areas from GIS as GeoJSON (export from
        ArcGIS, Survey123, Field Maps or QGIS). Field teams&apos; area packages and verification
        routes are cut from these parcels.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {summary ? (
        <p>
          {summary.parcels} parcels loaded
          {summary.bySource.length
            ? ` (${summary.bySource.map((s) => `${s.parcels} from ${s.source}`).join(', ')})`
            : ''}
          .
        </p>
      ) : null}
      <ParcelImport onDone={() => setTick((n) => n + 1)} />
      <RouteImport onDone={() => setTick((n) => n + 1)} />
      <DataTable
        caption="Route areas and their parcels"
        rows={summary?.areas ?? []}
        rowKey={(a) => a.areaKey}
        empty="No route areas yet."
        columns={[
          { key: 'a', header: 'Area', render: (a) => a.areaKey },
          { key: 'n', header: 'Parcels', render: (a) => String(a.parcels) },
        ]}
      />
    </section>
  );
}

function ParcelImport({ onDone }: { onDone: () => void }) {
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [props, setProps] = useState<string[]>([]);
  const [map, setMap] = useState({ parcelId: '', line1: '', city: '', postal: '', units: '' });
  const [reason, setReason] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const choose = async (file: File | undefined) => {
    setResult(null);
    setProblems([]);
    if (!file) return;
    const read = await readFeatures(file);
    if (!read) {
      setFeatures(null);
      setResult({ kind: 'error', text: 'That file is not a GeoJSON feature collection.' });
      return;
    }
    setFeatures(read);
    const p = propertiesOf(read);
    setProps(p);
    const guess = (names: string[]) =>
      p.find((k) => names.includes(k.toLowerCase().replace(/[^a-z0-9]/g, ''))) ?? '';
    setMap({
      parcelId: guess(['pin', 'parcelid', 'parcel', 'apn', 'parcelno', 'parcelnumber']),
      line1: guess(['siteaddr', 'siteaddress', 'address', 'situs', 'situsaddress']),
      city: guess(['city', 'sitecity', 'situscity']),
      postal: guess(['zip', 'zipcode', 'sitezip', 'postal', 'postcode']),
      units: guess(['units', 'unitcount', 'dwellingunits']),
    });
  };
  const load = async (e: FormEvent) => {
    e.preventDefault();
    if (!features) return;
    setResult(null);
    const totals = { inserted: 0, updated: 0, rejected: 0 };
    const found: Problem[] = [];
    try {
      for (let i = 0; i < features.length; i += BATCH) {
        setProgress(
          `Loading parcels ${i + 1} to ${Math.min(i + BATCH, features.length)} of ${features.length}…`,
        );
        const r = await api<typeof totals & { problems: Problem[] }>('/parcels/import', {
          body: {
            features: features.slice(i, i + BATCH),
            mapping: Object.fromEntries(Object.entries(map).filter(([, v]) => v)),
          },
          confirmation: { confirmed: true, reason: reason.trim() },
        });
        totals.inserted += r.inserted;
        totals.updated += r.updated;
        totals.rejected += r.rejected;
        found.push(...r.problems.map((p) => ({ ...p, index: p.index + i })));
      }
      setResult({
        kind: 'success',
        text: `${totals.inserted} parcels added, ${totals.updated} updated, ${totals.rejected} refused.`,
      });
      setProblems(found.slice(0, 50));
      onDone();
    } catch (err) {
      setResult({ kind: 'error', text: describeFailure(err) });
    }
    setProgress(null);
  };
  const select = (k: keyof typeof map, label: string, required = false) => (
    <Field label={label}>
      {({ id }) => (
        <select
          id={id}
          value={map[k]}
          required={required}
          onChange={(e) => setMap({ ...map, [k]: e.target.value })}
        >
          <option value="">{required ? 'Choose a property' : 'Not in this file'}</option>
          {props.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
  return (
    <form className="panel" onSubmit={(e) => void load(e)} aria-labelledby="parcel-import-h">
      <h2 id="parcel-import-h">Load parcels</h2>
      <Field label="Parcel layer (GeoJSON)" hint="Polygons; a parcel already loaded is updated.">
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            type="file"
            accept=".geojson,.json,application/geo+json,application/json"
            onChange={(e) => void choose(e.target.files?.[0])}
          />
        )}
      </Field>
      {features ? (
        <>
          <p>{features.length} features in the file. Which properties hold what?</p>
          <div className="form-grid">
            {select('parcelId', 'Parcel id', true)}
            {select('line1', 'Street address')}
            {select('city', 'City')}
            {select('postal', 'ZIP code')}
            {select('units', 'Number of units')}
          </div>
          <Field label="Reason" hint="Recorded in the audit log, for the whole file.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            )}
          </Field>
          <button
            type="submit"
            className="primary"
            disabled={!map.parcelId || reason.trim().length < 3 || progress !== null}
          >
            Load {features.length} parcels
          </button>
        </>
      ) : null}
      {progress ? <p role="status">{progress}</p> : null}
      {result ? <Status kind={result.kind}>{result.text}</Status> : null}
      {problems.length ? (
        <DataTable
          caption="Features refused"
          rows={problems}
          rowKey={(p) => String(p.index)}
          columns={[
            { key: 'i', header: 'Feature', render: (p) => String(p.index + 1) },
            { key: 'r', header: 'Why', render: (p) => p.reason },
          ]}
        />
      ) : null}
    </form>
  );
}

function RouteImport({ onDone }: { onDone: () => void }) {
  const { events } = useOpenEvents();
  const [eventId, setEventId] = useState<string | null>(null);
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [props, setProps] = useState<string[]>([]);
  const [nameProperty, setNameProperty] = useState('');
  const [missions, setMissions] = useState(true);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [routes, setRoutes] = useState<
    { name: string; areaKey: string; parcels: number; missionId: string | null }[]
  >([]);
  const currentEvent = eventId ?? events?.[0]?.id ?? null;
  const choose = async (file: File | undefined) => {
    setResult(null);
    setRoutes([]);
    if (!file) return;
    const read = await readFeatures(file);
    if (!read) {
      setFeatures(null);
      setResult({ kind: 'error', text: 'That file is not a GeoJSON feature collection.' });
      return;
    }
    setFeatures(read);
    const p = propertiesOf(read);
    setProps(p);
    setNameProperty(p.find((k) => /name|route|area/i.test(k)) ?? p[0] ?? '');
  };
  const load = async (e: FormEvent) => {
    e.preventDefault();
    if (!features) return;
    try {
      const r = await api<{
        routes: { name: string; areaKey: string; parcels: number; missionId: string | null }[];
        problems: Problem[];
      }>('/parcels/routes/import', {
        body: {
          features: features.slice(0, 500),
          nameProperty,
          ...(missions && currentEvent ? { missionsFor: currentEvent } : {}),
        },
        confirmation: { confirmed: true, reason: reason.trim() },
      });
      setRoutes(r.routes);
      setResult({
        kind: 'success',
        text:
          `${r.routes.length} route areas named.` +
          (r.problems.length ? ` ${r.problems.map((p) => p.reason).join('; ')}.` : ''),
      });
      onDone();
    } catch (err) {
      setResult({ kind: 'error', text: describeFailure(err) });
    }
  };
  return (
    <form className="panel" onSubmit={(e) => void load(e)} aria-labelledby="route-import-h">
      <h2 id="route-import-h">Load route areas</h2>
      <Field
        label="Route areas (GeoJSON)"
        hint="Polygons, each with a name; the parcels inside take that area."
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            type="file"
            accept=".geojson,.json,application/geo+json,application/json"
            onChange={(e) => void choose(e.target.files?.[0])}
          />
        )}
      </Field>
      {features ? (
        <>
          <p>{features.length} route areas in the file.</p>
          <Field label="Property that names each route">
            {({ id }) => (
              <select
                id={id}
                value={nameProperty}
                onChange={(e) => setNameProperty(e.target.value)}
              >
                {props.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {events?.length ? (
            <EventPicker events={events} value={currentEvent} onChange={setEventId} />
          ) : null}
          <label className="inline" style={{ flexDirection: 'row', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={missions}
              onChange={(e) => setMissions(e.target.checked)}
            />{' '}
            Open a draft verification route for each area in this event
          </label>
          <Field label="Reason for the routes" hint="Recorded in the audit log.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            )}
          </Field>
          <button
            type="submit"
            className="primary"
            disabled={!nameProperty || reason.trim().length < 3}
          >
            Load {features.length} route areas
          </button>
        </>
      ) : null}
      {result ? <Status kind={result.kind}>{result.text}</Status> : null}
      {routes.length ? (
        <DataTable
          caption="Route areas loaded"
          rows={routes}
          rowKey={(r) => r.areaKey}
          columns={[
            { key: 'n', header: 'Route', render: (r) => r.name },
            { key: 'p', header: 'Parcels inside', render: (r) => String(r.parcels) },
            {
              key: 'm',
              header: 'Verification route',
              render: (r) => (r.missionId ? 'Draft opened' : 'Not opened'),
            },
          ]}
        />
      ) : null}
    </form>
  );
}

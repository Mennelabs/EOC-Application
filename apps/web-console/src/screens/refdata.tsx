/**
 * Reference data (layer 6; ADR-0039, ADR-0041, SCL-09, SCL-06): public facts
 * about the county pulled from free federal sources or imported from a file.
 * A table first (ACC-07): each dataset, where it comes from, the snapshot in
 * use with its age, and the last attempt (a failed pull keeps the last good
 * data and says why). The planning/GIS lead can pull now and import a file
 * in three steps: choose the file, map its columns to the dataset's fields
 * (the check names rows and fields, never values), apply. Only geography
 * leaves the system.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, describeFailure, upload } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

type Dataset =
  | 'tract'
  | 'tract_profile'
  | 'structure'
  | 'flood_zone'
  | 'facility'
  | 'declaration'
  | 'nfip_summary'
  | 'risk'
  | 'alert'
  | 'power_outage';

const DATASET_NAMES: Record<Dataset, string> = {
  tract: 'Census tracts',
  tract_profile: 'Tract population profiles',
  structure: 'Structures',
  flood_zone: 'Flood hazard zones',
  facility: 'Critical facilities',
  declaration: 'Earlier disaster declarations',
  nfip_summary: 'Flood insurance in force',
  risk: 'Risk and social vulnerability',
  alert: 'Weather alerts',
  power_outage: 'Power outages',
};

interface Snapshot {
  id: string;
  dataset: Dataset;
  source: string;
  mode: 'pull' | 'recorded' | 'import';
  status: 'loading' | 'ready' | 'failed' | 'superseded';
  vintage: string | null;
  rowCount: number;
  error: string | null;
  retrievedAt: string;
}

interface SourceRow {
  dataset: Dataset;
  sources: { id: string; title: string; licence: string; refreshHours: number }[];
  current: Snapshot | null;
  ageHours: number | null;
  lastAttempt: Snapshot | null;
}

interface ImportRow {
  id: string;
  version: number;
  dataset: Dataset;
  fileName: string;
  format: 'csv' | 'geojson' | 'gpkg' | 'shapefile';
  columns: string[];
  fields: { name: string; kind: string; required: boolean }[];
  mapping: Record<string, string>;
  status:
    | 'uploading'
    | 'uploaded'
    | 'validating'
    | 'validated'
    | 'invalid'
    | 'applying'
    | 'applied'
    | 'failed';
  errors: { row?: number; field?: string; message: string }[];
  rowCount: number;
  uploadPath: string;
  createdAt: string;
}

const MODE: Record<Snapshot['mode'], string> = {
  pull: 'pulled',
  recorded: 'recorded exercise data',
  import: 'imported from a file',
};

const FORMATS: { ext: RegExp; format: ImportRow['format']; type: string }[] = [
  { ext: /\.csv$/i, format: 'csv', type: 'text/csv' },
  { ext: /\.(geo)?json$/i, format: 'geojson', type: 'application/geo+json' },
  { ext: /\.gpkg$/i, format: 'gpkg', type: 'application/geopackage+sqlite3' },
  { ext: /\.zip$/i, format: 'shapefile', type: 'application/zip' },
];

const FIELD_LABELS: Record<string, string> = {
  geoid: 'Census GEOID',
  tractGeoid: 'Tract GEOID',
  stateFips: 'State FIPS code',
  countyFips: 'County FIPS code',
  sourceId: 'Source ID',
  landM2: 'Land area (square metres)',
  valueUsd: 'Value (US dollars)',
  coverageUsd: 'Coverage (US dollars)',
  povertyPct: 'Below poverty (%)',
  snapHouseholdsPct: 'Households with SNAP (%)',
  ssiHouseholdsPct: 'Households with SSI (%)',
  age65Pct: 'Aged 65 and over (%)',
  disabilityPct: 'With a disability (%)',
  moe: 'Margins of error',
  nriRiskScore: 'National Risk Index score',
  nriRiskRating: 'National Risk Index rating',
  sviOverall: 'SVI overall (0 to 1)',
  sviThemes: 'SVI themes',
  areaKind: 'Area kind (county or tract)',
  areaId: 'Area ID',
  asOf: 'As of',
  alertId: 'Alert ID',
};

/** A field's name for people: the list above, else "medianHouseholdIncome" → "Median household income". */
const label = (field: string) => {
  const known = FIELD_LABELS[field];
  if (known) return known;
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const age = (hours: number | null) =>
  hours === null
    ? '—'
    : hours < 1
      ? 'under an hour'
      : hours < 48
        ? `${Math.round(hours)} hours`
        : `${Math.round(hours / 24)} days`;

export function RefdataScreen() {
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([
      api<SourceRow[]>('/refdata/sources'),
      api<ImportRow[]>('/refdata/imports?limit=20'),
    ])
      .then(([s, i]) => {
        setSources(s);
        setImports(i);
        setError(null);
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  }, []);
  useEffect(reload, [reload]);

  const pull = async (row: SourceRow) => {
    setMsg(null);
    try {
      await api(`/refdata/pull`, { body: { dataset: row.dataset } });
      setMsg(
        `${DATASET_NAMES[row.dataset]}: pull requested. The table updates when it finishes; reload in a minute.`,
      );
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };

  return (
    <section aria-labelledby="refdata-h">
      <h1 id="refdata-h">Reference data</h1>
      <p>
        Public facts about the county from free federal sources (Census Bureau, FEMA, USACE, CMS,
        National Weather Service), or from your own files. Only geography is sent to those services.
        A failed pull keeps the last good data in use.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      {sources === null && !error ? <p role="status">Loading reference data…</p> : null}
      {sources ? (
        <DataTable
          caption="Datasets and the data in use"
          rows={sources}
          rowKey={(r) => r.dataset}
          columns={[
            { key: 'dataset', header: 'Dataset', render: (r) => DATASET_NAMES[r.dataset] },
            {
              key: 'source',
              header: 'Source',
              render: (r) =>
                r.sources.length ? r.sources.map((s) => s.title).join('; ') : 'File import only',
            },
            {
              key: 'current',
              header: 'In use',
              render: (r) =>
                r.current
                  ? `${r.current.rowCount} rows, ${MODE[r.current.mode]}${r.current.vintage ? `, ${r.current.vintage}` : ''}`
                  : 'None yet',
            },
            { key: 'age', header: 'Age', render: (r) => age(r.ageHours) },
            {
              key: 'last',
              header: 'Last attempt',
              render: (r) =>
                !r.lastAttempt
                  ? '—'
                  : r.lastAttempt.status === 'failed'
                    ? `Failed ${fmt(r.lastAttempt.retrievedAt)}: ${r.lastAttempt.error ?? 'no reason given'}`
                    : `${r.lastAttempt.status === 'loading' ? 'Loading' : 'Succeeded'} ${fmt(r.lastAttempt.retrievedAt)}`,
            },
            {
              key: 'act',
              header: 'Action',
              render: (r) =>
                r.sources.length ? (
                  <button type="button" onClick={() => void pull(r)}>
                    Pull {DATASET_NAMES[r.dataset].toLowerCase()} now
                  </button>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      ) : null}
      <ImportWizard onDone={reload} />
      <h2>Recent imports</h2>
      <DataTable
        caption="Recent imports"
        rows={imports}
        rowKey={(r) => r.id}
        empty="No files imported yet."
        columns={[
          { key: 'file', header: 'File', render: (r) => r.fileName },
          { key: 'dataset', header: 'Dataset', render: (r) => DATASET_NAMES[r.dataset] },
          { key: 'status', header: 'Status', render: (r) => r.status },
          { key: 'rows', header: 'Rows', render: (r) => String(r.rowCount) },
          { key: 'when', header: 'Started', render: (r) => fmt(r.createdAt) },
        ]}
      />
    </section>
  );
}

function ImportWizard({ onDone }: { onDone: () => void }) {
  const [dataset, setDataset] = useState<Dataset>('facility');
  const [file, setFile] = useState<File | null>(null);
  const [licence, setLicence] = useState('');
  const [vintage, setVintage] = useState('');
  const [current, setCurrent] = useState<ImportRow | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const step = !current
    ? 1
    : ['validated', 'applying', 'applied', 'failed'].includes(current.status)
      ? 3
      : 2;

  // Focus follows the wizard to its next step (not on first load, which would scroll past the table).
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current !== step) stepHeading.current?.focus();
    shownStep.current = step;
  }, [step]);

  /** Waits for the worker's check or apply, reading the import every two seconds. */
  const settle = async (imp: ImportRow, until: ImportRow['status'][]) => {
    let latest = imp;
    for (let i = 0; i < 90 && !until.includes(latest.status); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      latest = await api<ImportRow>(`/refdata/imports/${imp.id}`);
      setCurrent(latest);
    }
    return latest;
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Choose a file.');
      return;
    }
    const kind = FORMATS.find((f) => f.ext.test(file.name));
    if (!kind) {
      setError('Use a CSV, GeoJSON, GeoPackage (.gpkg) or zipped Shapefile (.zip) file.');
      return;
    }
    setBusy(true);
    try {
      const created = await api<ImportRow>('/refdata/imports', {
        body: {
          clientUuid: crypto.randomUUID(),
          dataset,
          format: kind.format,
          fileName: file.name,
          bytes: file.size,
          licence,
          ...(vintage ? { vintage } : {}),
        },
      });
      const uploaded = await upload<ImportRow>(
        created.uploadPath.replace(/^\/api\/v1/, ''),
        file,
        kind.type,
      );
      // Columns whose names match a field are preselected; a person checks every one.
      const guess: Record<string, string> = {};
      for (const f of uploaded.fields) {
        const hit = uploaded.columns.find(
          (c) => c.toLowerCase().replace(/[^a-z0-9]/g, '') === f.name.toLowerCase(),
        );
        if (hit) guess[f.name] = hit;
      }
      setMapping(guess);
      setCurrent(uploaded);
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const check = async (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    setError(null);
    setBusy(true);
    try {
      const chosen = Object.fromEntries(Object.entries(mapping).filter(([, c]) => c));
      const saved = await api<ImportRow>(`/refdata/imports/${current.id}/mapping`, {
        method: 'PUT',
        body: { mapping: chosen },
        version: current.version,
      });
      setCurrent(saved);
      await settle(saved, ['validated', 'invalid']);
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!current) return;
    setError(null);
    setBusy(true);
    try {
      const started = await api<ImportRow>(`/refdata/imports/${current.id}/apply`, {
        body: {},
        version: current.version,
      });
      setCurrent(started);
      await settle(started, ['applied', 'failed']);
      onDone();
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setCurrent(null);
    setFile(null);
    setMapping({});
    setError(null);
  };

  return (
    <section aria-labelledby="import-h">
      <h2 id="import-h">Import a file</h2>
      <h3 ref={stepHeading} tabIndex={-1}>
        Step {step} of 3:{' '}
        {step === 1 ? 'choose the file' : step === 2 ? 'match its columns' : 'apply'}
      </h3>
      {error ? <Status kind="error">{error}</Status> : null}
      {busy ? <p role="status">Working…</p> : null}

      {step === 1 ? (
        <form onSubmit={(e) => void send(e)}>
          <Field label="Dataset">
            {({ id }) => (
              <select
                id={id}
                value={dataset}
                onChange={(e) => setDataset(e.target.value as Dataset)}
              >
                {(Object.keys(DATASET_NAMES) as Dataset[]).map((d) => (
                  <option key={d} value={d}>
                    {DATASET_NAMES[d]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="File"
            hint="CSV, GeoJSON, GeoPackage or a zipped Shapefile, in WGS 84 longitude and latitude. Areas need a geometry format; points in a CSV need latitude and longitude columns."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                type="file"
                aria-describedby={describedBy}
                accept=".csv,.geojson,.json,.gpkg,.zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                required
              />
            )}
          </Field>
          <Field
            label="Licence or terms"
            hint="For example: U.S. government work, or your county's own data."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={licence}
                onChange={(e) => setLicence(e.target.value)}
                required
              />
            )}
          </Field>
          <Field
            label="Edition (optional)"
            hint="For example: SVI 2022, or the date your GIS team exported it."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={vintage}
                onChange={(e) => setVintage(e.target.value)}
              />
            )}
          </Field>
          <button type="submit" className="primary" disabled={busy}>
            Upload and read columns
          </button>
        </form>
      ) : null}

      {step === 2 && current ? (
        <form onSubmit={(e) => void check(e)}>
          <p>
            {current.fileName} has {current.columns.length} columns. Match each field of{' '}
            {DATASET_NAMES[current.dataset].toLowerCase()} to a column; leave a field unmatched when
            the file does not have it. Required fields are marked.
          </p>
          {current.status === 'invalid' ? (
            <>
              <Status kind="error">
                The check found problems. Nothing was applied. Fix the matching or the file.
              </Status>
              <DataTable
                caption="Problems found by the check"
                rows={current.errors.map((e, i) => ({ ...e, i }))}
                rowKey={(e) => String(e.i)}
                columns={[
                  { key: 'row', header: 'Row', render: (e) => (e.row ? String(e.row) : '—') },
                  {
                    key: 'field',
                    header: 'Field',
                    render: (e) => (e.field ? label(e.field) : '—'),
                  },
                  { key: 'message', header: 'Problem', render: (e) => e.message },
                ]}
              />
            </>
          ) : null}
          <fieldset>
            <legend>Fields</legend>
            {current.fields.map((f) => (
              <Field key={f.name} label={`${label(f.name)}${f.required ? ' (required)' : ''}`}>
                {({ id }) => (
                  <select
                    id={id}
                    value={mapping[f.name] ?? ''}
                    onChange={(e) => setMapping({ ...mapping, [f.name]: e.target.value })}
                    aria-required={f.required || undefined}
                  >
                    <option value="">Not in this file</option>
                    {current.columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ))}
          </fieldset>
          <button
            type="submit"
            className="primary"
            disabled={busy || current.status === 'validating'}
          >
            Check the file
          </button>{' '}
          <button type="button" onClick={reset}>
            Start again
          </button>
        </form>
      ) : null}

      {step === 3 && current ? (
        <div>
          {current.status === 'validated' ? (
            <>
              <Status kind="success">
                The check passed: {current.rowCount} rows are ready. Applying makes them the{' '}
                {DATASET_NAMES[current.dataset].toLowerCase()} in use; the data in use now is kept
                as an earlier version.
              </Status>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void apply()}
              >
                Apply {current.rowCount} rows
              </button>
            </>
          ) : current.status === 'applying' ? (
            <p role="status">Applying…</p>
          ) : current.status === 'applied' ? (
            <Status kind="success">
              Applied: {DATASET_NAMES[current.dataset]} now come from {current.fileName}.
            </Status>
          ) : (
            <Status kind="error">
              Applying failed and nothing changed: {current.errors[0]?.message ?? 'no reason given'}
              .
            </Status>
          )}{' '}
          <button type="button" onClick={reset}>
            Import another file
          </button>
        </div>
      ) : null}
    </section>
  );
}

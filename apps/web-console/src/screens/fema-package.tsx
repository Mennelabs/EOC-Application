/**
 * The IDA package and its representative photos on the Declaration screen
 * (layer-6 task F; DCL:DEC-11, DEC-13, DEC-15, PHO-06, PHO-07, SEC-18, WCAG
 * 2.2 AA). Staff who may export ask for the package for the whole event or
 * one city; the worker makes it and the list shows when it is ready, with
 * its size, SHA-256 and totals, and a download (each download audited). The
 * photos section shows the photos chosen for the package and, to those who
 * may export, the photos cleared for sharing (blurred, no metadata) to
 * choose from: a caption, and the person's confirmation that the blurred
 * image shows nothing identifying.
 */
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { api, describeFailure, download } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

export interface ExportRow {
  id: string;
  kind: 'ida_package' | 'official_report' | 'public_records';
  format: 'zip' | 'pdf' | 'csv';
  jurisdictionTenantId: string | null;
  status: 'queued' | 'ready' | 'failed';
  fileName: string | null;
  bytes: number | null;
  sha256: string | null;
  figures: {
    countedUnits?: number;
    homes?: number;
    sites?: number;
    photos?: number;
    photosLeftOut?: number;
    contentHash?: string;
    /** SEC-13: a public-records release's rows per kind and columns withheld. */
    rows?: Record<string, number>;
    withheldColumns?: number;
  };
  scope?: {
    requestReference: string;
    recordTypes: string[];
    from: string | null;
    to: string | null;
  } | null;
  error: string | null;
  createdAt: string;
  readyAt: string | null;
}

const size = (b: number | null) =>
  b === null
    ? ''
    : b < 1024 * 1024
      ? `${Math.max(1, Math.round(b / 1024))} KB`
      : `${(b / 1024 / 1024).toFixed(1)} MB`;

/** The exports at `path`, checked again every few seconds while one is being made. */
export function useExports(path: string | null) {
  const [rows, setRows] = useState<ExportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!path) return;
    api<ExportRow[]>(path)
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  }, [path]);
  useEffect(load, [load]);
  const making = rows?.some((r) => r.status === 'queued') ?? false;
  useEffect(() => {
    if (!making) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [making, rows, load]);
  return { rows, error, reload: load };
}

/** One export's state in words, and its file to download when ready. */
export function ExportFile({ row, label }: { row: ExportRow; label: string }) {
  const [error, setError] = useState<string | null>(null);
  if (row.status === 'queued') return <span>Being made…</span>;
  if (row.status === 'failed') return <span>Failed: {row.error ?? 'unknown reason'}</span>;
  return (
    <>
      <button
        type="button"
        className="link"
        onClick={() => {
          setError(null);
          download(`/exports/${row.id}/file`, row.fileName ?? `export.${row.format}`).catch(
            (err: unknown) => setError(describeFailure(err)),
          );
        }}
      >
        Download {label}
      </button>{' '}
      <span className="hint">
        {row.fileName} ({size(row.bytes)})
      </span>
      {error ? <Status kind="error">{error}</Status> : null}
    </>
  );
}

interface Jurisdiction {
  id: string;
  name: string;
  kind: string;
}

export function PackageExports({ eventId, canExport }: { eventId: string; canExport: boolean }) {
  const { rows, error, reload } = useExports(`/events/${eventId}/exports`);
  const [cities, setCities] = useState<Jurisdiction[]>([]);
  const [scope, setScope] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api<Jurisdiction[]>('/tenants')
      .then((t) => live && setCities(t.filter((x) => x.kind === 'city')))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const nameOf = (id: string | null) =>
    id ? (cities.find((c) => c.id === id)?.name ?? 'One jurisdiction') : 'Whole event';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await api(`/events/${eventId}/exports`, {
        body: {
          clientUuid: crypto.randomUUID(),
          ...(scope ? { jurisdictionTenantId: scope } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      setMsg({
        kind: 'success',
        text: 'The package is being made. It appears below when it is ready.',
      });
      setReason('');
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="decl-package">
      <h2 id="decl-package">Damage assessment package</h2>
      <p>
        The package FEMA’s forms ask for, drafted for the state’s review and never sent from here:
        the summary and tick sheets, the cost survey, the site sheet, the Form 010-0-13 data, a CSV
        file per form, the GIS layer and the chosen photos. It holds counts and places generalized
        to a 100 m grid cell, never names, contact details or street addresses.
      </p>
      {canExport ? (
        <form onSubmit={(e) => void submit(e)} className="form-grid">
          <Field label="Package for">
            {({ id }) => (
              <select id={id} value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="">Whole event</option>
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Reason (optional)" hint="For the audit log, e.g. who asked for it.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <div className="toolbar">
            <button type="submit" className="primary" disabled={busy}>
              Make the package
            </button>
          </div>
        </form>
      ) : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {rows ? (
        <DataTable
          caption="Packages made for this event"
          rows={rows}
          rowKey={(r) => r.id}
          empty="No package has been made for this event yet."
          columns={[
            { key: 'at', header: 'Asked for', render: (r) => fmt(r.createdAt) },
            { key: 'scope', header: 'For', render: (r) => nameOf(r.jurisdictionTenantId) },
            {
              key: 'totals',
              header: 'Totals',
              render: (r) =>
                r.status === 'ready'
                  ? `${(r.figures.countedUnits ?? 0).toLocaleString('en-US')} housing units counted; ${(r.figures.homes ?? 0).toLocaleString('en-US')} homes listed; ${r.figures.photos ?? 0} photos`
                  : '',
            },
            {
              key: 'file',
              header: 'File',
              render: (r) =>
                canExport ? (
                  <ExportFile row={r} label={`package for ${nameOf(r.jurisdictionTenantId)}`} />
                ) : (
                  r.status
                ),
            },
            {
              key: 'hash',
              header: 'SHA-256',
              render: (r) => (r.sha256 ? <code className="hash">{r.sha256}</code> : ''),
            },
          ]}
        />
      ) : null}
    </section>
  );
}

interface Place {
  usng: string | null;
  postal: string | null;
  tract: string | null;
  jurisdiction: string | null;
  site: string | null;
}

interface Chosen {
  id: string;
  photoId: string;
  caption: string;
  subject: 'home' | 'public_site' | null;
  placeText: string | null;
  cleared: boolean;
  chosenBy: string | null;
  chosenAt: string;
  imageUrl: string | null;
}

interface Candidate {
  photoId: string;
  subject: 'home' | 'public_site';
  place: Place;
  placeText: string;
  takenOrUploadedAt: string | null;
  imageUrl: string | null;
}

const subjectName = (s: Chosen['subject']) =>
  s === 'public_site' ? 'Public damage site' : s === 'home' ? 'Home' : 'Unknown';

export function PackagePhotos({ eventId, canChoose }: { eventId: string; canChoose: boolean }) {
  const [chosen, setChosen] = useState<{ max: number; chosen: Chosen[] } | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const load = useCallback(() => {
    Promise.all([
      api<{ max: number; chosen: Chosen[] }>(`/events/${eventId}/package-photos`),
      canChoose
        ? api<Candidate[]>(`/events/${eventId}/package-photos/candidates`)
        : Promise.resolve(null),
    ])
      .then(([c, k]) => {
        setChosen(c);
        setCandidates(k);
        setError(null);
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  }, [eventId, canChoose]);
  useEffect(load, [load]);

  const remove = async (c: Chosen, n: number) => {
    setMsg(null);
    try {
      await api(`/events/${eventId}/package-photos/${c.id}`, { method: 'DELETE' });
      setMsg({ kind: 'success', text: `Photo ${n} taken out of the package.` });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };

  return (
    <section aria-labelledby="decl-photos">
      <h2 id="decl-photos">Representative photos</h2>
      <p>
        Photos chosen for the package. Only a photo whose faces, license plates and documents have
        been blurred, and whose metadata is removed, can be chosen; the package carries that blurred
        image. Its place is shown as a grid cell, ZIP, tract and jurisdiction.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {chosen ? (
        chosen.chosen.length === 0 ? (
          <p className="empty">No photo is chosen for the package yet.</p>
        ) : (
          <ol className="photo-grid" aria-label="Photos in the package">
            {chosen.chosen.map((c, i) => (
              <li key={c.id}>
                {c.imageUrl ? <img src={c.imageUrl} alt={c.caption} /> : null}
                <p>
                  <strong>Photo {i + 1}.</strong> {c.caption}
                </p>
                <p className="hint">
                  {subjectName(c.subject)} · {c.placeText ?? 'Place unknown'}
                  {c.chosenBy ? ` · chosen by ${c.chosenBy}` : ''}
                </p>
                {!c.cleared ? (
                  <p className="error">
                    No longer cleared for sharing: it will be left out of the package.
                  </p>
                ) : null}
                {canChoose ? (
                  <button type="button" onClick={() => void remove(c, i + 1)}>
                    Take photo {i + 1} out
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )
      ) : (
        <p role="status">Loading the photos…</p>
      )}
      {canChoose && candidates ? (
        <>
          <h3>Photos cleared for sharing</h3>
          {candidates.length === 0 ? (
            <p className="empty">
              No photo is cleared for sharing yet. A photo can be chosen once its faces, license
              plates and documents have been blurred automatically; until a detector is enabled for
              this county, photos stay with the case.
            </p>
          ) : (
            <ul className="photo-grid" aria-label="Photos you can choose">
              {candidates.map((c, i) => (
                <li key={c.photoId}>
                  <CandidateCard
                    candidate={c}
                    n={i + 1}
                    full={(chosen?.chosen.length ?? 0) >= (chosen?.max ?? 24)}
                    onChosen={(text) => {
                      setMsg({ kind: 'success', text });
                      load();
                    }}
                    eventId={eventId}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function CandidateCard({
  candidate: c,
  n,
  full,
  eventId,
  onChosen,
}: {
  candidate: Candidate;
  n: number;
  full: boolean;
  eventId: string;
  onChosen: (text: string) => void;
}) {
  const [caption, setCaption] = useState('');
  const [checked, setChecked] = useState(false);
  const [errors, setErrors] = useState<{ caption?: string; checked?: string; form?: string }>({});
  const checkId = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (caption.trim().length < 10)
      next.caption = 'Say what the photo shows in 10 to 200 characters.';
    if (!checked) next.checked = 'Confirm you looked at the blurred photo.';
    setErrors(next);
    if (next.caption || next.checked) return;
    try {
      await api(`/events/${eventId}/package-photos`, {
        body: { photoId: c.photoId, caption: caption.trim(), checked: true },
      });
      onChosen(`Photo added to the package: ${caption.trim()}`);
    } catch (err) {
      setErrors({ form: describeFailure(err) });
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} aria-label={`Cleared photo ${n}`}>
      {c.imageUrl ? (
        <img
          src={c.imageUrl}
          alt={`Cleared photo ${n}: ${subjectName(c.subject)}, ${c.placeText}`}
        />
      ) : null}
      <p className="hint">
        {subjectName(c.subject)} · {c.placeText}
        {c.takenOrUploadedAt ? ` · ${fmt(c.takenOrUploadedAt)}` : ''}
      </p>
      <Field
        label={`Caption for photo ${n}`}
        hint="What it shows, without names, addresses or phone numbers."
        {...(errors.caption ? { error: errors.caption } : {})}
      >
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            maxLength={200}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        )}
      </Field>
      <div className="field">
        <input
          id={checkId}
          type="checkbox"
          checked={checked}
          aria-describedby={errors.checked ? `${checkId}-err` : undefined}
          onChange={(e) => setChecked(e.target.checked)}
        />{' '}
        <label htmlFor={checkId}>
          I looked at this blurred photo: no face, license plate, document, house number or street
          sign can be read.
        </label>
        {errors.checked ? (
          <p id={`${checkId}-err`} className="error" role="alert">
            {errors.checked}
          </p>
        ) : null}
      </div>
      {errors.form ? <Status kind="error">{errors.form}</Status> : null}
      <button type="submit" disabled={full}>
        Add photo {n} to the package
      </button>
    </form>
  );
}

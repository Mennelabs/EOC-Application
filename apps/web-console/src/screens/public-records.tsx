/**
 * Records requests (SEC-13; WCAG 2.2 AA). A records officer prepares a
 * public-records release for one event: the request it answers, an optional
 * period and the kinds of record asked for. The worker makes a ZIP with one
 * CSV per kind, a README and REDACTIONS.csv; restricted, sensitive and
 * criminal-justice details, security values, links to people and places and
 * household needs are withheld, and confidential sites are left out. Only
 * kinds the person may read can be asked for; asking is confirmed with a
 * reason; every download is audited. A person reviews the file before it is
 * released.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { ExportFile, useExports } from './fema-package.tsx';

interface EventRow {
  id: string;
  name: string;
  status: string;
}

const KINDS: { key: string; label: string }[] = [
  { key: 'reports', label: 'Resident reports' },
  { key: 'needs', label: 'Needs' },
  { key: 'missions', label: 'Missions' },
  { key: 'mission_timeline', label: 'Mission timeline entries' },
  { key: 'sites', label: 'Sites (confidential sites are left out)' },
  { key: 'official_reports', label: 'Issued official reports' },
  { key: 'field_messages', label: 'Messages to field staff' },
  { key: 'comms_log', label: 'Radio and communications log' },
];

export function PublicRecordsScreen() {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [eventId, setEventId] = useState('');
  const [reference, setReference] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    // Requests often come after an event closes, so closed events are listed too.
    api<EventRow[]>('/events?limit=100')
      .then((r) => {
        if (!live) return;
        setEvents(r);
        setEventId((cur) => cur || r[0]?.id || '');
      })
      .catch((e: unknown) => live && setMsg({ kind: 'error', text: describeFailure(e) }));
    return () => {
      live = false;
    };
  }, []);
  const { rows, error, reload } = useExports(eventId ? `/events/${eventId}/public-records` : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!kinds.length) {
      setMsg({ kind: 'error', text: 'Choose at least one kind of record.' });
      return;
    }
    setBusy(true);
    try {
      await api(`/events/${eventId}/public-records`, {
        body: {
          clientUuid: crypto.randomUUID(),
          requestReference: reference.trim(),
          recordTypes: kinds,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      });
      setMsg({
        kind: 'success',
        text: 'The release is being prepared. It appears below when it is ready; review it before it goes out.',
      });
      setReference('');
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="prr-h">
      <h1 id="prr-h">Records requests</h1>
      <p>
        Prepare the records a public-records request asks for. Names, contact details, addresses,
        what residents wrote or said, notes and reasons, criminal-justice information, codes and
        links to people or places are withheld, column by column, and listed in REDACTIONS.csv in
        the file. Confidential sites are left out entirely. You can include only records you may
        read yourself. A person reviews the file before it is released: it is prepared from the
        records, it does not decide what the law exempts.
      </p>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {events && events.length === 0 ? <p className="empty">No events yet.</p> : null}
      {events && events.length > 0 ? (
        <form onSubmit={(e) => void submit(e)} className="form-grid">
          <Field label="Event">
            {({ id }) => (
              <select id={id} value={eventId} onChange={(e) => setEventId(e.target.value)}>
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.name}
                    {ev.status === 'closed' ? ' (closed)' : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Request reference"
            hint="As the records office numbers it, e.g. PRR-2026-014."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                required
                maxLength={80}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            )}
          </Field>
          <Field label="From (optional)">
            {({ id }) => (
              <input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            )}
          </Field>
          <Field label="To (optional)" hint="Records before this day.">
            {({ id, describedBy }) => (
              <input
                id={id}
                type="date"
                aria-describedby={describedBy}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            )}
          </Field>
          <fieldset>
            <legend>Kinds of record</legend>
            {KINDS.map((k) => (
              <label key={k.key} className="choice">
                <input
                  type="checkbox"
                  checked={kinds.includes(k.key)}
                  onChange={(e) =>
                    setKinds((cur) =>
                      e.target.checked ? [...cur, k.key] : cur.filter((x) => x !== k.key),
                    )
                  }
                />{' '}
                {k.label}
              </label>
            ))}
          </fieldset>
          <div className="toolbar">
            <button type="submit" className="primary" disabled={busy || !eventId}>
              Prepare the release…
            </button>
          </div>
        </form>
      ) : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {rows ? (
        <DataTable
          caption="Releases prepared for this event"
          rows={rows}
          rowKey={(r) => r.id}
          empty="No release has been prepared for this event."
          columns={[
            { key: 'at', header: 'Asked for', render: (r) => fmt(r.createdAt) },
            {
              key: 'ref',
              header: 'Request',
              render: (r) => r.scope?.requestReference ?? '—',
            },
            {
              key: 'what',
              header: 'Records',
              render: (r) =>
                r.figures.rows
                  ? Object.entries(r.figures.rows)
                      .map(([k, n]) => `${KINDS.find((x) => x.key === k)?.label ?? k}: ${n}`)
                      .join('; ')
                  : (r.scope?.recordTypes ?? []).join(', '),
            },
            {
              key: 'withheld',
              header: 'Columns withheld',
              render: (r) =>
                r.figures.withheldColumns === undefined ? '—' : String(r.figures.withheldColumns),
            },
            {
              key: 'file',
              header: 'File',
              render: (r) => (
                <ExportFile row={r} label={`release ${r.scope?.requestReference ?? ''}`} />
              ),
            },
          ]}
        />
      ) : null}
    </section>
  );
}

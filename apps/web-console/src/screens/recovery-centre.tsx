/**
 * Recovery centre (FL:FR-12; WCAG 2.2 AA). A MARC site's floor: the door
 * checks a survivor in with the tables to see, in order; each table's queue
 * shows who is waiting for it and how long; "hand to the next table" moves
 * the visit on with a one-line why, so the survivor does not retell their
 * story. A partner's table sees only the visits with a stop at its table and
 * its own hand-off notes. The queue carries a first name or the reference
 * code and the tables, never an address or a dollar.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

interface Site {
  id: string;
  name: string;
  status: string;
  waiting: number;
  inProgress: number;
}
interface Stop {
  id: string;
  seq: number;
  tableLabel: string;
  status: 'waiting' | 'current' | 'done' | 'skipped';
  handoffNote: string | null;
  handedBy: string | null;
  yours: boolean;
}
interface Visit {
  id: string;
  version: number;
  label: string;
  arrivedAt: string;
  status: 'waiting' | 'in_progress' | 'done' | 'left';
  endedAt: string | null;
  currentTable: string | null;
  waitingMinutes: number;
  stops: Stop[];
}

const STOP: Record<Stop['status'], string> = {
  waiting: 'to see',
  current: 'now',
  done: 'done',
  skipped: 'skipped',
};
const VISIT: Record<Visit['status'], string> = {
  waiting: 'Waiting',
  in_progress: 'On the floor',
  done: 'Done',
  left: 'Left early',
};

export function RecoveryCentreScreen() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [siteId, setSiteId] = useState('');
  const [table, setTable] = useState('');
  const [includeEnded, setIncludeEnded] = useState(false);
  const [queue, setQueue] = useState<Visit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [label, setLabel] = useState('');
  const [tables, setTables] = useState('County human services desk\nFEMA\nSBA\nInsurance');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setActions(me.actions))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, []);
  const can = (a: string) => actions?.includes(a) ?? false;

  useEffect(() => {
    if (!actions?.includes('marc.queue')) return;
    let live = true;
    api<Site[]>('/marc/sites')
      .then((d) => {
        if (!live) return;
        setSites(d);
        setError(null);
        if (!siteId && d[0]) setSiteId(d[0].id);
      })
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
    // The first site is chosen once; later choices are the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, tick]);

  useEffect(() => {
    if (!siteId || !actions?.includes('marc.queue')) return;
    let live = true;
    const q = new URLSearchParams();
    if (table.trim()) q.set('table', table.trim());
    if (includeEnded) q.set('includeEnded', 'true');
    api<{ items: Visit[] }>(`/marc/sites/${siteId}/queue${q.size ? `?${q}` : ''}`)
      .then((d) => live && setQueue(d.items))
      .catch((e: unknown) => live && setMsg({ kind: 'error', text: describeFailure(e) }));
    return () => {
      live = false;
    };
  }, [siteId, table, includeEnded, actions, tick]);

  const run = async (work: () => Promise<string>) => {
    try {
      setMsg({ kind: 'success', text: await work() });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
    reload();
  };

  const checkIn = (e: FormEvent) => {
    e.preventDefault();
    const list = tables
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => ({ label: t }));
    if (!list.length) {
      setMsg({ kind: 'error', text: 'List at least one table to see.' });
      return;
    }
    void run(async () => {
      await api(`/marc/sites/${siteId}/visits`, { body: { label: label.trim(), tables: list } });
      setLabel('');
      return `${label.trim()} is checked in; the first table is ${list[0]!.label}.`;
    });
  };

  const handoff = (v: Visit) =>
    void run(async () => {
      const note = (notes[v.id] ?? '').trim();
      if (note.length < 3)
        throw new Error('Write one line on why the survivor is coming to the next table.');
      const next = await api<Visit>(`/marc/visits/${v.id}/handoff`, {
        method: 'POST',
        body: { note },
        version: v.version,
      });
      setNotes({ ...notes, [v.id]: '' });
      return next.currentTable
        ? `${v.label} is handed to ${next.currentTable}.`
        : `${v.label} has seen every table; the visit is done.`;
    });

  const leave = (v: Visit) =>
    void run(async () => {
      await api(`/marc/visits/${v.id}/leave`, { method: 'POST', version: v.version });
      return `${v.label} left before the tables were done; the visit is closed.`;
    });

  const site = sites?.find((s) => s.id === siteId) ?? null;

  return (
    <section aria-labelledby="marc-h">
      <h1 id="marc-h">Recovery centre</h1>
      <p>
        A multi-agency resource centre&rsquo;s floor. The door checks a survivor in by a first name
        or the reference code with the tables to see, in order. Each table sees who is waiting for
        it and how long; handing a survivor to the next table carries one line on why, so they do
        not retell their story. A partner&rsquo;s table sees only its own visits and notes. Nothing
        here names a home or a dollar.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {actions && !can('marc.queue') ? <p>You do not have access to the recovery centre.</p> : null}
      {can('marc.queue') && sites === null && !error ? <p role="status">Loading sites…</p> : null}
      {sites && sites.length === 0 ? (
        <p className="empty">
          No recovery centre is open. Open a site of kind &ldquo;MARC&rdquo; under Sites.
        </p>
      ) : null}

      {sites && sites.length > 0 ? (
        <div className="toolbar">
          <Field label="Recovery centre">
            {({ id }) => (
              <select id={id} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.inProgress} on the floor)
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Table"
            hint="Leave empty for the whole floor; a partner sees its own table only."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={table}
                onChange={(e) => setTable(e.target.value)}
              />
            )}
          </Field>
          <label>
            <input
              type="checkbox"
              checked={includeEnded}
              onChange={(e) => setIncludeEnded(e.target.checked)}
            />{' '}
            Show visits that ended
          </label>
        </div>
      ) : null}

      {site && can('marc.check_in') ? (
        <form onSubmit={checkIn} className="panel" aria-labelledby="marc-checkin-h">
          <h2 id="marc-checkin-h">Check a survivor in at {site.name}</h2>
          <Field
            label="Name at the door"
            hint="A first name or the reference code; nothing more is written here."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
                maxLength={80}
              />
            )}
          </Field>
          <Field label="Tables to see, in order" hint="One per line.">
            {({ id, describedBy }) => (
              <textarea
                id={id}
                aria-describedby={describedBy}
                rows={4}
                value={tables}
                onChange={(e) => setTables(e.target.value)}
                required
              />
            )}
          </Field>
          <button type="submit">Check in</button>
        </form>
      ) : null}

      {site ? (
        <DataTable
          caption={`Queue at ${site.name}`}
          empty="Nobody is waiting."
          rows={queue ?? []}
          rowKey={(v) => v.id}
          columns={[
            { key: 'label', header: 'Survivor', render: (v) => v.label },
            {
              key: 'arrived',
              header: 'Arrived',
              render: (v) => `${fmt(v.arrivedAt)} (${v.waitingMinutes} min ago)`,
            },
            { key: 'status', header: 'Status', render: (v) => VISIT[v.status] },
            { key: 'now', header: 'At table', render: (v) => v.currentTable ?? '—' },
            {
              key: 'stops',
              header: 'Tables',
              render: (v) => (
                <ol className="plain">
                  {v.stops.map((s) => (
                    <li key={s.id}>
                      {s.tableLabel}: {STOP[s.status]}
                      {s.yours ? ' (yours)' : ''}
                      {s.handoffNote
                        ? ` — ${s.handoffNote}${s.handedBy ? ` (${s.handedBy})` : ''}`
                        : ''}
                    </li>
                  ))}
                </ol>
              ),
            },
            {
              key: 'act',
              header: 'Actions',
              render: (v) =>
                v.status === 'in_progress' || v.status === 'waiting' ? (
                  <div className="toolbar">
                    <Field label={`Why ${v.label} goes to the next table`}>
                      {({ id }) => (
                        <input
                          id={id}
                          value={notes[v.id] ?? ''}
                          onChange={(e) => setNotes({ ...notes, [v.id]: e.target.value })}
                          maxLength={200}
                        />
                      )}
                    </Field>
                    <button type="button" onClick={() => handoff(v)}>
                      Hand {v.label} to the next table
                    </button>
                    {can('marc.check_in') ? (
                      <button type="button" onClick={() => leave(v)}>
                        {v.label} left
                      </button>
                    ) : null}
                  </div>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      ) : null}
    </section>
  );
}

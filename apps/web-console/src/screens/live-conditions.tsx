/**
 * Live conditions (CON-14; WCAG 2.2 AA): road closures and work zones,
 * hazards, traffic and utility outages from the county's feeds and from
 * staff, each with its source and age; stale feeds say so. Staff enter a
 * condition that overrides the feeds for its area and clear it when it
 * lapses. Those who manage the feeds add them, switch them on or off, pull
 * them now, or import a feed file when the county has no feed.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

type Kind = 'road_closure' | 'work_zone' | 'hazard' | 'traffic' | 'outage';
type Severity = 'info' | 'minor' | 'major';
interface Condition {
  id: string;
  version: number;
  kind: Kind;
  summary: string;
  road: string | null;
  severity: Severity;
  position: { lat: number; lon: number } | null;
  startsAt: string | null;
  endsAt: string | null;
  asOf: string;
  ageSeconds: number;
  stale: boolean;
  active: boolean;
  override: boolean;
  source: { id: string | null; name: string; kind: string };
  enteredBy: string | null;
  clearedAt: string | null;
}
interface Source {
  id: string;
  version: number;
  kind: 'wzdx' | 'waze' | 'utility' | 'file';
  name: string;
  url: string | null;
  enabled: boolean;
  refreshMs: number;
  lastPulledAt: string | null;
  lastStatus: 'never' | 'ok' | 'failed';
  lastError: string | null;
  lastCount: number | null;
  activeItems: number;
}

const KIND: Record<Kind, string> = {
  road_closure: 'Road closure',
  work_zone: 'Work zone',
  hazard: 'Hazard',
  traffic: 'Traffic',
  outage: 'Outage',
};
const SEVERITY: Record<Severity, string> = { info: 'Info', minor: 'Minor', major: 'Major' };
const SOURCE_KIND: Record<Source['kind'], string> = {
  wzdx: 'State DOT work zones (WZDx)',
  waze: 'Waze for Cities partner feed',
  utility: 'Utility outages',
  file: 'File import',
};
const age = (s: number) =>
  s < 60
    ? 'just now'
    : s < 3600
      ? `${Math.round(s / 60)} min ago`
      : s < 86_400
        ? `${Math.round(s / 3600)} h ago`
        : `${Math.round(s / 86_400)} d ago`;

export function LiveConditionsScreen() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [list, setList] = useState<Condition[] | null>(null);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [showCleared, setShowCleared] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);
  const [entry, setEntry] = useState({
    kind: 'road_closure' as Kind,
    summary: '',
    road: '',
    severity: 'major' as Severity,
    lat: '',
    lon: '',
    endsAt: '',
  });
  const [feed, setFeed] = useState({
    kind: 'wzdx' as Source['kind'],
    name: '',
    url: '',
    enabled: true,
  });
  const [importing, setImporting] = useState<Source | null>(null);
  const [importText, setImportText] = useState('');
  const [importFormat, setImportFormat] = useState<'wzdx' | 'waze' | 'utility'>('wzdx');

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
    if (!actions?.includes('live_condition.read')) return;
    let live = true;
    api<Condition[]>(`/live-conditions${showCleared ? '?includeCleared=true' : ''}`)
      .then((d) => live && (setList(d), setError(null)))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    api<Source[]>('/live-sources')
      .then((d) => live && setSources(d))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [actions, tick, showCleared]);

  const enter = async (e: FormEvent) => {
    e.preventDefault();
    const lat = Number(entry.lat);
    const lon = Number(entry.lon);
    try {
      await api('/live-conditions', {
        body: {
          kind: entry.kind,
          summary: entry.summary.trim(),
          ...(entry.road.trim() ? { road: entry.road.trim() } : {}),
          severity: entry.severity,
          ...(entry.lat.trim() && entry.lon.trim() && Number.isFinite(lat) && Number.isFinite(lon)
            ? { position: { lat, lon } }
            : {}),
          ...(entry.endsAt ? { endsAt: new Date(entry.endsAt).toISOString() } : {}),
        },
      });
      setMsg({
        kind: 'success',
        text: 'Entered. It overrides the feeds for its area until it lapses or is cleared.',
      });
      setEntry({ ...entry, summary: '', road: '', lat: '', lon: '', endsAt: '' });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const clear = async (c: Condition) => {
    try {
      await api(`/live-conditions/${c.id}/clear`, { method: 'POST', version: c.version });
      setMsg({ kind: 'success', text: 'Cleared.' });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
    reload();
  };
  const addFeed = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/live-sources', {
        body: {
          kind: feed.kind,
          name: feed.name.trim(),
          ...(feed.kind !== 'file' ? { url: feed.url.trim() } : {}),
          enabled: feed.kind !== 'file' && feed.enabled,
        },
      });
      setMsg({
        kind: 'success',
        text:
          feed.kind === 'file'
            ? 'File source added. Import a feed file to fill it.'
            : 'Feed added. The first pull is queued; its result shows on the feed.',
      });
      setFeed({ kind: 'wzdx', name: '', url: '', enabled: true });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const toggle = async (s: Source) => {
    try {
      await api(`/live-sources/${s.id}`, {
        method: 'PATCH',
        body: { enabled: !s.enabled },
        version: s.version,
      });
      setMsg({
        kind: 'success',
        text: s.enabled ? `${s.name} is off; its items left the board.` : `${s.name} is on.`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
    reload();
  };
  const pull = async (s: Source) => {
    try {
      await api(`/live-sources/${s.id}/pull`, { method: 'POST' });
      setMsg({
        kind: 'success',
        text: `Pull of ${s.name} queued; the result shows on the feed in a moment.`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const doImport = async (e: FormEvent) => {
    e.preventDefault();
    if (!importing) return;
    let document: unknown;
    try {
      document = JSON.parse(importText) as unknown;
    } catch {
      setMsg({ kind: 'error', text: 'The file is not valid JSON.' });
      return;
    }
    try {
      const r = await api<{ upserted: number; cleared: number; skipped: number }>(
        `/live-sources/${importing.id}/import`,
        { body: { ...(importing.kind === 'file' ? { format: importFormat } : {}), document } },
      );
      setMsg({
        kind: 'success',
        text: `Imported into ${importing.name}: ${r.upserted} items, ${r.cleared} cleared, ${r.skipped} left out.`,
      });
      setImporting(null);
      setImportText('');
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };

  return (
    <section aria-labelledby="live-h">
      <h1 id="live-h">Live conditions</h1>
      <p>
        Road closures and work zones, hazards, traffic and utility outages from the county&rsquo;s
        feeds and from staff, each with its source and when it last said so. A feed that has not
        spoken for two of its periods is marked stale. A condition entered by staff overrides the
        feeds for its area until it lapses or is cleared. Every item is a place on the road network
        or a utility area, never a home.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {actions && !can('live_condition.read') ? (
        <p>You do not have access to live conditions.</p>
      ) : null}
      {can('live_condition.read') && list === null && !error ? (
        <p role="status">Loading live conditions…</p>
      ) : null}

      {list ? (
        <>
          <div className="toolbar">
            <label>
              <input
                type="checkbox"
                checked={showCleared}
                onChange={(e) => setShowCleared(e.target.checked)}
              />{' '}
              Show cleared items
            </label>
          </div>
          <DataTable
            caption="Conditions, most severe first"
            rows={list}
            rowKey={(c) => c.id}
            empty="No live conditions in force."
            columns={[
              { key: 'k', header: 'Kind', render: (c) => KIND[c.kind] },
              { key: 's', header: 'Condition', render: (c) => c.summary },
              { key: 'sv', header: 'Severity', render: (c) => SEVERITY[c.severity] },
              {
                key: 'src',
                header: 'Source',
                render: (c) =>
                  c.override
                    ? `Staff entry${c.enteredBy ? ` (${c.enteredBy})` : ''}`
                    : c.source.name,
              },
              {
                key: 'a',
                header: 'As of',
                render: (c) => `${fmt(c.asOf)} (${age(c.ageSeconds)})${c.stale ? '; stale' : ''}`,
              },
              {
                key: 'st',
                header: 'Status',
                render: (c) =>
                  c.clearedAt
                    ? `Cleared ${fmt(c.clearedAt)}`
                    : c.active
                      ? 'In force'
                      : `Lapsed ${fmt(c.endsAt)}`,
              },
              {
                key: 'x',
                header: 'Action',
                render: (c) =>
                  can('live_condition.write') && c.override && !c.clearedAt ? (
                    <button type="button" onClick={() => void clear(c)}>
                      Clear: {c.summary.slice(0, 40)}
                    </button>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        </>
      ) : null}

      {can('live_condition.write') ? (
        <form onSubmit={(e) => void enter(e)} className="panel" aria-labelledby="live-entry-h">
          <h2 id="live-entry-h">Enter a condition</h2>
          <div className="toolbar">
            <Field label="Kind">
              {({ id }) => (
                <select
                  id={id}
                  value={entry.kind}
                  onChange={(e) => setEntry({ ...entry, kind: e.target.value as Kind })}
                >
                  {(Object.keys(KIND) as Kind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND[k]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Severity">
              {({ id }) => (
                <select
                  id={id}
                  value={entry.severity}
                  onChange={(e) => setEntry({ ...entry, severity: e.target.value as Severity })}
                >
                  {(Object.keys(SEVERITY) as Severity[]).map((k) => (
                    <option key={k} value={k}>
                      {SEVERITY[k]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <Field label="What and where" hint="A road or a utility area, never a home.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={entry.summary}
                onChange={(e) => setEntry({ ...entry, summary: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Road">
            {({ id }) => (
              <input
                id={id}
                value={entry.road}
                onChange={(e) => setEntry({ ...entry, road: e.target.value })}
              />
            )}
          </Field>
          <div className="toolbar">
            <Field label="Latitude">
              {({ id }) => (
                <input
                  id={id}
                  inputMode="decimal"
                  value={entry.lat}
                  onChange={(e) => setEntry({ ...entry, lat: e.target.value })}
                />
              )}
            </Field>
            <Field label="Longitude">
              {({ id }) => (
                <input
                  id={id}
                  inputMode="decimal"
                  value={entry.lon}
                  onChange={(e) => setEntry({ ...entry, lon: e.target.value })}
                />
              )}
            </Field>
            <Field label="Lapses at" hint="Leave empty to keep it until cleared.">
              {({ id, describedBy }) => (
                <input
                  id={id}
                  aria-describedby={describedBy}
                  type="datetime-local"
                  value={entry.endsAt}
                  onChange={(e) => setEntry({ ...entry, endsAt: e.target.value })}
                />
              )}
            </Field>
          </div>
          <p>
            <button type="submit" className="primary">
              Enter the condition
            </button>
          </p>
        </form>
      ) : null}

      {sources ? (
        <section className="panel" aria-labelledby="live-feeds-h">
          <h2 id="live-feeds-h">Feeds</h2>
          <DataTable
            caption="The county's feeds and how their last pull went"
            rows={sources}
            rowKey={(s) => s.id}
            empty="No feed set up. Conditions come from staff entries until one is."
            columns={[
              { key: 'n', header: 'Feed', render: (s) => s.name },
              { key: 'k', header: 'Kind', render: (s) => SOURCE_KIND[s.kind] },
              {
                key: 'on',
                header: 'On',
                render: (s) => (s.kind === 'file' ? 'By import' : s.enabled ? 'On' : 'Off'),
              },
              {
                key: 'l',
                header: 'Last pull',
                render: (s) =>
                  s.lastStatus === 'never'
                    ? 'Never'
                    : `${s.lastStatus === 'ok' ? 'OK' : 'Failed'}, ${fmt(s.lastPulledAt)}${
                        s.lastCount !== null ? `, ${s.lastCount} items` : ''
                      }${s.lastError ? `: ${s.lastError}` : ''}`,
              },
              { key: 'i', header: 'Items in force', render: (s) => String(s.activeItems) },
              {
                key: 'x',
                header: 'Action',
                render: (s) =>
                  can('live_source.manage') ? (
                    <>
                      {s.kind !== 'file' ? (
                        <>
                          <button type="button" onClick={() => void toggle(s)}>
                            {s.enabled ? 'Switch off' : 'Switch on'} {s.name}
                          </button>{' '}
                          <button type="button" onClick={() => void pull(s)}>
                            Pull {s.name} now
                          </button>{' '}
                        </>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setImporting(s);
                          setImportText('');
                        }}
                      >
                        Import a file into {s.name}
                      </button>
                    </>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          {importing ? (
            <form onSubmit={(e) => void doImport(e)} aria-labelledby="live-import-h">
              <h3 id="live-import-h">Import a feed file into {importing.name}</h3>
              {importing.kind === 'file' ? (
                <Field label="Format">
                  {({ id }) => (
                    <select
                      id={id}
                      value={importFormat}
                      onChange={(e) =>
                        setImportFormat(e.target.value as 'wzdx' | 'waze' | 'utility')
                      }
                    >
                      <option value="wzdx">WZDx (state DOT)</option>
                      <option value="waze">Waze partner feed</option>
                      <option value="utility">Utility outages (GeoJSON)</option>
                    </select>
                  )}
                </Field>
              ) : null}
              <Field
                label="File contents (JSON)"
                hint="Paste the feed document as the source publishes it."
              >
                {({ id, describedBy }) => (
                  <textarea
                    id={id}
                    aria-describedby={describedBy}
                    rows={8}
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    required
                  />
                )}
              </Field>
              <p>
                <button type="submit" className="primary">
                  Import
                </button>{' '}
                <button type="button" onClick={() => setImporting(null)}>
                  Cancel
                </button>
              </p>
            </form>
          ) : null}
          {can('live_source.manage') ? (
            <form onSubmit={(e) => void addFeed(e)} aria-labelledby="live-add-h">
              <h3 id="live-add-h">Add a feed</h3>
              <Field label="Kind">
                {({ id }) => (
                  <select
                    id={id}
                    value={feed.kind}
                    onChange={(e) => setFeed({ ...feed, kind: e.target.value as Source['kind'] })}
                  >
                    {(Object.keys(SOURCE_KIND) as Source['kind'][]).map((k) => (
                      <option key={k} value={k}>
                        {SOURCE_KIND[k]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Name">
                {({ id }) => (
                  <input
                    id={id}
                    value={feed.name}
                    onChange={(e) => setFeed({ ...feed, name: e.target.value })}
                    required
                  />
                )}
              </Field>
              {feed.kind !== 'file' ? (
                <Field
                  label="Address"
                  hint="https only. The worker reaches it only when the deployment's allowed hosts name it."
                >
                  {({ id, describedBy }) => (
                    <input
                      id={id}
                      aria-describedby={describedBy}
                      type="url"
                      value={feed.url}
                      onChange={(e) => setFeed({ ...feed, url: e.target.value })}
                      required
                    />
                  )}
                </Field>
              ) : null}
              <p>
                <button type="submit" className="primary">
                  Add the feed
                </button>
              </p>
            </form>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

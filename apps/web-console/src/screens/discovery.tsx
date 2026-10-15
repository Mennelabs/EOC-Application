/**
 * Resource discovery in the console (layer-7 task F4; REC-13, REC-14, REC-10,
 * WCAG 2.2 AA). People who review discovery see the places found (partner
 * posts, the county's own feeds, web search where it is on), places near
 * unmet need first, each with its source links, what the source states, what
 * is still unknown and the pre-check against the registry criteria. County EM
 * qualifies a place in (it enters the registry) or anyone reviewing sets it
 * aside, always with a reason; nothing enters, changes or leaves the registry
 * otherwise. "Find now" asks the worker for a run. Those who manage discovery
 * name the county's sources and switch them on or off.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Status, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';
import { Select, Text } from './facilities.tsx';

interface Candidate {
  id: string;
  version: number;
  createdAt: string;
  state: 'pending' | 'accepted' | 'rejected';
  change: 'new' | 'update' | 'closed';
  sourceKind: string;
  sourceName: string | null;
  facilityId: string | null;
  facilityName: string | null;
  name: string;
  kind: string;
  address: {
    line1: string | null;
    city: string | null;
    state: string | null;
    postal: string | null;
  } | null;
  position: { lat: number; lon: number } | null;
  attributes: Record<string, unknown>;
  unknown: string[];
  sourceLinks: string[];
  precheck: Record<
    string,
    { fit: 'fits' | 'needs_information' | 'does_not_fit'; reasons: string[] }
  >;
  note: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  nearUnmetNeed: boolean;
  decidedAt: string | null;
  decisionReason: string | null;
}
interface Source {
  id: string;
  version: number;
  kind: 'hsds' | 'csv' | 'geojson' | 'web_search';
  name: string;
  url: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastOutcome: string | null;
}
interface Run {
  id: string;
  createdAt: string;
  state: string;
  finishedAt: string | null;
  summary: {
    added?: number;
    refreshed?: number;
    alreadyRegistered?: number;
    rememberedRejected?: number;
    error?: string;
  };
}

const KINDS: [string, string][] = [
  ['school', 'School'],
  ['place_of_worship', 'Place of worship'],
  ['community_center', 'Community center'],
  ['parking_lot', 'Parking lot'],
  ['government', 'Government building'],
  ['commercial', 'Business'],
  ['other', 'Other'],
];
const kindName = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? k;
const SOURCE_KINDS: [Source['kind'], string][] = [
  ['hsds', 'Service directory (HSDS, 211)'],
  ['csv', 'Open-data CSV'],
  ['geojson', 'Open-data GeoJSON'],
  ['web_search', 'Web search (AI)'],
];
const CHANGE: Record<Candidate['change'], string> = {
  new: 'New place',
  update: 'Change to a registered place',
  closed: 'Registered place reported closed',
};
const FIT: Record<string, string> = {
  fits: 'Fits',
  needs_information: 'Needs information first',
  does_not_fit: 'Does not fit',
};
const USES: [string, string][] = [
  ['shelter', 'Shelter'],
  ['feeding', 'Feeding stop'],
  ['pod', 'Point of distribution'],
  ['marc', 'Resource center (MARC)'],
];
const words = (k: string) => k.replace(/([A-Z])/g, ' $1').toLowerCase();
const factText = (v: unknown) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

function Detail({
  c,
  canApprove,
  onDone,
}: {
  c: Candidate;
  canApprove: boolean;
  onDone: (msg: string) => void;
}) {
  const [decision, setDecision] = useState(canApprove ? 'accept' : 'reject');
  const [reason, setReason] = useState('');
  const [name, setName] = useState(c.name);
  const [kind, setKind] = useState(c.kind);
  const [error, setError] = useState<string | null>(null);
  const facts = Object.entries(c.attributes);
  const decide = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body: Record<string, unknown> = { decision, reason };
    if (decision === 'accept' && c.change === 'new') {
      if (name.trim() !== c.name) body['name'] = name.trim();
      if (kind !== c.kind) body['kind'] = kind;
    }
    try {
      await api(`/discovery/candidates/${c.id}/decision`, { body, version: c.version });
      onDone(`${c.name}: ${decision === 'accept' ? 'qualified in' : 'set aside'}.`);
    } catch (err) {
      setError(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby={`disc-${c.id}`} className="card">
      <h2 id={`disc-${c.id}`}>{c.name}</h2>
      <p>
        <strong>{CHANGE[c.change]}</strong>
        {c.facilityName && c.change !== 'new' ? ` (${c.facilityName})` : ''}: {kindName(c.kind)},
        from {c.sourceName ?? c.sourceKind}. Found {fmt(c.firstSeenAt)}
        {c.seenCount > 1 ? `, seen ${c.seenCount} times, last ${fmt(c.lastSeenAt)}` : ''}.
      </p>
      {c.nearUnmetNeed ? (
        <p>
          <strong>Near unmet need:</strong> within 3 km of open requests for food or a place to stay
          in the active event.
        </p>
      ) : null}
      {c.note ? <p>{c.note}</p> : null}
      <h3>Where</h3>
      <p>
        {c.address
          ? [c.address.line1, c.address.city, c.address.state, c.address.postal]
              .filter(Boolean)
              .join(', ') || 'Address unknown'
          : 'Address unknown'}
        {c.position ? ` (${c.position.lat.toFixed(4)}, ${c.position.lon.toFixed(4)})` : ''}
      </p>
      <h3>What the source states</h3>
      {facts.length ? (
        <ul className="plain">
          {facts.map(([k, v]) => (
            <li key={k}>
              {words(k)}: {factText(v)}
            </li>
          ))}
        </ul>
      ) : (
        <p>Nothing beyond the name and place.</p>
      )}
      <p>Unknown: {c.unknown.length ? c.unknown.join(', ') : 'nothing'}.</p>
      <h3>Where it was found</h3>
      {c.sourceLinks.length ? (
        <ul className="plain">
          {c.sourceLinks.map((l) => (
            <li key={l}>
              <a href={l} target="_blank" rel="noopener noreferrer">
                {l}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          {c.sourceKind === 'partner_post' ? 'A partner organization posted it here.' : 'No link.'}
        </p>
      )}
      <DataTable
        caption="Pre-check against the registry criteria"
        rows={USES.filter(([u]) => c.precheck[u])}
        rowKey={([u]) => u}
        columns={[
          { key: 'use', header: 'Use', render: ([, l]) => l },
          { key: 'fit', header: 'Result', render: ([u]) => FIT[c.precheck[u]!.fit] ?? '' },
          {
            key: 'why',
            header: 'Why',
            render: ([u]) => c.precheck[u]!.reasons.join('; ') || '—',
          },
        ]}
      />
      {c.state === 'pending' ? (
        <form onSubmit={(e) => void decide(e)} aria-labelledby={`disc-${c.id}-decide`}>
          <h3 id={`disc-${c.id}-decide`}>Decide</h3>
          {error ? <Status kind="error">{error}</Status> : null}
          <Select
            label="Decision"
            value={decision}
            onChange={setDecision}
            options={[
              ...(canApprove
                ? [
                    [
                      'accept',
                      c.change === 'new'
                        ? 'Qualify in: add it to the registry'
                        : c.change === 'closed'
                          ? 'Agree: retire the registered place'
                          : 'Agree: apply the change',
                    ] as [string, string],
                  ]
                : []),
              ['reject', 'Set aside'],
            ]}
          />
          {decision === 'accept' && c.change === 'new' ? (
            <>
              <Text label="Name in the registry" value={name} onChange={setName} />
              <Select label="Kind of place" value={kind} onChange={setKind} options={KINDS} />
            </>
          ) : null}
          <Text
            label="Reason for the decision"
            hint="Recorded with your name."
            value={reason}
            onChange={setReason}
          />
          <div className="actions">
            <button type="submit" className="primary" disabled={reason.trim().length < 3}>
              Record the decision
            </button>
          </div>
        </form>
      ) : (
        <p>
          {c.state === 'accepted' ? 'Qualified in' : 'Set aside'} {fmt(c.decidedAt)}:{' '}
          {c.decisionReason}
        </p>
      )}
    </section>
  );
}

function Sources() {
  const { rows, error, reload } = useList<Source>('/discovery/sources');
  const [form, setForm] = useState({ kind: 'hsds', name: '', url: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setFailure(null);
    try {
      await api('/discovery/sources', {
        body: {
          kind: form.kind,
          name: form.name.trim(),
          ...(form.kind === 'web_search' ? {} : { url: form.url.trim() }),
        },
      });
      setMsg(`${form.name.trim()}: added.`);
      setForm({ kind: 'hsds', name: '', url: '' });
      reload();
    } catch (err) {
      setFailure(describeFailure(err));
    }
  };
  const toggle = async (s: Source) => {
    setMsg(null);
    setFailure(null);
    try {
      await api(`/discovery/sources/${s.id}`, {
        method: 'PATCH',
        body: { enabled: !s.enabled },
        version: s.version,
      });
      setMsg(`${s.name}: ${s.enabled ? 'switched off' : 'switched on'}.`);
      reload();
    } catch (err) {
      setFailure(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="disc-sources">
      <h2 id="disc-sources">The county’s sources</h2>
      <p>
        Partner posts are always read. Add the county’s own service directory or open-data feeds
        (public https addresses only). Web search runs only when it is listed here and switched on
        in the AI use register.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {failure ? <Status kind="error">{failure}</Status> : null}
      {msg ? <Status kind="success">{msg}</Status> : null}
      <DataTable
        caption="Sources"
        rows={rows ?? []}
        rowKey={(s) => s.id}
        empty={rows ? 'Only partner posts so far.' : 'Loading…'}
        columns={[
          { key: 'name', header: 'Source', render: (s) => s.name },
          {
            key: 'kind',
            header: 'Kind',
            render: (s) => SOURCE_KINDS.find(([k]) => k === s.kind)?.[1] ?? s.kind,
          },
          { key: 'url', header: 'Address', render: (s) => s.url ?? '—' },
          {
            key: 'last',
            header: 'Last read',
            render: (s) => (s.lastRunAt ? fmt(s.lastRunAt) : 'Not yet'),
          },
          { key: 'outcome', header: 'How it went', render: (s) => s.lastOutcome ?? '—' },
          {
            key: 'on',
            header: 'On',
            render: (s) => (
              <button type="button" onClick={() => void toggle(s)}>
                {s.enabled ? `Switch off ${s.name}` : `Switch on ${s.name}`}
              </button>
            ),
          },
        ]}
      />
      <form onSubmit={(e) => void add(e)} aria-labelledby="disc-add">
        <h3 id="disc-add">Add a source</h3>
        <Select
          label="Kind of source"
          value={form.kind}
          onChange={(v) => setForm({ ...form, kind: v })}
          options={SOURCE_KINDS}
        />
        <Text
          label="Source name"
          value={form.name}
          onChange={(v) => setForm({ ...form, name: v })}
        />
        {form.kind !== 'web_search' ? (
          <Text
            label="Feed address"
            hint="A public https address, for example the portal's download link."
            value={form.url}
            onChange={(v) => setForm({ ...form, url: v })}
          />
        ) : null}
        <div className="actions">
          <button
            type="submit"
            className="primary"
            disabled={
              form.name.trim().length < 2 || (form.kind !== 'web_search' && !form.url.trim())
            }
          >
            Add the source
          </button>
        </div>
      </form>
    </section>
  );
}

export function DiscoveryScreen() {
  const [actions, setActions] = useState<string[]>([]);
  const [state, setState] = useState('pending');
  const [tick, setTick] = useState(0);
  const { rows, error } = useList<Candidate>(`/discovery/candidates?state=${state}&limit=100`, [
    tick,
  ]);
  const { rows: runs } = useList<Run>('/discovery/runs?limit=5', [tick]);
  const [open, setOpen] = useState<Candidate | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setActions(me.actions))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const can = (a: string) => actions.includes(a);
  const refresh = () => setTick((t) => t + 1);
  const findNow = async () => {
    setMsg(null);
    setFailure(null);
    try {
      await api('/discovery/runs', { body: {} });
      setMsg('Asked: the next run starts within a minute. Refresh to see what it found.');
      refresh();
    } catch (err) {
      setFailure(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="disc-h">
      <h1 id="disc-h">Resource discovery</h1>
      <p>
        Places that could serve residents, found in partner posts, the county’s own sources and,
        where it is on, web search. Nothing enters, changes or leaves the facility registry until
        someone decides, with a reason. A place set aside is not proposed again unless something
        about it changes.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {failure ? <Status kind="error">{failure}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      <div className="actions">
        <button type="button" onClick={() => void findNow()}>
          Find now
        </button>
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </div>
      <Select
        label="Show"
        value={state}
        onChange={(v) => {
          setState(v);
          setOpen(null);
        }}
        options={[
          ['pending', 'Waiting for a decision'],
          ['accepted', 'Qualified in'],
          ['rejected', 'Set aside'],
        ]}
      />
      <DataTable
        caption="Places found"
        rows={rows ?? []}
        rowKey={(c) => c.id}
        empty={rows ? 'Nothing here.' : 'Loading…'}
        columns={[
          {
            key: 'name',
            header: 'Place',
            render: (c) => (
              <button type="button" className="link" onClick={() => setOpen(c)}>
                {c.name}
              </button>
            ),
          },
          { key: 'what', header: 'What', render: (c) => CHANGE[c.change] },
          { key: 'kind', header: 'Kind', render: (c) => kindName(c.kind) },
          { key: 'from', header: 'From', render: (c) => c.sourceName ?? c.sourceKind },
          {
            key: 'need',
            header: 'Near unmet need',
            render: (c) => (c.nearUnmetNeed ? 'Yes' : 'No'),
          },
          { key: 'found', header: 'Found', render: (c) => fmt(c.firstSeenAt) },
        ]}
      />
      {open ? (
        <Detail
          key={open.id}
          c={open}
          canApprove={can('facility.approve')}
          onDone={(t) => {
            setMsg(t);
            setOpen(null);
            refresh();
          }}
        />
      ) : null}
      <h2 id="disc-runs">Recent runs</h2>
      <DataTable
        caption="Recent runs"
        rows={runs ?? []}
        rowKey={(r) => r.id}
        empty="No run yet."
        columns={[
          { key: 'when', header: 'Asked', render: (r) => fmt(r.createdAt) },
          { key: 'state', header: 'State', render: (r) => r.state },
          {
            key: 'what',
            header: 'Found',
            render: (r) =>
              r.summary.error ??
              (r.state === 'done'
                ? `${r.summary.added ?? 0} new, ${r.summary.refreshed ?? 0} seen again, ${r.summary.alreadyRegistered ?? 0} already registered, ${r.summary.rememberedRejected ?? 0} set aside before`
                : '—'),
          },
        ]}
      />
      {can('discovery.manage') ? <Sources /> : null}
    </section>
  );
}

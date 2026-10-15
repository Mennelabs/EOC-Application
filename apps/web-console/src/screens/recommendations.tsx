/**
 * Recommendations in the console (layer-7 task E3; REC-02–REC-12, CON-09,
 * WCAG 2.2 AA). A planner asks for a shelter, feeding stops for the canteens
 * on the roster, a point of distribution with walk-up points, or a
 * Multi-Agency Resource Center for the open event. The answer comes from
 * rules and the registry, never from a language model, and is shown in full:
 * the places recommended with every reason and every unknown, the places set
 * aside and why, what would change the answer, the age of each input with a
 * stale warning, and who is in reach by income, renting and language with
 * any high-need area left out. A named person accepts it, edits it (another
 * place; for feeding, a stop swapped) or rejects it, always with a reason.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Status, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';
import { Select, Text } from './facilities.tsx';

type Kind = 'shelter' | 'feeding' | 'pod' | 'marc';
interface Option {
  facilityId: string;
  name: string;
  score: number;
  capacity?: number;
  reasons: string[];
  unknown: string[];
}
interface Excluded {
  facilityId: string;
  name: string;
  reasons: string[];
}
interface InputAge {
  input: string;
  asOf: string | null;
  ageHours: number | null;
  stale: boolean;
  note?: string;
}
interface EquityGroup {
  group: string;
  households: number | null;
  coveredHouseholds: number | null;
  coveredPct: number | null;
}
interface Equity {
  coverageKm: number;
  byIncomeBand: EquityGroup[];
  byRenterShare: EquityGroup[];
  byLanguage: EquityGroup[];
  uncovered: { geoid: string; name: string | null; why: string[]; nearestKm: number | null }[];
  note: string | null;
}
interface Stop {
  stop: number;
  canteen: { name: string; agency: string | null } | null;
  window: { start: string; end: string };
  facilityId: string | null;
  place: string;
  households: number;
  meals: number;
  notes: string[];
  reasons: string[];
  unknown: string[];
}
interface WalkUp {
  geoid: string;
  tract: string | null;
  noVehiclePct: number;
  place: string;
  reasons: string[];
  notes: string[];
}
interface Result {
  kind: Kind;
  engineVersion: string;
  demand: Record<string, number | string | null>;
  top?: Option[];
  stops?: Stop[];
  canteens?: { teamId: string; name: string; agency: string | null; mealsPerHour: number | null }[];
  unserved?: number;
  pod?: { type: string; count: number; peoplePerDay: number } | null;
  supplies?: {
    days: number;
    waterGallons: number;
    iceLbMin: number;
    iceLbMax: number;
    meals: number;
  } | null;
  walkUps?: WalkUp[];
  services?: { service: string; households: number; tables: number; basis: string }[];
  tables?: number;
  sqftNeeded?: number;
  interpreters?: { language: string; name: string; reports: number }[];
  checks?: string[];
  excluded: Excluded[];
  whatWouldChange: string[];
  inputs: InputAge[];
  equity: Equity;
}
interface Recommendation {
  id: string;
  version: number;
  createdAt: string;
  eventId: string;
  kind: Kind;
  engineVersion: string;
  result: Result;
  state: 'open' | 'accepted' | 'edited' | 'rejected';
  decidedAt: string | null;
  decisionReason: string | null;
  chosenFacilityId: string | null;
  decisionNote: string | null;
  decisionChanges: Record<string, unknown>[] | null;
}
interface Facility {
  id: string;
  name: string;
}

const KINDS: [Kind, string][] = [
  ['shelter', 'Shelter for tonight'],
  ['feeding', 'Feeding stops for the canteens'],
  ['pod', 'Point of distribution and walk-up points'],
  ['marc', 'Multi-Agency Resource Center'],
];
const kindName = (k: Kind) => KINDS.find(([v]) => v === k)?.[1] ?? k;
const STATE: Record<Recommendation['state'], string> = {
  open: 'Waiting for a decision',
  accepted: 'Accepted',
  edited: 'Edited',
  rejected: 'Rejected',
};
const n = (v: number | null | undefined) =>
  v === null || v === undefined ? 'unknown' : v.toLocaleString('en-US');

function Lines({ items }: { items: string[] }) {
  if (!items.length) return <>—</>;
  return (
    <ul className="plain">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

/** A part of the answer under its own heading; tables inside carry their own region names. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div className="rec-part">
      <h3 id={id}>{title}</h3>
      {children}
    </div>
  );
}

function OptionsTable({ caption, rows }: { caption: string; rows: Option[] }) {
  return (
    <DataTable
      caption={caption}
      rows={rows}
      rowKey={(o) => o.facilityId}
      empty="No registered place passes the rules: see the places set aside."
      columns={[
        { key: 'rank', header: 'Rank', render: (o) => rows.indexOf(o) + 1 },
        { key: 'name', header: 'Place', render: (o) => o.name },
        { key: 'score', header: 'Score (out of 1)', render: (o) => o.score },
        { key: 'why', header: 'Why', render: (o) => <Lines items={o.reasons} /> },
        {
          key: 'unknown',
          header: 'Unknown',
          render: (o) => (o.unknown.length ? o.unknown.join(', ') : 'Nothing'),
        },
      ]}
    />
  );
}

function Common({ r, id }: { r: Result; id: string }) {
  const e = r.equity;
  const groups = [...e.byIncomeBand, ...e.byRenterShare, ...e.byLanguage];
  return (
    <>
      <Section id={`${id}-change`} title="What would change the answer">
        <Lines items={r.whatWouldChange} />
      </Section>
      <Section id={`${id}-aside`} title="Places set aside">
        <DataTable
          caption="Places set aside, with why"
          rows={r.excluded}
          rowKey={(x) => x.facilityId}
          empty="None: every registered place was weighed."
          columns={[
            { key: 'name', header: 'Place', render: (x) => x.name },
            { key: 'why', header: 'Why', render: (x) => <Lines items={x.reasons} /> },
          ]}
        />
      </Section>
      <Section id={`${id}-inputs`} title="Inputs and their age">
        <DataTable
          caption="Inputs and their age"
          rows={r.inputs}
          rowKey={(i) => i.input}
          columns={[
            { key: 'input', header: 'Input', render: (i) => i.input },
            { key: 'asOf', header: 'As of', render: (i) => (i.asOf ? fmt(i.asOf) : 'Not loaded') },
            {
              key: 'age',
              header: 'Age',
              render: (i) => (i.ageHours === null ? '—' : `${i.ageHours} hours`),
            },
            {
              key: 'stale',
              header: 'Fresh enough',
              render: (i) => (i.stale ? <strong>Stale: check it</strong> : 'Yes'),
            },
            { key: 'note', header: 'Note', render: (i) => i.note ?? '—' },
          ]}
        />
      </Section>
      <Section id={`${id}-equity`} title="Who is in reach (equity check)">
        {e.note ? <p>{e.note}</p> : null}
        {groups.length ? (
          <DataTable
            caption={`Households within ${e.coverageKm} km`}
            rows={groups}
            rowKey={(g) => g.group}
            columns={[
              { key: 'group', header: 'Group', render: (g) => g.group },
              { key: 'hh', header: 'Households', render: (g) => n(g.households) },
              { key: 'in', header: 'In reach', render: (g) => n(g.coveredHouseholds) },
              {
                key: 'pct',
                header: 'Share in reach',
                render: (g) => (g.coveredPct === null ? 'unknown' : `${g.coveredPct}%`),
              },
            ]}
          />
        ) : null}
        {e.uncovered.length ? (
          <>
            <p>
              <strong>High-need areas left out:</strong>
            </p>
            <ul>
              {e.uncovered.map((u) => (
                <li key={u.geoid}>
                  {u.name ?? `Tract ${u.geoid}`}: {u.why.join('; ')}
                  {u.nearestKm === null ? '' : `; nearest place ${u.nearestKm} km away`}
                </li>
              ))}
            </ul>
          </>
        ) : groups.length ? (
          <p>No high-need area is left out.</p>
        ) : null}
      </Section>
    </>
  );
}

function Body({ rec }: { rec: Recommendation }) {
  const r = rec.result;
  const id = `rec-${rec.id.slice(0, 8)}`;
  const d = r.demand;
  switch (r.kind) {
    case 'shelter':
      return (
        <>
          <p>
            {n(d['households'] as number)} households asked for a place to stay tonight (about{' '}
            {n(d['people'] as number)} people); {n(d['petHouseholds'] as number)} asked for help
            with pets.
          </p>
          <OptionsTable caption="Top three shelters" rows={r.top ?? []} />
          <Common r={r} id={id} />
        </>
      );
    case 'feeding':
      return (
        <>
          <p>
            {n(d['households'] as number)} households asked for food or water (about{' '}
            {n(d['meals'] as number)} meals); {n(d['petHouseholds'] as number)} asked for help with
            pets and {n(d['talkHouseholds'] as number)} for someone to talk to.{' '}
            {r.unserved ? `${n(r.unserved)} households are beyond these stops.` : ''}
          </p>
          <DataTable
            caption="Canteens on the roster"
            rows={r.canteens ?? []}
            rowKey={(c) => c.teamId}
            empty="No canteen is on the roster for this event."
            columns={[
              { key: 'name', header: 'Canteen', render: (c) => c.name },
              { key: 'agency', header: 'Agency', render: (c) => c.agency ?? '—' },
              { key: 'rate', header: 'Meals an hour', render: (c) => n(c.mealsPerHour) },
            ]}
          />
          <DataTable
            caption="Stops"
            rows={r.stops ?? []}
            rowKey={(s) => String(s.stop)}
            empty="No requests for food or water have a location yet."
            columns={[
              { key: 'stop', header: 'Stop', render: (s) => s.stop },
              {
                key: 'canteen',
                header: 'Canteen',
                render: (s) => s.canteen?.name ?? 'Not assigned',
              },
              { key: 'when', header: 'Window', render: (s) => `${s.window.start}–${s.window.end}` },
              { key: 'place', header: 'Place', render: (s) => s.place },
              { key: 'hh', header: 'Households', render: (s) => n(s.households) },
              { key: 'meals', header: 'Meals', render: (s) => n(s.meals) },
              {
                key: 'notes',
                header: 'Setup notes',
                render: (s) => <Lines items={[...s.notes, ...s.reasons]} />,
              },
              {
                key: 'unknown',
                header: 'Unknown',
                render: (s) => (s.unknown.length ? s.unknown.join(', ') : 'Nothing'),
              },
            ]}
          />
          <Common r={r} id={id} />
        </>
      );
    case 'pod':
      return (
        <>
          <p>
            {n(d['powerCustomersOut'] as number)} customers without power (about{' '}
            {n(d['people'] as number)} people; {n(d['peoplePerDay'] as number)} a day expected).
          </p>
          {r.pod ? (
            <p>
              <strong>
                {r.pod.count > 1 ? `${r.pod.count} × ` : 'One '}Type {r.pod.type} drive-through POD
              </strong>{' '}
              for {n(r.pod.peoplePerDay)} people a day.
            </p>
          ) : null}
          {r.supplies ? (
            <DataTable
              caption={`Supplies for the first ${r.supplies.days * 24} hours`}
              rows={
                [
                  ['Water', `${n(r.supplies.waterGallons)} gallons`],
                  ['Ice', `${n(r.supplies.iceLbMin)}–${n(r.supplies.iceLbMax)} lb`],
                  ['Meals', n(r.supplies.meals)],
                ] as [string, string][]
              }
              rowKey={(x) => x[0]}
              columns={[
                { key: 'what', header: 'Supply', render: (x) => x[0] },
                { key: 'qty', header: 'Amount', render: (x) => x[1] },
              ]}
            />
          ) : null}
          {r.pod ? <OptionsTable caption="POD sites" rows={r.top ?? []} /> : null}
          {r.walkUps?.length ? (
            <DataTable
              caption="Walk-up points"
              rows={r.walkUps}
              rowKey={(w) => w.geoid}
              columns={[
                { key: 'area', header: 'Area', render: (w) => w.tract ?? `Tract ${w.geoid}` },
                { key: 'nv', header: 'No vehicle', render: (w) => `${w.noVehiclePct}%` },
                { key: 'place', header: 'Place', render: (w) => w.place },
                {
                  key: 'why',
                  header: 'Why and what to bring',
                  render: (w) => <Lines items={[...w.reasons, ...w.notes]} />,
                },
              ]}
            />
          ) : null}
          {r.checks?.length ? (
            <Section id={`${id}-checks`} title="Check on site">
              <Lines items={r.checks} />
            </Section>
          ) : null}
          <Common r={r} id={id} />
        </>
      );
    case 'marc':
      return (
        <>
          <p>
            {n(d['majorDestroyed'] as number)} homes counted major or destroyed;{' '}
            {d['renterPct'] === null ? 'renting unknown' : `${d['renterPct']}% rented`};{' '}
            {d['uninsuredPct'] === null
              ? 'insurance unknown'
              : `${d['uninsuredPct']}% with no insurance for this damage`}
            .
          </p>
          <DataTable
            caption={`Partner mix: ${n(r.tables)} tables, about ${n(r.sqftNeeded)} sq ft`}
            rows={r.services ?? []}
            rowKey={(s) => s.service}
            empty="No recovery need is counted yet."
            columns={[
              { key: 'service', header: 'Service', render: (s) => s.service },
              { key: 'hh', header: 'Households', render: (s) => n(s.households) },
              { key: 'tables', header: 'Tables', render: (s) => s.tables },
              { key: 'basis', header: 'From', render: (s) => s.basis },
            ]}
          />
          <p>
            Interpreters:{' '}
            {r.interpreters?.length
              ? r.interpreters.map((i) => `${i.name} (${n(i.reports)} reports)`).join(', ')
              : 'no report came in a language other than English'}
            .
          </p>
          <OptionsTable caption="MARC sites" rows={r.top ?? []} />
          {r.checks?.length ? (
            <Section id={`${id}-checks`} title="Check before booking">
              <Lines items={r.checks} />
            </Section>
          ) : null}
          <Common r={r} id={id} />
        </>
      );
  }
}

function Decide({ rec, onDone }: { rec: Recommendation; onDone: (msg: string) => void }) {
  const feeding = rec.kind === 'feeding';
  const top = rec.result.top ?? [];
  const stops = rec.result.stops ?? [];
  const { rows: registry } = useList<Facility>('/facilities?limit=100');
  const [decision, setDecision] = useState('accept');
  const [pick, setPick] = useState(top[0]?.facilityId ?? '');
  const [other, setOther] = useState('');
  const [stop, setStop] = useState(String(stops[0]?.stop ?? 1));
  const [place, setPlace] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body: Record<string, unknown> = { decision, reason };
    if (note.trim()) body['note'] = note.trim();
    if (!feeding && decision === 'accept' && pick) body['facilityId'] = pick;
    if (!feeding && decision === 'edit') body['facilityId'] = other;
    if (feeding && decision === 'edit')
      body['swaps'] = [
        other
          ? { stop: Number(stop), facilityId: other }
          : { stop: Number(stop), place: place.trim() },
      ];
    try {
      await api(`/recommendations/${rec.id}/decision`, { body, version: rec.version });
      onDone(
        `${kindName(rec.kind)}: ${decision === 'accept' ? 'accepted' : decision === 'edit' ? 'edited' : 'rejected'}.`,
      );
    } catch (err) {
      setError(describeFailure(err));
    }
  };
  const registryOptions: [string, string][] = [
    ['', feeding ? 'Not in the registry (describe it below)' : 'Choose a place'],
    ...(registry ?? []).map((f): [string, string] => [f.id, f.name]),
  ];
  const ready =
    reason.trim().length >= 3 &&
    (decision !== 'edit' || (feeding ? !!other || place.trim().length >= 3 : !!other));
  return (
    <form onSubmit={(e) => void submit(e)} aria-labelledby={`${rec.id}-decide`}>
      <h3 id={`${rec.id}-decide`}>Decide</h3>
      {error ? <Status kind="error">{error}</Status> : null}
      <Select
        label="Decision"
        value={decision}
        onChange={setDecision}
        options={[
          ['accept', feeding ? 'Accept the stops' : 'Accept'],
          ['edit', feeding ? 'Swap a stop' : 'Choose another place'],
          ['reject', 'Reject'],
        ]}
      />
      {!feeding && decision === 'accept' && top.length ? (
        <Select
          label="Place accepted"
          value={pick}
          onChange={setPick}
          options={top.map((o): [string, string] => [o.facilityId, o.name])}
        />
      ) : null}
      {feeding && decision === 'edit' ? (
        <Select
          label="Stop to swap"
          value={stop}
          onChange={setStop}
          options={stops.map((s): [string, string] => [
            String(s.stop),
            `Stop ${s.stop}: ${s.place}`,
          ])}
        />
      ) : null}
      {decision === 'edit' ? (
        <Select
          label={feeding ? 'Registered place instead' : 'Place chosen instead'}
          value={other}
          onChange={setOther}
          options={registryOptions}
        />
      ) : null}
      {feeding && decision === 'edit' && !other ? (
        <Text
          label="Place instead, described"
          hint="For a place the team knows that is not in the registry."
          value={place}
          onChange={setPlace}
        />
      ) : null}
      <Text
        label="Reason for the decision"
        hint="Recorded with your name."
        value={reason}
        onChange={setReason}
      />
      <Text label="Note (optional)" value={note} onChange={setNote} />
      <div className="actions">
        <button type="submit" className="primary" disabled={!ready}>
          Record the decision
        </button>
      </div>
    </form>
  );
}

export function RecommendationsScreen() {
  const { events, error: eventsError } = useOpenEvents();
  const [picked, setPicked] = useState<string | null>(null);
  const eventId = picked ?? events?.[0]?.id ?? null;
  const [actions, setActions] = useState<string[]>([]);
  const [kind, setKind] = useState<string>('shelter');
  const [shown, setShown] = useState<Recommendation | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { rows, reload } = useList<Recommendation>(
    eventId ? `/recommendations?eventId=${eventId}&limit=20` : '/recommendations?limit=20',
  );
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

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (!eventId) return;
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const rec = await api<Recommendation>('/recommendations', {
        body: { kind, eventId },
      });
      setShown(rec);
      reload();
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  };
  const decided = async (text: string) => {
    setMsg(text);
    if (shown) setShown(await api<Recommendation>(`/recommendations/${shown.id}`));
    reload();
  };

  return (
    <section aria-labelledby="rec-h">
      <h1 id="rec-h">Recommendations</h1>
      <p>
        Worked out from rules, the facility registry and the event’s data, never from a language
        model: the same inputs give the same answer. Unknown is shown as unknown. A named person
        decides, with a reason.
      </p>
      {eventsError ? <Status kind="error">{eventsError}</Status> : null}
      {events && events.length === 0 ? <p>There is no open event.</p> : null}
      {events && events.length > 0 ? (
        <EventPicker events={events} value={eventId} onChange={setPicked} />
      ) : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind="success">{msg}</Status> : null}
      {can('recommendation.request') && eventId ? (
        <form onSubmit={(e) => void ask(e)} aria-labelledby="rec-ask">
          <h2 id="rec-ask">Ask for a recommendation</h2>
          <Select
            label="What to recommend"
            value={kind}
            onChange={setKind}
            options={KINDS.map(([v, l]): [string, string] => [v, l])}
          />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Working it out…' : 'Work it out'}
            </button>
          </div>
        </form>
      ) : null}
      {shown ? (
        <section aria-labelledby="rec-shown" className="card">
          <h2 id="rec-shown">
            {kindName(shown.kind)}, asked {fmt(shown.createdAt)}
          </h2>
          <p>
            <strong>{STATE[shown.state]}</strong>
            {shown.decisionReason ? `: ${shown.decisionReason}` : ''}
            {shown.decisionChanges?.length
              ? ` (${shown.decisionChanges
                  .map((c) =>
                    c['stop']
                      ? `stop ${String(c['stop'])} now ${String(c['to'])}`
                      : String(c['to']),
                  )
                  .join('; ')})`
              : ''}
            . Rules version {shown.engineVersion}.
          </p>
          <Body rec={shown} />
          {shown.state === 'open' && can('recommendation.decide') ? (
            <Decide key={shown.id} rec={shown} onDone={(t) => void decided(t)} />
          ) : null}
        </section>
      ) : null}
      <h2 id="rec-list">Recommendations for this event</h2>
      <DataTable
        caption="Recommendations for this event"
        rows={rows ?? []}
        rowKey={(r) => r.id}
        empty={rows ? 'None asked for yet.' : 'Loading…'}
        columns={[
          { key: 'kind', header: 'What', render: (r) => kindName(r.kind) },
          { key: 'when', header: 'Asked', render: (r) => fmt(r.createdAt) },
          { key: 'state', header: 'Decision', render: (r) => STATE[r.state] },
          { key: 'reason', header: 'Reason', render: (r) => r.decisionReason ?? '—' },
          {
            key: 'show',
            header: 'Open',
            render: (r) => (
              <button type="button" onClick={() => setShown(r)}>
                Show {kindName(r.kind).toLowerCase()} asked {fmt(r.createdAt)}
              </button>
            ),
          },
        ]}
      />
    </section>
  );
}

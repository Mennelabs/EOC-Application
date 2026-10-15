/**
 * Joint damage assessment (layer-6 task F; FL:FR-10, DCL:DEC-13, Form
 * 010-0-13 Box 10, ADM-05 G4, WCAG 2.2 AA). The county schedules the joint
 * federal, state and county assessment and draws its sample route from the
 * verified, counted homes; validators (FEMA on a time-limited role, and the
 * county's coordinator) mark each stop validated, seen at a different
 * degree, or not seen. Stops show what the street sheet shows of a home and
 * never a name, contact or address; the county member of each team finds
 * the door. The table is the route: no map is needed to use it.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { DEGREE_NAMES } from './declaration.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';

type Degree = 'affected' | 'minor' | 'major' | 'destroyed';
type Result = 'validated' | 'different' | 'not_seen';

interface Schedule {
  id: string | null;
  version: number | null;
  startsOn: string | null;
  endsOn: string | null;
  areas: string[];
  teams: { name: string; members: string }[];
  status: 'planned' | 'in_progress' | 'done';
  sampleVersion: number;
  sampleSize: number | null;
  sampleSeed: number | null;
  sampledAt: string | null;
}

interface Stop {
  id: string;
  seq: number;
  stratum: Degree;
  home: {
    ref: string | null;
    degree: string | null;
    type: string | null;
    units: number | null;
    usng: string | null;
    postal: string | null;
    tract: string | null;
    jurisdiction: string | null;
    counted: boolean;
  } | null;
  mark: {
    result: Result;
    degreeSeen: Degree | 'no_damage' | null;
    note: string | null;
    markedBy: string | null;
    markedAt: string;
  } | null;
}

interface Joint {
  eventId: string;
  schedule: Schedule;
  stops: Stop[];
  summary: {
    stops: number;
    validated: number;
    different: number;
    notSeen: number;
    pending: number;
  };
  candidates: number;
}

const STATUS = { planned: 'Planned', in_progress: 'In progress', done: 'Done' } as const;
const SEEN: Record<Degree | 'no_damage', string> = { ...DEGREE_NAMES, no_damage: 'No damage' };

const markText = (m: Stop['mark']) =>
  !m
    ? 'Not marked yet'
    : m.result === 'validated'
      ? `Validated by ${m.markedBy ?? 'someone'}`
      : m.result === 'different'
        ? `Seen as ${SEEN[m.degreeSeen ?? 'no_damage']} by ${m.markedBy ?? 'someone'}`
        : `Not seen (${m.markedBy ?? 'someone'})`;

export function JointAssessmentScreen() {
  const { events, error: eventsError } = useOpenEvents();
  const [picked, setPicked] = useState<string | null>(null);
  const eventId = picked ?? events?.[0]?.id ?? null;
  const [joint, setJoint] = useState<Joint | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setActions(me.actions))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const reload = useCallback(() => {
    if (!eventId) return;
    api<Joint>(`/events/${eventId}/joint-pda`)
      .then((j) => {
        setJoint(j);
        setError(null);
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  }, [eventId]);
  useEffect(reload, [reload]);
  const can = (a: string) => actions.includes(a);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: done });
      reload();
      return true;
    } catch (err) {
      const conflict =
        err instanceof ApiFailure && err.status === 409 && err.envelope.code === 'conflict';
      setMsg({
        kind: 'error',
        text: conflict
          ? 'Someone changed this while you were editing. The page now shows their version; check it and try again.'
          : describeFailure(err),
      });
      if (conflict) reload();
      return false;
    }
  };

  return (
    <section aria-labelledby="jpda-h">
      <h1 id="jpda-h">Joint damage assessment</h1>
      <p>
        The joint federal, state and county assessment: its schedule, the sample of verified homes
        the teams visit, and what the validators saw. Each stop shows the home as the street sheet
        does, never a name, contact or address; the county member of each team finds the door.
      </p>
      {eventsError ? <Status kind="error">{eventsError}</Status> : null}
      {events && events.length === 0 ? <p>There is no open event.</p> : null}
      {events && events.length > 0 ? (
        <EventPicker events={events} value={eventId} onChange={setPicked} />
      ) : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {!joint && !error && eventId ? <p role="status">Loading the joint assessment…</p> : null}
      {joint ? (
        <>
          <ScheduleForm
            key={`${joint.eventId}-${joint.schedule.version ?? 0}`}
            joint={joint}
            editable={can('joint_assessment.plan')}
            run={run}
          />
          <Sample joint={joint} editable={can('joint_assessment.plan')} run={run} />
          <Stops joint={joint} />
          {can('joint_assessment.validate') && joint.stops.length ? (
            <MarkForm key={joint.summary.pending} joint={joint} run={run} />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

type Run = (fn: () => Promise<unknown>, done: string) => Promise<boolean>;

function ScheduleForm({ joint, editable, run }: { joint: Joint; editable: boolean; run: Run }) {
  const s = joint.schedule;
  const [startsOn, setStartsOn] = useState(s.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(s.endsOn ?? '');
  const [areas, setAreas] = useState(s.areas.join('\n'));
  const [teams, setTeams] = useState(s.teams.length ? s.teams : [{ name: '', members: '' }]);
  const [status, setStatus] = useState(s.status);
  const order =
    startsOn && endsOn && endsOn < startsOn
      ? 'The assessment cannot end before it starts.'
      : undefined;
  if (!editable)
    return (
      <section aria-labelledby="jpda-schedule">
        <h2 id="jpda-schedule">Schedule</h2>
        <dl className="meta">
          <dt>Dates</dt>
          <dd>
            {s.startsOn
              ? `${s.startsOn}${s.endsOn && s.endsOn !== s.startsOn ? ` to ${s.endsOn}` : ''}`
              : 'Not set'}
          </dd>
          <dt>Areas</dt>
          <dd>{s.areas.length ? s.areas.join('; ') : 'Not set'}</dd>
          <dt>Status</dt>
          <dd>{STATUS[s.status]}</dd>
        </dl>
        {s.teams.length ? (
          <DataTable
            caption="Joint teams"
            rows={s.teams}
            rowKey={(t) => t.name}
            columns={[
              { key: 'name', header: 'Team', render: (t) => t.name },
              { key: 'members', header: 'Members', render: (t) => t.members },
            ]}
          />
        ) : null}
      </section>
    );
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (order) return;
    void run(
      () =>
        api(`/events/${joint.eventId}/joint-pda`, {
          method: 'PUT',
          ...(s.version !== null ? { version: s.version } : {}),
          body: {
            startsOn: startsOn || null,
            endsOn: endsOn || null,
            areas: areas
              .split('\n')
              .map((a) => a.trim())
              .filter(Boolean),
            teams: teams
              .map((t) => ({ name: t.name.trim(), members: t.members.trim() }))
              .filter((t) => t.name),
            status,
          },
        }),
      'Schedule saved.',
    );
  };
  return (
    <section aria-labelledby="jpda-schedule">
      <h2 id="jpda-schedule">Schedule</h2>
      <p className="hint">The dates and areas fill Box 10 of Form 010-0-13 in the package.</p>
      <form onSubmit={save} className="form-grid">
        <Field label="First day">
          {({ id }) => (
            <input
              id={id}
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
            />
          )}
        </Field>
        <Field label="Last day" {...(order ? { error: order } : {})}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="date"
              value={endsOn}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => setEndsOn(e.target.value)}
            />
          )}
        </Field>
        <Field label="Areas to assess" hint="One area per line.">
          {({ id, describedBy }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              value={areas}
              onChange={(e) => setAreas(e.target.value)}
            />
          )}
        </Field>
        <Field label="Status">
          {({ id }) => (
            <select
              id={id}
              value={status}
              onChange={(e) => setStatus(e.target.value as Schedule['status'])}
            >
              {Object.entries(STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </Field>
        <fieldset>
          <legend>Joint teams</legend>
          {teams.map((t, i) => (
            <div key={i} className="form-grid">
              <Field label={`Team ${i + 1} name`}>
                {({ id }) => (
                  <input
                    id={id}
                    value={t.name}
                    maxLength={80}
                    onChange={(e) =>
                      setTeams(teams.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))
                    }
                  />
                )}
              </Field>
              <Field
                label={`Team ${i + 1} members`}
                hint="Roles, e.g. FEMA IA validator; SEMA; county assessor."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={t.members}
                    maxLength={500}
                    onChange={(e) =>
                      setTeams(
                        teams.map((x, k) => (k === i ? { ...x, members: e.target.value } : x)),
                      )
                    }
                  />
                )}
              </Field>
              {teams.length > 1 ? (
                <button type="button" onClick={() => setTeams(teams.filter((_, k) => k !== i))}>
                  Remove team {i + 1}
                </button>
              ) : null}
            </div>
          ))}
          <button type="button" onClick={() => setTeams([...teams, { name: '', members: '' }])}>
            Add a team
          </button>
        </fieldset>
        <div className="toolbar">
          <button type="submit" className="primary">
            Save schedule
          </button>
        </div>
      </form>
    </section>
  );
}

function Sample({ joint, editable, run }: { joint: Joint; editable: boolean; run: Run }) {
  const s = joint.schedule;
  const [size, setSize] = useState(String(Math.min(30, Math.max(1, joint.candidates)) || 1));
  const [seed, setSeed] = useState('');
  const sizeN = Number(size);
  const sizeError =
    Number.isInteger(sizeN) && sizeN >= 1 && sizeN <= 500
      ? undefined
      : 'Enter a whole number from 1 to 500.';
  const seedN = Number(seed);
  const seedError =
    !seed.trim() || (Number.isInteger(seedN) && seedN >= 0 && seedN <= 2_147_483_647)
      ? undefined
      : 'Enter a whole number, or leave it empty for a new draw.';
  const draw = (e: FormEvent) => {
    e.preventDefault();
    if (sizeError || seedError) return;
    void run(
      () =>
        api(`/events/${joint.eventId}/joint-pda/sample`, {
          body: { size: sizeN, ...(seed.trim() ? { seed: seedN } : {}) },
        }),
      'Sample drawn.',
    );
  };
  return (
    <section aria-labelledby="jpda-sample">
      <h2 id="jpda-sample">Sample route</h2>
      <p>
        {joint.candidates.toLocaleString('en-US')} verified, counted{' '}
        {joint.candidates === 1 ? 'home' : 'homes'} to draw from. The sample is drawn in proportion
        to the homes at each degree of damage, at least one from each, and ordered as a route.
      </p>
      {s.sampleVersion > 0 ? (
        <p className="hint">
          Sample {s.sampleVersion}: {s.sampleSize} asked for, drawn {fmt(s.sampledAt)} with seed{' '}
          {s.sampleSeed} (the same seed draws the same route again while nothing is marked).
        </p>
      ) : null}
      {editable ? (
        <form onSubmit={draw} className="form-grid">
          <Field label="Homes in the sample" {...(sizeError ? { error: sizeError } : {})}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="numeric"
                value={size}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => setSize(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Seed (optional)"
            hint="Give an earlier seed to draw the same route again."
            {...(seedError ? { error: seedError } : {})}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="numeric"
                value={seed}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => setSeed(e.target.value)}
              />
            )}
          </Field>
          <div className="toolbar">
            <button type="submit" className="primary">
              Draw the sample
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function Stops({ joint }: { joint: Joint }) {
  const t = joint.summary;
  return (
    <section aria-labelledby="jpda-stops">
      <h2 id="jpda-stops">Stops and validation</h2>
      <p role="status">
        {t.stops} {t.stops === 1 ? 'stop' : 'stops'}: {t.validated} validated, {t.different} seen at
        a different degree, {t.notSeen} not seen, {t.pending} not marked yet.
      </p>
      <DataTable
        caption="Sample route"
        rows={joint.stops}
        rowKey={(s) => s.id}
        empty="No sample has been drawn yet."
        columns={[
          { key: 'seq', header: 'Stop', render: (s) => s.seq },
          { key: 'ref', header: 'Record', render: (s) => s.home?.ref ?? 'Unknown' },
          { key: 'stratum', header: 'Drawn as', render: (s) => DEGREE_NAMES[s.stratum] },
          {
            key: 'home',
            header: 'Home',
            render: (s) =>
              s.home
                ? `${s.home.type ?? 'Type unknown'}, ${s.home.units ?? 'unknown'} ${s.home.units === 1 ? 'unit' : 'units'}${s.home.counted ? '' : ' (no longer counted)'}`
                : 'Record not found',
          },
          { key: 'cell', header: 'Grid cell (100 m)', render: (s) => s.home?.usng ?? 'Unknown' },
          {
            key: 'area',
            header: 'ZIP, tract, jurisdiction',
            render: (s) =>
              [s.home?.postal, s.home?.tract, s.home?.jurisdiction].filter(Boolean).join(', ') ||
              'Unknown',
          },
          { key: 'mark', header: 'Validation', render: (s) => markText(s.mark) },
        ]}
      />
    </section>
  );
}

function MarkForm({ joint, run }: { joint: Joint; run: Run }) {
  const firstOpen = joint.stops.find((s) => !s.mark) ?? joint.stops[0]!;
  const [stopId, setStopId] = useState(firstOpen.id);
  const [result, setResult] = useState<Result>('validated');
  const [seen, setSeen] = useState<Degree | 'no_damage'>('minor');
  const [note, setNote] = useState('');
  const stop = joint.stops.find((s) => s.id === stopId)!;
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        api(`/joint-pda/stops/${stopId}/marks`, {
          body: {
            result,
            ...(result === 'different' ? { degreeSeen: seen } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      `Stop ${stop.seq} marked.`,
    );
  };
  return (
    <section aria-labelledby="jpda-mark">
      <h2 id="jpda-mark">Mark a stop</h2>
      <p className="hint">
        Nobody marks a home whose degree they set or assessed; the record is refused and the refusal
        is logged.
      </p>
      <form onSubmit={save}>
        <Field label="Stop">
          {({ id }) => (
            <select id={id} value={stopId} onChange={(e) => setStopId(e.target.value)}>
              {joint.stops.map((s) => (
                <option key={s.id} value={s.id}>
                  Stop {s.seq}: {s.home?.ref ?? 'record'} ({DEGREE_NAMES[s.stratum]})
                  {s.mark ? ', marked' : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
        <fieldset>
          <legend>What the team saw</legend>
          {(
            [
              ['validated', 'Damage as recorded'],
              ['different', 'A different degree of damage'],
              ['not_seen', 'Not seen (no access, nobody there)'],
            ] as const
          ).map(([value, text]) => (
            <label key={value} className="inline">
              <input
                type="radio"
                name="result"
                value={value}
                checked={result === value}
                onChange={() => setResult(value)}
              />{' '}
              {text}
            </label>
          ))}
        </fieldset>
        {result === 'different' ? (
          <Field label="Degree seen">
            {({ id }) => (
              <select
                id={id}
                value={seen}
                onChange={(e) => setSeen(e.target.value as Degree | 'no_damage')}
              >
                {Object.entries(SEEN).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <Field label="Note (optional)" hint="What the team saw; no names or addresses.">
          {({ id, describedBy }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
        <div className="toolbar">
          <button type="submit" className="primary">
            Save mark for stop {stop.seq}
          </button>
        </div>
      </form>
    </section>
  );
}

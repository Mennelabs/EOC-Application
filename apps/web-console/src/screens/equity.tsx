/**
 * The equity dashboard (layer-6 task G; EQ-11, EQ-12, EQ-13, CON-07, WCAG
 * 2.2 AA): alerts first, each with suggested outreach and, for those who
 * act on them, a form to record the outreach taken; then the tracts as a
 * table (rates against households and residential structures, income band,
 * renter and limited-English shares), the income bands, and time to review
 * and to help by income band, occupancy, language and channel. Counts from
 * 1 to 10 read "Fewer than 11" and nothing worked out from them is shown.
 * "Check now" asks the worker to work the alerts out again.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';

interface Tract {
  geoid: string;
  name: string | null;
  households: number | null;
  renterSharePct: number | null;
  povertyPct: number | null;
  limitedEnglishPct: number | null;
  incomeBand: number | null;
  structures: number | null;
  reports: number | null;
  needs: number | null;
  reportsPer1000Households: number | null;
  reportsPer100Structures: number | null;
  needsPer1000Households: number | null;
  underReported: boolean;
}
interface Band {
  band: number;
  tracts: number;
  reports: number | null;
  rate: number | null;
  basis: 'structures' | 'households';
  underReported: boolean;
}
interface Group {
  dimension: 'income_band' | 'tenure' | 'language' | 'channel';
  group: string;
  label: string;
  reports: number | null;
  reviewMedianHours: number | null;
  needs: number | null;
  helpMedianHours: number | null;
  reviewGap: boolean;
  helpGap: boolean;
}
interface Alert {
  id: string;
  version: number;
  kind: 'coverage' | 'review_gap' | 'help_gap';
  subjectKind: string;
  label: string;
  value: number | null;
  threshold: number;
  outreach: string;
  raisedAt: string;
  clearedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  actionTaken: string | null;
}
interface Equity {
  asOf: string;
  thresholds: { coverageRatio: number; gapRatio: number; minCell: number };
  basis: 'footprint' | 'county' | 'none';
  tracts: Tract[];
  bands: Band[];
  groups: Group[];
  eventMedians: { reviewHours: number | null; helpHours: number | null };
  alerts: Alert[];
}

const KIND: Record<Alert['kind'], string> = {
  coverage: 'Under-reported',
  review_gap: 'Waits longer for review',
  help_gap: 'Waits longer for help',
};
const DIMENSIONS: [Group['dimension'], string][] = [
  ['income_band', 'By income band'],
  ['tenure', 'By occupancy'],
  ['language', 'By language'],
  ['channel', 'By channel'],
];
const count = (n: number | null) => (n === null ? 'Fewer than 11' : n.toLocaleString('en-US'));
const val = (n: number | null, suffix = '') =>
  n === null ? 'Not shown' : `${n.toLocaleString('en-US')}${suffix}`;
const census = (n: number | null, suffix = '') =>
  n === null ? 'Unknown' : `${n.toLocaleString('en-US')}${suffix}`;
const band = (b: number | null) =>
  b === null
    ? 'Unknown'
    : b === 1
      ? '1 (highest poverty share)'
      : b === 5
        ? '5 (lowest poverty share)'
        : String(b);

export function EquityScreen() {
  const { events, error: eventsError } = useOpenEvents();
  const [picked, setPicked] = useState<string | null>(null);
  const eventId = picked ?? events?.[0]?.id ?? null;
  const [data, setData] = useState<Equity | null>(null);
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
  const load = useCallback(() => {
    if (!eventId) return;
    api<Equity>(`/events/${eventId}/equity`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  }, [eventId]);
  useEffect(load, [load]);
  const canAct = actions.includes('equity.act');
  const open = data?.alerts.filter((a) => !a.clearedAt) ?? [];
  const cleared = data?.alerts.filter((a) => a.clearedAt) ?? [];

  const check = async () => {
    if (!eventId) return;
    setMsg(null);
    try {
      await api(`/events/${eventId}/equity/evaluate`, { method: 'POST', body: {} });
      setMsg({
        kind: 'success',
        text: 'Asked for a check. Alerts update within a minute; reload to see them.',
      });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };

  return (
    <section aria-labelledby="eq-h">
      <h1 id="eq-h">Equity</h1>
      <p>
        Where reports and help are reaching people, by census tract and group, to plan outreach.
        Counts of fewer than 11 people or households are not shown, and neither is anything worked
        out from them. Census figures are public and shown as published.
      </p>
      {eventsError ? <Status kind="error">{eventsError}</Status> : null}
      {events && events.length === 0 ? <p>There is no open event.</p> : null}
      {events && events.length > 0 ? (
        <EventPicker events={events} value={eventId} onChange={setPicked} />
      ) : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {!data && !error && eventId ? <p role="status">Loading the equity figures…</p> : null}
      {data ? (
        <>
          <p className="hint">
            Figures as of {fmt(data.asOf)}.{' '}
            {data.basis === 'footprint'
              ? 'Tracts in the event footprint.'
              : data.basis === 'county'
                ? 'All tracts of the county (no footprint drawn).'
                : 'No census tracts are loaded yet; tract figures appear once reference data is in.'}{' '}
            An area is flagged when its reports fall below{' '}
            {Math.round(data.thresholds.coverageRatio * 100)}% of the best-covered income band; a
            group when its median wait is over {data.thresholds.gapRatio} times the event’s.
          </p>
          <section aria-labelledby="eq-alerts">
            <h2 id="eq-alerts">Alerts</h2>
            {canAct ? (
              <div className="toolbar">
                <button type="button" onClick={() => void check()}>
                  Check now
                </button>
                <button type="button" onClick={load}>
                  Reload
                </button>
              </div>
            ) : null}
            {open.length === 0 ? (
              <p className="empty">No open alert.</p>
            ) : (
              <ul className="alert-list">
                {open.map((a) => (
                  <li key={a.id}>
                    <AlertItem
                      alert={a}
                      canAct={canAct}
                      onDone={(text) => {
                        setMsg({ kind: 'success', text });
                        load();
                      }}
                      onFail={(text) => {
                        setMsg({ kind: 'error', text });
                        load();
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
            {cleared.length ? (
              <DataTable
                caption="Alerts cleared in the last seven days"
                rows={cleared}
                rowKey={(a) => a.id}
                columns={[
                  { key: 'what', header: 'Alert', render: (a) => `${KIND[a.kind]}: ${a.label}` },
                  { key: 'cleared', header: 'Cleared', render: (a) => fmt(a.clearedAt) },
                  {
                    key: 'action',
                    header: 'Outreach recorded',
                    render: (a) => a.actionTaken ?? 'None',
                  },
                ]}
              />
            ) : null}
          </section>
          <section aria-labelledby="eq-tracts">
            <h2 id="eq-tracts">Census tracts</h2>
            <DataTable
              caption="Reports and needs by census tract"
              rows={data.tracts}
              rowKey={(t) => t.geoid}
              empty="No census tracts are loaded for this county yet."
              columns={[
                {
                  key: 'tract',
                  header: 'Tract',
                  render: (t) => `${t.geoid}${t.name ? ` (${t.name})` : ''}`,
                },
                { key: 'band', header: 'Income band', render: (t) => band(t.incomeBand) },
                { key: 'hh', header: 'Households', render: (t) => census(t.households) },
                { key: 'renter', header: 'Renters', render: (t) => census(t.renterSharePct, '%') },
                {
                  key: 'poverty',
                  header: 'Below poverty',
                  render: (t) => census(t.povertyPct, '%'),
                },
                {
                  key: 'lep',
                  header: 'Limited English',
                  render: (t) => census(t.limitedEnglishPct, '%'),
                },
                { key: 'st', header: 'Homes (structures)', render: (t) => census(t.structures) },
                { key: 'reports', header: 'Reports', render: (t) => count(t.reports) },
                {
                  key: 'rate',
                  header: 'Reports per 100 homes',
                  render: (t) => val(t.reportsPer100Structures),
                },
                { key: 'needs', header: 'Needs', render: (t) => count(t.needs) },
                {
                  key: 'flag',
                  header: 'Under-reported',
                  render: (t) => (t.underReported ? 'Yes' : 'No'),
                },
              ]}
            />
            <DataTable
              caption="Reports by income band"
              rows={data.bands}
              rowKey={(b) => String(b.band)}
              columns={[
                { key: 'band', header: 'Income band', render: (b) => band(b.band) },
                { key: 'tracts', header: 'Tracts', render: (b) => b.tracts },
                { key: 'reports', header: 'Reports', render: (b) => count(b.reports) },
                {
                  key: 'rate',
                  header: 'Coverage',
                  render: (b) =>
                    b.rate === null
                      ? 'Not shown'
                      : `${b.rate} per ${b.basis === 'structures' ? '100 homes' : '1,000 households'}`,
                },
                {
                  key: 'flag',
                  header: 'Under-reported',
                  render: (b) => (b.underReported ? 'Yes' : 'No'),
                },
              ]}
            />
          </section>
          <section aria-labelledby="eq-groups">
            <h2 id="eq-groups">Time to review and to help</h2>
            <p>
              Event medians: {val(data.eventMedians.reviewHours, ' hours')} to first review,{' '}
              {val(data.eventMedians.helpHours, ' hours')} to help.
            </p>
            {DIMENSIONS.map(([d, title]) => (
              <DataTable
                key={d}
                caption={title}
                rows={data.groups.filter((g) => g.dimension === d)}
                rowKey={(g) => `${g.dimension}-${g.group}`}
                empty="No reports yet."
                columns={[
                  { key: 'group', header: 'Group', render: (g) => g.label },
                  { key: 'reports', header: 'Reports', render: (g) => count(g.reports) },
                  {
                    key: 'review',
                    header: 'Median hours to review',
                    render: (g) =>
                      `${val(g.reviewMedianHours)}${g.reviewGap ? ' (waits longer)' : ''}`,
                  },
                  { key: 'needs', header: 'Needs', render: (g) => count(g.needs) },
                  {
                    key: 'help',
                    header: 'Median hours to help',
                    render: (g) => `${val(g.helpMedianHours)}${g.helpGap ? ' (waits longer)' : ''}`,
                  },
                ]}
              />
            ))}
          </section>
        </>
      ) : null}
    </section>
  );
}

function AlertItem({
  alert: a,
  canAct,
  onDone,
  onFail,
}: {
  alert: Alert;
  canAct: boolean;
  onDone: (text: string) => void;
  onFail: (text: string) => void;
}) {
  const [action, setAction] = useState(a.actionTaken ?? '');
  const [error, setError] = useState<string | undefined>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (action.trim().length < 5) {
      setError('Say what outreach was taken or planned, in a few words.');
      return;
    }
    setError(undefined);
    try {
      await api(`/equity-alerts/${a.id}/acknowledge`, {
        version: a.version,
        body: { actionTaken: action.trim() },
      });
      onDone(`Outreach recorded for ${a.label}.`);
    } catch (err) {
      onFail(
        err instanceof ApiFailure && err.status === 409
          ? 'Someone recorded outreach for this alert meanwhile; the page now shows it.'
          : describeFailure(err),
      );
    }
  };
  return (
    <article aria-labelledby={`alert-${a.id}`} className="panel">
      <h3 id={`alert-${a.id}`}>
        {KIND[a.kind]}: {a.label}
      </h3>
      <p>
        {a.kind === 'coverage'
          ? a.value === null
            ? `Fewer than 11 reports; the bar is ${a.threshold}.`
            : `${a.value} against a bar of ${a.threshold}.`
          : `Median ${a.value ?? 'not shown'} hours; the bar is ${a.threshold} hours.`}{' '}
        Raised {fmt(a.raisedAt)}.
      </p>
      <p>
        <strong>Suggested outreach:</strong> {a.outreach}
      </p>
      {a.acknowledgedAt ? (
        <p className="hint">
          Outreach recorded by {a.acknowledgedBy ?? 'someone'} {fmt(a.acknowledgedAt)}:{' '}
          {a.actionTaken}
        </p>
      ) : null}
      {canAct ? (
        <form onSubmit={(e) => void submit(e)}>
          <Field
            label={`Outreach taken for ${a.label}`}
            hint="What was done or planned, without names."
            {...(error ? { error } : {})}
          >
            {({ id, describedBy, invalid }) => (
              <textarea
                id={id}
                maxLength={1000}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={action}
                onChange={(e) => setAction(e.target.value)}
              />
            )}
          </Field>
          <button type="submit">Record outreach</button>
        </form>
      ) : null}
    </article>
  );
}

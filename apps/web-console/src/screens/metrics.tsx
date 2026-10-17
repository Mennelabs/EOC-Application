/**
 * Metrics (layer-6 task G; BRD:FR-14.01–14.07, AC-14C, MET, WCAG 2.2 AA):
 * the figures from the shared definitions for a chosen period and filters,
 * grouped, each with its breakdown, what was left out and the version of
 * its definition; trends by operational period; and, for those who may
 * export, the same figures as CSV or PDF (one computation, so the totals
 * match). Tables first; nothing personal.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure, download } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';
import { fromZoneInput } from '../ui/time.ts';

interface MetricValue {
  key: string;
  group: string;
  title: string;
  unit: string;
  value: number | null;
  parts: { key: string; label: string; value: number | null }[];
  incomplete: { count: number; note: string } | null;
  definition: { key: string; version: number; source: 'shipped' | 'county'; text: string };
}

interface Result {
  scope: { from: string; to: string; timeZone: string };
  generatedAt: string;
  metrics: MetricValue[];
  trends: {
    periods: { from: string; to: string; label: string }[];
    series: { key: string; title: string; values: number[] }[];
  };
  exclusions: string[];
}

const GROUPS: [string, string][] = [
  ['damage', 'Damage'],
  ['reports', 'Resident reports and review'],
  ['missions', 'Missions'],
  ['personnel', 'Personnel'],
  ['badges', 'Badges'],
  ['needs', 'Help for residents'],
  ['information', 'Recovery information'],
  ['ai', 'Computer help (AI)'],
  ['accountability', 'Privacy and accountability'],
];
const KINDS = [
  'welfare_check',
  'verification_route',
  'cleanup_work_order',
  'delivery',
  'outreach_sweep',
  'site_staffing',
  'search',
  'road_clearance',
  'traffic_control',
  'debris',
  'other',
];
const label = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' ');
const show = (v: number | null, unit: string) =>
  v === null ? 'Unknown' : unit === 'percent' ? `${v}%` : `${v.toLocaleString('en-US')} ${unit}`;
/** A datetime-local value as an ISO instant, or nothing. */
const instant = (v: string) => (v ? fromZoneInput(v).toISOString() : '');

export function MetricsScreen() {
  const { events, error: eventsError } = useOpenEvents();
  const [picked, setPicked] = useState<string | null>(null);
  const eventId = picked ?? events?.[0]?.id ?? null;
  const [actions, setActions] = useState<string[]>([]);
  const [form, setForm] = useState({
    from: '',
    to: '',
    missionKind: '',
    priority: '',
    missionState: '',
    degree: '',
  });
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    api<Result>(`/events/${eventId}/metrics${query}`)
      .then((r) => {
        setResult(r);
        setError(null);
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  }, [eventId, query]);
  useEffect(load, [load]);
  const can = (a: string) => actions.includes(a);
  const range =
    form.from && form.to && new Date(form.from).getTime() >= new Date(form.to).getTime()
      ? 'The period must start before it ends.'
      : undefined;

  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (range) return;
    const p = new URLSearchParams();
    if (form.from) p.set('from', instant(form.from));
    if (form.to) p.set('to', instant(form.to));
    for (const k of ['missionKind', 'priority', 'missionState', 'degree'] as const)
      if (form[k]) p.set(k, form[k]);
    const q = p.toString();
    setQuery(q ? `?${q}` : '');
  };
  const exportAs = (format: 'csv' | 'pdf') => {
    if (!eventId) return;
    download(
      `/events/${eventId}/metrics.${format}${query}`,
      `metrics-${new Date().toISOString().slice(0, 10)}.${format}`,
    ).catch((err: unknown) => setError(describeFailure(err)));
  };

  return (
    <section aria-labelledby="met-h">
      <h1 id="met-h">Metrics</h1>
      <p>
        Figures from the shared definitions, for the period and filters you choose. The screen, the
        CSV and the PDF come from one computation, so their totals match. Each figure names the
        version of its definition and what it leaves out.
      </p>
      {eventsError ? <Status kind="error">{eventsError}</Status> : null}
      {events && events.length === 0 ? <p>There is no open event.</p> : null}
      {events && events.length > 0 ? (
        <EventPicker events={events} value={eventId} onChange={setPicked} />
      ) : null}
      <form onSubmit={apply} className="form-grid" aria-label="Period and filters">
        <Field label="From (optional)" hint="Empty: the last seven days of the event.">
          {({ id, describedBy }) => (
            <input
              id={id}
              type="datetime-local"
              aria-describedby={describedBy}
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          )}
        </Field>
        <Field label="To (optional)" hint="Empty: now." {...(range ? { error: range } : {})}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="datetime-local"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          )}
        </Field>
        <Field label="Mission kind">
          {({ id }) => (
            <select
              id={id}
              value={form.missionKind}
              onChange={(e) => setForm({ ...form, missionKind: e.target.value })}
            >
              <option value="">All kinds</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Mission priority">
          {({ id }) => (
            <select
              id={id}
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            >
              <option value="">All priorities</option>
              {['low', 'normal', 'high', 'urgent'].map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Mission state">
          {({ id }) => (
            <select
              id={id}
              value={form.missionState}
              onChange={(e) => setForm({ ...form, missionState: e.target.value })}
            >
              <option value="">All states</option>
              {['open', 'en_route', 'on_scene', 'cleared', 'closed', 'canceled'].map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Degree of damage">
          {({ id }) => (
            <select
              id={id}
              value={form.degree}
              onChange={(e) => setForm({ ...form, degree: e.target.value })}
            >
              <option value="">All degrees</option>
              {['affected', 'minor', 'major', 'destroyed'].map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="toolbar">
          <button type="submit" className="primary">
            Show the figures
          </button>
          {can('metric.export') ? (
            <>
              <button type="button" onClick={() => exportAs('csv')}>
                Download CSV
              </button>
              <button type="button" onClick={() => exportAs('pdf')}>
                Download PDF
              </button>
            </>
          ) : null}
        </div>
      </form>
      {error ? <Status kind="error">{error}</Status> : null}
      {!result && !error && eventId ? <p role="status">Working out the figures…</p> : null}
      {result ? (
        <>
          <p className="hint" role="status">
            From {fmt(result.scope.from)} to {fmt(result.scope.to)} ({result.scope.timeZone}).
            Worked out {fmt(result.generatedAt)}.
          </p>
          {GROUPS.map(([g, title]) => {
            const rows = result.metrics.filter((m) => m.group === g);
            if (!rows.length) return null;
            return (
              <section key={g} aria-labelledby={`met-${g}`}>
                <h2 id={`met-${g}`}>{title}</h2>
                <DataTable
                  caption={title}
                  rows={rows}
                  rowKey={(m) => m.key}
                  columns={[
                    { key: 'title', header: 'Metric', render: (m) => m.title },
                    { key: 'value', header: 'Value', render: (m) => show(m.value, m.unit) },
                    {
                      key: 'parts',
                      header: 'Breakdown',
                      render: (m) =>
                        m.parts.length
                          ? m.parts
                              .map(
                                (p) =>
                                  `${p.label}: ${p.value === null ? 'Unknown' : p.value.toLocaleString('en-US')}`,
                              )
                              .join('; ')
                          : '—',
                    },
                    {
                      key: 'left',
                      header: 'Left out',
                      render: (m) =>
                        m.incomplete ? `${m.incomplete.count} ${m.incomplete.note}` : 'None',
                    },
                    {
                      key: 'def',
                      header: 'Definition',
                      render: (m) =>
                        `${m.definition.source === 'county' ? 'County' : 'Shipped'} version ${m.definition.version}`,
                    },
                  ]}
                />
              </section>
            );
          })}
          <section aria-labelledby="met-trends">
            <h2 id="met-trends">By operational period</h2>
            <DataTable
              caption="Trends by operational period"
              rows={result.trends.periods.map((p, i) => ({ ...p, i }))}
              rowKey={(p) => p.from}
              empty="The period is too short for a trend."
              columns={[
                { key: 'p', header: 'Period starting', render: (p) => p.label },
                ...result.trends.series.map((s) => ({
                  key: s.key,
                  header: s.title,
                  render: (p: { i: number }) => (s.values[p.i] ?? 0).toLocaleString('en-US'),
                })),
              ]}
            />
          </section>
          <section aria-labelledby="met-defs">
            <h2 id="met-defs">Definitions used and what is left out</h2>
            <dl className="definitions">
              {result.metrics.map((m) => (
                <div key={m.key}>
                  <dt>
                    {m.title} ({m.definition.source === 'county' ? 'county' : 'shipped'} version{' '}
                    {m.definition.version})
                  </dt>
                  <dd>{m.definition.text}</dd>
                </div>
              ))}
            </dl>
            <ul>
              {result.exclusions.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </section>
  );
}

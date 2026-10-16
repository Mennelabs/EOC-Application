/**
 * Intake setup and assisted entry (plan console screens 4–6; CON-02, CHN-08,
 * INT-01, CHN-05/06, AIG-01): every open event's link, kiosk link, keywords
 * and number with a code to print; question graph versions with a JSON
 * editor that enforces the schema and the string rules and publishes with
 * confirmation; the assisted workspace, which opens the kiosk flow (the same
 * questions, the helper and consent recorded, the device cleared when done);
 * and the AI use register, read-only.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';

interface EventRow {
  id: string;
  name: string;
  hazardType: string;
  status: string;
  intakeSlug: string | null;
  intakeKeywords: string[];
}

interface IntakeFacts {
  slug: string | null;
  keywords: string[];
  url: string | null;
  kioskUrl: string | null;
  smsNumber: string | null;
  graph: { key: string; version: number } | null;
}

function useFacts(events: EventRow[] | null) {
  const [facts, setFacts] = useState<Record<string, IntakeFacts>>({});
  useEffect(() => {
    let live = true;
    for (const ev of (events ?? []).filter((e) => e.status === 'active')) {
      api<IntakeFacts>(`/events/${ev.id}/intake`)
        .then((f) => live && setFacts((m) => ({ ...m, [ev.id]: f })))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [events]);
  return facts;
}

function Qr({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 160 })
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [url]);
  return src ? <img src={src} alt={`Code that opens ${url}`} width={160} height={160} /> : null;
}

export function IntakeSetupScreen() {
  const events = useList<EventRow>('/events');
  const facts = useFacts(events.rows);
  const active = (events.rows ?? []).filter((e) => e.status === 'active');
  return (
    <section aria-labelledby="intake-h">
      <h1 id="intake-h">Intake setup</h1>
      <p>
        Open an event on the Events page with its link and keywords; everything a flyer, door hanger
        or kiosk needs is here (CHN-08, CON-02).
      </p>
      {events.error ? <Status kind="error">{events.error}</Status> : null}
      {active.length === 0 ? (
        <p className="empty">No open event. Open one on the Events page.</p>
      ) : null}
      {active.map((ev) => {
        const f = facts[ev.id];
        return (
          <section key={ev.id} className="panel" aria-labelledby={`ev-${ev.id}`}>
            <h2 id={`ev-${ev.id}`}>{ev.name}</h2>
            {f ? (
              <div className="layout" style={{ gap: '1rem', alignItems: 'flex-start' }}>
                <dl className="meta">
                  <dt>Resident link</dt>
                  <dd>
                    {f.url ? (
                      <a href={f.url} target="_blank" rel="noopener noreferrer">
                        {f.url}
                      </a>
                    ) : (
                      '—'
                    )}
                  </dd>
                  <dt>Kiosk / assisted link</dt>
                  <dd>
                    {f.kioskUrl ? (
                      <a href={f.kioskUrl} target="_blank" rel="noopener noreferrer">
                        {f.kioskUrl}
                      </a>
                    ) : (
                      '—'
                    )}
                  </dd>
                  <dt>Text keywords</dt>
                  <dd>
                    {f.keywords.join(' / ') || '—'}
                    {f.smsNumber ? ` to ${f.smsNumber}` : ' (no number on file yet)'}
                  </dd>
                  <dt>Questions</dt>
                  <dd>
                    {f.graph ? `${f.graph.key} version ${f.graph.version}` : 'shipped default'}
                  </dd>
                </dl>
                {f.url ? <Qr url={f.url} /> : null}
              </div>
            ) : (
              <p role="status">Loading…</p>
            )}
          </section>
        );
      })}
      <GraphVersions />
    </section>
  );
}

interface GraphMeta {
  id: string;
  key: string;
  graphVersion: number;
  status: string;
  languages: string[];
  hazards: string[];
  changeReason: string | null;
  publishedAt: string | null;
  createdAt: string;
  questions: number;
}

function GraphVersions() {
  const { rows, error, reload } = useList<GraphMeta>('/intake-graphs');
  const [editing, setEditing] = useState<{ key: string; json: string; reason: string } | null>(
    null,
  );
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const startEdit = async (g: GraphMeta) => {
    const full = await api<{ graph: unknown }>(`/intake-graphs/${g.key}/${g.graphVersion}`);
    setEditing({ key: g.key, json: JSON.stringify(full.graph, null, 2), reason: '' });
  };
  return (
    <section aria-labelledby="graphs-h">
      <h2 id="graphs-h">Question graph versions</h2>
      <p>
        Every version keeps its reports readable. A new draft must fit the schema and pass the
        reading-level and tone rules (INT-08, INT-17); publishing asks for confirmation.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      <DataTable
        caption="Question graphs"
        rows={rows ?? []}
        rowKey={(g) => g.id}
        columns={[
          { key: 'key', header: 'Key', render: (g) => g.key },
          { key: 'version', header: 'Version', render: (g) => String(g.graphVersion) },
          { key: 'status', header: 'Status', render: (g) => g.status },
          { key: 'q', header: 'Questions', render: (g) => String(g.questions) },
          { key: 'langs', header: 'Languages', render: (g) => g.languages.join(', ') },
          { key: 'reason', header: 'Change', render: (g) => g.changeReason ?? '—' },
          { key: 'published', header: 'Published', render: (g) => fmt(g.publishedAt) },
          {
            key: 'actions',
            header: 'Actions',
            render: (g) => (
              <Toolbar>
                <button type="button" onClick={() => void startEdit(g)}>
                  Draft a new version from this…
                </button>
                {g.status === 'draft' ? (
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () =>
                          api(`/intake-graphs/${g.key}/${g.graphVersion}/publish`, {
                            method: 'POST',
                            idempotent: false,
                          }),
                        `Published version ${g.graphVersion}.`,
                      )
                    }
                  >
                    Publish
                  </button>
                ) : null}
              </Toolbar>
            ),
          },
        ]}
      />
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            let graph: unknown;
            try {
              graph = JSON.parse(editing.json);
            } catch {
              setMsg('The JSON does not parse.');
              return;
            }
            void run(
              () =>
                api(`/intake-graphs/${editing.key}`, {
                  method: 'PUT',
                  body: { graph, changeReason: editing.reason },
                }),
              'Draft saved. Publish it when the wording is reviewed.',
            ).then(() => setEditing(null));
          }}
        >
          <h3>New draft of {editing.key}</h3>
          <Field
            label="Graph JSON"
            hint="Prompts at or below grade 5, no exclamation marks or blame; the server lists anything that breaks the rules"
          >
            {({ id }) => (
              <textarea
                id={id}
                value={editing.json}
                onChange={(e) => setEditing({ ...editing, json: e.target.value })}
                rows={24}
                style={{ fontFamily: 'monospace' }}
              />
            )}
          </Field>
          <Field label="What changed and why">
            {({ id }) => (
              <input
                id={id}
                value={editing.reason}
                onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                required
                minLength={3}
              />
            )}
          </Field>
          <Toolbar>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Save draft
            </button>
          </Toolbar>
        </form>
      ) : null}
    </section>
  );
}

export function AssistedScreen() {
  const events = useList<EventRow>('/events');
  const facts = useFacts(events.rows);
  const active = (events.rows ?? []).filter((e) => e.status === 'active');
  return (
    <section aria-labelledby="assist-h">
      <h1 id="assist-h">Assisted report</h1>
      <p>
        Enter a report with the person present, on the phone or at a kiosk (CHN-05/06). The kiosk
        flow asks the same questions as the resident app, records you as the helper and the person's
        consent, keeps unsent reports on the device encrypted until they send, and clears itself
        when done (CHN-07).
      </p>
      <p>
        Choose "I am helping someone else report" on the first screen. Reports you enter cannot be
        approved by you (BRD:FR-12.04).
      </p>
      {events.error ? <Status kind="error">{events.error}</Status> : null}
      {active.length === 0 ? <p className="empty">No open event.</p> : null}
      <ul>
        {active.map((ev) => {
          const f = facts[ev.id];
          return (
            <li key={ev.id}>
              {ev.name}:{' '}
              {f?.kioskUrl ? (
                <a href={f.kioskUrl} target="_blank" rel="noopener noreferrer">
                  open the assisted flow in a new tab
                </a>
              ) : (
                'loading…'
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface RegisterEntry {
  id: string;
  version: number;
  feature: string;
  provider: string;
  model: string;
  modelVersion: string | null;
  dataSent: string;
  decisionInformed: string;
  humanCheckpoint: string;
  owner: string;
  usRegion: boolean;
  zeroRetention: boolean;
  noTraining: boolean;
  evaluation: unknown;
  enabled: boolean;
  updatedAt: string;
}

interface HealthAlert {
  id: string;
  feature: string;
  scope: string;
  kind: 'corrections' | 'failures' | 'fairness';
  counted: number;
  flagged: number;
  rate: number;
  threshold: number;
  raisedAt: string;
  acknowledgedAt: string | null;
}

interface Agreement {
  minimum: number;
  margin: number;
  models: {
    model: string;
    decisions: number;
    agreed: number;
    rate: number;
    slices: {
      dimension: 'hazard' | 'home_type' | 'income_band';
      group: string;
      decisions: number;
      agreed: number;
      rate: number;
      behind: boolean;
    }[];
  }[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const DIMENSION: Record<string, string> = {
  hazard: 'Hazard',
  home_type: 'Home type',
  income_band: 'Income band',
};

const alertWhat = (a: HealthAlert) => {
  if (a.kind === 'fairness') {
    const [dimension, group] = a.scope.split(':');
    return `Reviewers agreed with it on ${pct(1 - a.rate)} of ${a.counted} decisions for ${(DIMENSION[dimension ?? ''] ?? dimension ?? '').toLowerCase()} ${group ?? ''}, more than the margin under the model's overall agreement`;
  }
  const what = a.kind === 'corrections' ? 'corrected or rejected' : 'failed';
  return `${a.flagged} of the last ${a.counted} outputs${a.scope ? ` in ${a.scope}` : ''} were ${what} (${pct(a.rate)}; the line is ${pct(a.threshold)})`;
};

/**
 * Open AI health alerts (AIG-09 as decided 2026-10-15: alert, never switch off) and reviewer
 * agreement with the severity suggestion per model, by hazard, home type and income band
 * (PHO-13). Income band 1 is the county's highest-poverty fifth of tracts.
 */
interface Measured {
  count: number;
  p95Ms: number | null;
  targetMs: number;
  met: boolean | null;
}
interface CommandPerformance {
  days: number;
  deadlineMs: number;
  shorthand: Measured;
  interpretation: Measured & { timedOut: number };
  execution: Measured & { stillRunning: number };
}

const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(2)} s`);

/** CMD-38: the command window's response times against the Section 30.2 targets. */
function CommandTimes() {
  const [perf, setPerf] = useState<CommandPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<CommandPerformance>('/commands/performance?days=7')
      .then((p) => live && setPerf(p))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, []);
  const rows = perf
    ? [
        { key: 'shorthand', what: 'Shorthand prepared', m: perf.shorthand, extra: '' },
        {
          key: 'interpretation',
          what: 'Plain words read by the AI',
          m: perf.interpretation,
          extra: perf.interpretation.timedOut ? `${perf.interpretation.timedOut} timed out` : '',
        },
        {
          key: 'execution',
          what: 'Confirmed command run',
          m: perf.execution,
          extra: perf.execution.stillRunning
            ? `${perf.execution.stillRunning} still running past the deadline`
            : '',
        },
      ]
    : [];
  return (
    <>
      <h2 id="command-times-h">Command window response times</h2>
      <p>
        The slowest of every twenty, over the last {perf?.days ?? 7} days, against the targets.
        Nothing waits longer than {perf ? perf.deadlineMs / 1000 : 15} seconds without saying so:
        the AI reading is given up, and a command still running says it is still running.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {perf ? (
        <DataTable
          caption="Command window response times (95th percentile)"
          rows={rows}
          rowKey={(r) => r.key}
          columns={[
            { key: 'what', header: 'Step', render: (r) => r.what },
            { key: 'n', header: 'Count', render: (r) => String(r.m.count) },
            { key: 'p95', header: '95th percentile', render: (r) => seconds(r.m.p95Ms) },
            { key: 'target', header: 'Target', render: (r) => seconds(r.m.targetMs) },
            {
              key: 'met',
              header: 'Within target',
              render: (r) => (r.m.met === null ? 'No data yet' : r.m.met ? 'Yes' : 'No'),
            },
            { key: 'note', header: 'Notes', render: (r) => r.extra || '—' },
          ]}
        />
      ) : null}
    </>
  );
}

function AiHealth({ onChanged }: { onChanged: (text: string, kind: 'success' | 'error') => void }) {
  const alerts = useList<HealthAlert>('/ai-register/alerts');
  const [agreement, setAgreement] = useState<Agreement | null>(null);
  const [agreementError, setAgreementError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Agreement>('/ai-register/severity-agreement')
      .then((a) => live && setAgreement(a))
      .catch((e: unknown) => live && setAgreementError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      <h2 id="ai-alerts-h">Open alerts</h2>
      <p>
        An alert tells the people who manage this register when people correct a feature too often,
        when its calls fail too often, or when reviewers agree with the severity suggestion less for
        one group of homes than for the rest. Features stay on; an alert clears by itself when the
        numbers recover.
      </p>
      {alerts.error ? <Status kind="error">{alerts.error}</Status> : null}
      <DataTable
        caption="Open AI alerts"
        rows={alerts.rows ?? []}
        rowKey={(a) => a.id}
        empty="No open alerts."
        columns={[
          { key: 'feature', header: 'Feature', render: (a) => a.feature },
          { key: 'what', header: 'What happened', render: alertWhat },
          { key: 'raised', header: 'Raised', render: (a) => fmt(a.raisedAt) },
          {
            key: 'ack',
            header: 'Seen',
            render: (a) =>
              a.acknowledgedAt ? (
                fmt(a.acknowledgedAt)
              ) : (
                <button
                  type="button"
                  aria-label={`Mark the ${a.feature} alert as seen…`}
                  onClick={() =>
                    void api(`/ai-register/alerts/${a.id}/acknowledge`, { method: 'POST' })
                      .then(() => {
                        onChanged(
                          'Alert marked as seen. It stays open until the numbers recover.',
                          'success',
                        );
                        alerts.reload();
                      })
                      .catch((e: unknown) => onChanged(describeFailure(e), 'error'))
                  }
                >
                  Mark as seen…
                </button>
              ),
          },
        ]}
      />
      <h2 id="ai-agreement-h">Severity suggestion: reviewer agreement</h2>
      {agreementError ? <Status kind="error">{agreementError}</Status> : null}
      {agreement ? (
        <>
          <p>
            How often the degree a reviewer set matched the AI suggestion, for each model version. A
            group is marked behind when it has at least {agreement.minimum} decisions and its
            agreement is more than {pct(agreement.margin)} points under the model&rsquo;s overall
            agreement. Income band 1 is the fifth of the county&rsquo;s census tracts with the
            highest poverty share; band 5 the lowest.
          </p>
          {agreement.models.length === 0 ? (
            <p className="empty">No reviewer decisions on a suggestion yet.</p>
          ) : null}
          {agreement.models.map((m) => (
            <DataTable
              key={m.model}
              caption={`${m.model}: ${pct(m.rate)} agreement over ${m.decisions} decisions`}
              rows={m.slices}
              rowKey={(x) => `${x.dimension}:${x.group}`}
              columns={[
                { key: 'dim', header: 'Grouped by', render: (x) => DIMENSION[x.dimension] },
                { key: 'group', header: 'Group', render: (x) => x.group.replace('_', ' ') },
                { key: 'n', header: 'Decisions', render: (x) => String(x.decisions) },
                { key: 'agreed', header: 'Agreed', render: (x) => `${x.agreed} (${pct(x.rate)})` },
                { key: 'behind', header: 'Behind', render: (x) => (x.behind ? 'Behind' : 'No') },
              ]}
            />
          ))}
        </>
      ) : null}
      <CommandTimes />
    </>
  );
}

/**
 * AI use register (AIG-01, AIG-06, AIG-08; ADR-0043): every AI feature, its provider and its
 * human checkpoint; an administrator evaluates the configured provider (OpenAI) for the
 * organization's languages and then switches features on or off, each with a reason.
 */
export function AiRegisterScreen() {
  const { rows, error, reload } = useList<RegisterEntry>('/ai-register');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const evalText = (e: unknown) => {
    const r = e as {
      accuracy?: Record<string, number>;
      injectionResistance?: number;
      passed?: boolean;
      evaluatedAt?: string;
    } | null;
    if (!r?.accuracy) return 'Not evaluated';
    const langs = Object.entries(r.accuracy)
      .map(([l, a]) => `${l} ${Math.round(a * 100)}%`)
      .join(', ');
    return `${langs}; injection blocked ${Math.round((r.injectionResistance ?? 0) * 100)}%${r.passed ? '' : ' (not passed)'}${r.evaluatedAt ? `, ${fmt(r.evaluatedAt)}` : ''}`;
  };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: done });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  return (
    <section aria-labelledby="ai-h">
      <h1 id="ai-h">AI use register</h1>
      <p>
        Every AI feature, what it sends, what it informs, who checks it and whether it is on for
        this organization (AIG-01). Features run on OpenAI and start switched off: an administrator
        evaluates the provider for this organization&rsquo;s languages first, then switches each
        feature on with a reason. People decide everything a feature suggests, and every feature has
        a manual path.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      <Toolbar>
        <button
          type="button"
          onClick={() =>
            void run(
              () => api('/ai-register/evaluate', { method: 'POST' }),
              'The evaluation is running. The results appear here in a few minutes.',
            )
          }
        >
          Evaluate the configured provider…
        </button>
      </Toolbar>
      <DataTable
        caption="AI features"
        rows={rows ?? []}
        rowKey={(r) => r.id}
        columns={[
          { key: 'feature', header: 'Feature', render: (r) => r.feature },
          { key: 'on', header: 'On', render: (r) => (r.enabled ? 'yes' : 'no') },
          {
            key: 'provider',
            header: 'Provider / model',
            render: (r) =>
              `${r.provider} / ${r.model}${r.modelVersion ? ` ${r.modelVersion}` : ''}`,
          },
          { key: 'data', header: 'Data sent', render: (r) => r.dataSent },
          { key: 'decision', header: 'Informs', render: (r) => r.decisionInformed },
          { key: 'human', header: 'Human checkpoint', render: (r) => r.humanCheckpoint },
          { key: 'owner', header: 'Owner', render: (r) => r.owner },
          {
            key: 'compliance',
            header: 'US / no retention / no training',
            render: (r) =>
              [r.usRegion, r.zeroRetention, r.noTraining]
                .map((b) => (b ? 'yes' : 'no'))
                .join(' / '),
          },
          { key: 'eval', header: 'Evaluation', render: (r) => evalText(r.evaluation) },
          { key: 'updated', header: 'Updated', render: (r) => fmt(r.updatedAt) },
          {
            key: 'act',
            header: 'Change',
            render: (r) => (
              <button
                type="button"
                aria-label={`${r.enabled ? 'Switch off' : 'Switch on'} ${r.feature}…`}
                onClick={() =>
                  void run(
                    () =>
                      api(`/ai-register/${r.feature}`, {
                        method: 'PATCH',
                        body: { enabled: !r.enabled },
                        version: r.version,
                      }),
                    `${r.feature} switched ${r.enabled ? 'off' : 'on'}.`,
                  )
                }
              >
                {r.enabled ? 'Switch off…' : 'Switch on…'}
              </button>
            ),
          },
        ]}
      />
      <AiHealth onChanged={(text, kind) => setMsg({ kind, text })} />
    </section>
  );
}

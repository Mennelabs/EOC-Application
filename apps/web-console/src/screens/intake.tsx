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

export function AiRegisterScreen() {
  const { rows, error } = useList<RegisterEntry>('/ai-register');
  const evalText = (e: unknown) => {
    const r = e as {
      languages?: Record<string, { accuracy?: number; injectionResistance?: number }>;
      passed?: boolean;
    } | null;
    if (!r?.languages) return '—';
    return (
      Object.entries(r.languages)
        .map(([l, v]) => `${l}: ${v.accuracy !== undefined ? Math.round(v.accuracy * 100) : '?'}%`)
        .join(', ') + (r.passed === false ? ' (not passed)' : '')
    );
  };
  return (
    <section aria-labelledby="ai-h">
      <h1 id="ai-h">AI use register</h1>
      <p>
        Every AI feature, what it sends, what it informs, who checks it and whether it is on for
        this organization (AIG-01). The severity suggestion stays off until a validated model exists
        (PHO-12). Changes are made by administrators with a reason.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
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
        ]}
      />
    </section>
  );
}

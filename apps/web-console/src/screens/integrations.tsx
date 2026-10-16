/**
 * API keys and webhooks (layer-6 task H; SCL-09, ADM-05, WCAG 2.2 AA): the
 * county's connections to systems outside. An administrator asks for a key
 * or a webhook and sees its key or signing secret once; a second
 * administrator approves or declines it (never the one who asked). Keys
 * read the PDA feature service; webhooks hear "report issued" and "export
 * ready". Every change is confirmed with a reason and audited. Tables
 * first; the key and secret are never shown again.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

interface Key {
  id: string;
  version: number;
  name: string;
  prefix: string;
  scopes: string[];
  status: 'pending' | 'active' | 'declined' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
  createdBy: string | null;
  askedByYou: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

interface Hook {
  id: string;
  version: number;
  name: string;
  url: string;
  events: string[];
  status: 'pending' | 'active' | 'declined' | 'disabled';
  createdBy: string | null;
  askedByYou: boolean;
  decidedBy: string | null;
  deliveries: { pending: number; delivered: number; failed: number };
}

interface Delivery {
  id: string;
  event: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

const SCOPES: Record<string, string> = {
  'pda.read': 'Read the PDA feature layer (damage points, no personal details)',
};
const EVENTS: Record<string, string> = {
  'official_report.issued': 'An official report is issued',
  'export.ready': 'An export (IDA package or report file) is ready',
};
const KEY_STATUS: Record<Key['status'], string> = {
  pending: 'Waiting for a second administrator',
  active: 'Active',
  declined: 'Declined',
  revoked: 'Revoked',
  expired: 'Expired',
};
const HOOK_STATUS: Record<Hook['status'], string> = {
  pending: 'Waiting for a second administrator',
  active: 'Active',
  declined: 'Declined',
  disabled: 'Disabled',
};

export function IntegrationsScreen() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState<{
    kind: 'key' | 'secret';
    name: string;
    value: string;
  } | null>(null);
  const [deliveriesOf, setDeliveriesOf] = useState<Hook | null>(null);

  useEffect(() => {
    let live = true;
    api<{ actions: string[]; tenantId: string }>('/me')
      .then(async (me) => {
        if (!live) return;
        setActions(me.actions);
        setTenantId(me.tenantId);
        const t = await api<{ slug: string }>(`/tenants/${me.tenantId}`).catch(() => null);
        if (live && t) setSlug(t.slug);
      })
      .catch((err: unknown) => live && setError(describeFailure(err)));
    return () => {
      live = false;
    };
  }, []);
  const can = (a: string) => actions?.includes(a) ?? false;

  const load = useCallback(() => {
    if (!actions) return;
    if (actions.includes('api_key.read'))
      api<{ keys: Key[] }>('/api-keys')
        .then((r) => setKeys(r.keys))
        .catch((err: unknown) => setError(describeFailure(err)));
    if (actions.includes('webhook.read'))
      api<{ webhooks: Hook[] }>('/webhooks')
        .then((r) => setHooks(r.webhooks))
        .catch((err: unknown) => setError(describeFailure(err)));
  }, [actions]);
  useEffect(load, [load]);

  const act = async (path: string, version: number, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await api(path, { method: 'POST', version });
      setNotice(done);
      load();
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 403)
        setError(
          'Someone other than the administrator who asked approves or declines it, and only an administrator with this permission.',
        );
      else setError(describeFailure(err));
    }
  };

  const service = `${window.location.origin}/api/gis/${slug ?? 'your-county'}/pda/FeatureServer`;

  return (
    <section aria-labelledby="int-h">
      <h1 id="int-h">API keys and webhooks</h1>
      <p>
        Connections to systems outside: keys that read the county&apos;s PDA feature layer, and
        webhooks that are told when a report is issued or an export is ready. Each one works only
        after a second administrator approves it. A key or a signing secret is shown once, when it
        is made; keep it somewhere safe.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {notice ? <Status kind="success">{notice}</Status> : null}
      {actions && !can('api_key.read') && !can('webhook.read') ? (
        <p>You do not have access to the county&apos;s API keys or webhooks.</p>
      ) : null}

      {shown ? (
        <section aria-labelledby="int-once" className="panel">
          <h2 id="int-once">
            {shown.kind === 'key' ? 'Your new API key' : 'Your webhook signing secret'}:{' '}
            {shown.name}
          </h2>
          <Status kind="info">
            This is the only time it is shown. Copy it now; it cannot be shown again.
          </Status>
          <Field
            label={shown.kind === 'key' ? 'API key' : 'Signing secret'}
            hint={
              shown.kind === 'key'
                ? `Send it as the X-API-Key header, or as the token parameter in a GIS client. It works once a second administrator approves it. Feature service: ${service}`
                : 'The receiver checks each delivery with it (Standard Webhooks: webhook-id, webhook-timestamp and webhook-signature headers). Deliveries start once a second administrator approves the webhook.'
            }
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                readOnly
                value={shown.value}
                aria-describedby={describedBy}
                onFocus={(e) => e.target.select()}
              />
            )}
          </Field>
          <div className="toolbar">
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(shown.value)
                  .then(() => setNotice('Copied.'))
                  .catch(() => setNotice('Select the text and copy it.'))
              }
            >
              Copy
            </button>
            <button type="button" onClick={() => setShown(null)}>
              I have stored it
            </button>
          </div>
        </section>
      ) : null}

      {can('api_key.read') ? (
        <section aria-labelledby="int-keys">
          <h2 id="int-keys">API keys</h2>
          <p>
            Feature service for ArcGIS, QGIS and other GIS clients: <code>{service}</code>. It
            answers the GeoServices query subset (where 1=1 or Field = &apos;value&apos;, Esri JSON
            or GeoJSON) for the active event.
          </p>
          {keys === null ? <p role="status">Loading keys…</p> : null}
          {keys ? (
            <DataTable
              caption="API keys"
              rows={keys}
              rowKey={(k) => k.id}
              empty="No API keys yet."
              columns={[
                { key: 'name', header: 'Name', render: (k) => k.name },
                {
                  key: 'prefix',
                  header: 'Starts with',
                  render: (k) => <code>cgk_{k.prefix}</code>,
                },
                {
                  key: 'scopes',
                  header: 'May',
                  render: (k) => k.scopes.map((s) => SCOPES[s] ?? s).join('; '),
                },
                { key: 'status', header: 'Status', render: (k) => KEY_STATUS[k.status] },
                { key: 'expires', header: 'Expires', render: (k) => fmt(k.expiresAt) },
                {
                  key: 'who',
                  header: 'Asked and decided by',
                  render: (k) =>
                    `${k.askedByYou ? 'You' : (k.createdBy ?? 'Unknown')}${k.decidedBy ? `; ${k.decidedBy}` : ''}`,
                },
                {
                  key: 'used',
                  header: 'Last used',
                  render: (k) => (k.lastUsedAt ? fmt(k.lastUsedAt) : 'Never'),
                },
                {
                  key: 'act',
                  header: 'Actions',
                  render: (k) =>
                    can('api_key.manage') ? (
                      <div className="toolbar">
                        {k.status === 'pending' && !k.askedByYou ? (
                          <>
                            <button
                              type="button"
                              aria-label={`Approve ${k.name}`}
                              onClick={() =>
                                void act(
                                  `/api-keys/${k.id}/approve`,
                                  k.version,
                                  `The key ${k.name} is approved.`,
                                )
                              }
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              aria-label={`Decline ${k.name}`}
                              onClick={() =>
                                void act(
                                  `/api-keys/${k.id}/decline`,
                                  k.version,
                                  `The key ${k.name} is declined.`,
                                )
                              }
                            >
                              Decline
                            </button>
                          </>
                        ) : null}
                        {k.status === 'pending' || k.status === 'active' ? (
                          <button
                            type="button"
                            aria-label={`Revoke ${k.name}`}
                            onClick={() =>
                              void act(
                                `/api-keys/${k.id}/revoke`,
                                k.version,
                                `The key ${k.name} is revoked.`,
                              )
                            }
                          >
                            Revoke
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
          {can('api_key.manage') ? (
            <AskForKey
              onMade={(name, value) => {
                setShown({ kind: 'key', name, value });
                setNotice(null);
                load();
              }}
              onFail={(err) => setError(describeFailure(err))}
            />
          ) : null}
        </section>
      ) : null}

      {can('webhook.read') ? (
        <section aria-labelledby="int-hooks">
          <h2 id="int-hooks">Webhooks</h2>
          <p>
            A webhook is an HTTPS address that is sent a signed message when something happens.
            Messages name the report or export, never a person. A failed delivery is tried again for
            about a day.
          </p>
          {hooks === null ? <p role="status">Loading webhooks…</p> : null}
          {hooks ? (
            <DataTable
              caption="Webhooks"
              rows={hooks}
              rowKey={(h) => h.id}
              empty="No webhooks yet."
              columns={[
                { key: 'name', header: 'Name', render: (h) => h.name },
                { key: 'url', header: 'Address', render: (h) => <code>{h.url}</code> },
                {
                  key: 'events',
                  header: 'Told when',
                  render: (h) => h.events.map((e) => EVENTS[e] ?? e).join('; '),
                },
                { key: 'status', header: 'Status', render: (h) => HOOK_STATUS[h.status] },
                {
                  key: 'deliveries',
                  header: 'Deliveries',
                  render: (h) =>
                    `${h.deliveries.delivered} delivered, ${h.deliveries.pending} waiting, ${h.deliveries.failed} failed`,
                },
                {
                  key: 'act',
                  header: 'Actions',
                  render: (h) => (
                    <div className="toolbar">
                      <button
                        type="button"
                        aria-label={`Deliveries to ${h.name}`}
                        onClick={() => setDeliveriesOf(h)}
                      >
                        Deliveries
                      </button>
                      {can('webhook.manage') && h.status === 'pending' && !h.askedByYou ? (
                        <>
                          <button
                            type="button"
                            aria-label={`Approve ${h.name}`}
                            onClick={() =>
                              void act(
                                `/webhooks/${h.id}/approve`,
                                h.version,
                                `The webhook ${h.name} is approved.`,
                              )
                            }
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            aria-label={`Decline ${h.name}`}
                            onClick={() =>
                              void act(
                                `/webhooks/${h.id}/decline`,
                                h.version,
                                `The webhook ${h.name} is declined.`,
                              )
                            }
                          >
                            Decline
                          </button>
                        </>
                      ) : null}
                      {can('webhook.manage') &&
                      (h.status === 'pending' || h.status === 'active') ? (
                        <button
                          type="button"
                          aria-label={`Disable ${h.name}`}
                          onClick={() =>
                            void act(
                              `/webhooks/${h.id}/disable`,
                              h.version,
                              `The webhook ${h.name} is disabled.`,
                            )
                          }
                        >
                          Disable
                        </button>
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
          ) : null}
          {deliveriesOf ? (
            <Deliveries hook={deliveriesOf} onClose={() => setDeliveriesOf(null)} />
          ) : null}
          {can('webhook.manage') ? (
            <AddWebhook
              onMade={(name, value) => {
                setShown({ kind: 'secret', name, value });
                setNotice(null);
                load();
              }}
              onFail={(err) => setError(describeFailure(err))}
            />
          ) : null}
        </section>
      ) : null}
      {tenantId && can('tenant.config.read') ? (
        <WazeFeed tenantId={tenantId} mayChange={can('tenant.config.write')} />
      ) : null}
    </section>
  );
}

function AskForKey({
  onMade,
  onFail,
}: {
  onMade: (name: string, key: string) => void;
  onFail: (err: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [scopes, setScopes] = useState<string[]>(['pda.read']);
  const [problems, setProblems] = useState<{ name?: string; scopes?: string }>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = {
      ...(name.trim() ? {} : { name: 'Name what the key is for.' }),
      ...(scopes.length ? {} : { scopes: 'Choose what the key may do.' }),
    };
    setProblems(found);
    if (Object.keys(found).length) return;
    try {
      const made = await api<Key & { key: string }>('/api-keys', {
        body: { name: name.trim(), scopes, expiresInDays: Number(days) },
      });
      setName('');
      onMade(made.name, made.key);
    } catch (err) {
      onFail(err);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="form-grid" aria-labelledby="int-ask">
      <h3 id="int-ask">Ask for an API key</h3>
      <Field
        label="What it is for"
        hint="For example: State GIS desk."
        {...(problems.name ? { error: problems.name } : {})}
      >
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            value={name}
            maxLength={120}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label="Expires after">
        {({ id }) => (
          <select id={id} value={days} onChange={(e) => setDays(e.target.value)}>
            {[
              ['30', '30 days'],
              ['90', '90 days'],
              ['180', '180 days'],
              ['365', 'One year (the longest)'],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        )}
      </Field>
      <fieldset aria-describedby={problems.scopes ? 'int-scopes-err' : undefined}>
        <legend>It may</legend>
        {Object.entries(SCOPES).map(([k, l]) => (
          <label key={k} className="inline">
            <input
              type="checkbox"
              checked={scopes.includes(k)}
              onChange={(e) =>
                setScopes(e.target.checked ? [...scopes, k] : scopes.filter((x) => x !== k))
              }
            />{' '}
            {l}
          </label>
        ))}
        {problems.scopes ? (
          <p id="int-scopes-err" className="error" role="alert">
            {problems.scopes}
          </p>
        ) : null}
      </fieldset>
      <div className="toolbar">
        <button type="submit" className="primary">
          Ask for the key
        </button>
      </div>
    </form>
  );
}

function AddWebhook({
  onMade,
  onFail,
}: {
  onMade: (name: string, secret: string) => void;
  onFail: (err: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['official_report.issued']);
  const [problems, setProblems] = useState<{ name?: string; url?: string; events?: string }>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = {
      ...(name.trim() ? {} : { name: 'Name the receiver.' }),
      ...(/^https:\/\/[^\s/]+\.[^\s]+$/.test(url.trim())
        ? {}
        : { url: 'Enter a full address starting with https://.' }),
      ...(events.length ? {} : { events: 'Choose at least one event.' }),
    };
    setProblems(found);
    if (Object.keys(found).length) return;
    try {
      const made = await api<Hook & { secret: string }>('/webhooks', {
        body: { name: name.trim(), url: url.trim(), events },
      });
      setName('');
      setUrl('');
      onMade(made.name, made.secret);
    } catch (err) {
      if (err instanceof ApiFailure && err.envelope.fields?.length) {
        const f = err.envelope.fields.find((x) => x.name === 'url');
        if (f) {
          setProblems({ url: f.message });
          return;
        }
      }
      onFail(err);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="form-grid" aria-labelledby="int-add">
      <h3 id="int-add">Add a webhook</h3>
      <Field
        label="Receiver"
        hint="For example: State EOC situation desk."
        {...(problems.name ? { error: problems.name } : {})}
      >
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            value={name}
            maxLength={120}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Address"
        hint="HTTPS only, a host name (not an IP address), on port 443 or 8443."
        {...(problems.url ? { error: problems.url } : {})}
      >
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            type="url"
            inputMode="url"
            value={url}
            maxLength={500}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      <fieldset aria-describedby={problems.events ? 'int-events-err' : undefined}>
        <legend>Tell it when</legend>
        {Object.entries(EVENTS).map(([k, l]) => (
          <label key={k} className="inline">
            <input
              type="checkbox"
              checked={events.includes(k)}
              onChange={(e) =>
                setEvents(e.target.checked ? [...events, k] : events.filter((x) => x !== k))
              }
            />{' '}
            {l}
          </label>
        ))}
        {problems.events ? (
          <p id="int-events-err" className="error" role="alert">
            {problems.events}
          </p>
        ) : null}
      </fieldset>
      <div className="toolbar">
        <button type="submit" className="primary">
          Add the webhook
        </button>
      </div>
    </form>
  );
}

function Deliveries({ hook, onClose }: { hook: Hook; onClose: () => void }) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ deliveries: Delivery[] }>(`/webhooks/${hook.id}/deliveries`)
      .then((r) => live && setRows(r.deliveries))
      .catch((err: unknown) => live && setError(describeFailure(err)));
    return () => {
      live = false;
    };
  }, [hook.id]);
  return (
    <section aria-labelledby="int-dlv">
      <h3 id="int-dlv">Deliveries to {hook.name}</h3>
      {error ? <Status kind="error">{error}</Status> : null}
      {rows === null && !error ? <p role="status">Loading deliveries…</p> : null}
      {rows ? (
        <DataTable
          caption={`Last 50 deliveries to ${hook.name}`}
          rows={rows}
          rowKey={(d) => d.id}
          empty="Nothing has been sent yet."
          columns={[
            { key: 'event', header: 'Event', render: (d) => EVENTS[d.event] ?? d.event },
            { key: 'at', header: 'Queued', render: (d) => fmt(d.createdAt) },
            {
              key: 'status',
              header: 'Status',
              render: (d) =>
                d.status === 'delivered'
                  ? 'Delivered'
                  : d.status === 'failed'
                    ? 'Failed'
                    : `Waiting; next try ${fmt(d.nextAttemptAt)}`,
            },
            { key: 'tries', header: 'Attempts', render: (d) => String(d.attempts) },
            {
              key: 'last',
              header: 'Last answer',
              render: (d) => d.lastError ?? (d.lastStatus ? `HTTP ${d.lastStatus}` : '—'),
            },
          ]}
        />
      ) : null}
      <div className="toolbar">
        <button type="button" onClick={onClose}>
          Close the deliveries
        </button>
      </div>
    </section>
  );
}

interface WazeView {
  enabled: boolean;
  feedPath: string;
  included: { street: string; type: string; since: string }[];
  leftOut: { name: string; reason: string }[];
}

/**
 * FL:FR-05, Q-04: the Waze for Cities road closure feed. Off until the county has enrolled with
 * Waze; then Waze reads the address shown here. What is in it and what is left out, in words.
 */
function WazeFeed({ tenantId, mayChange }: { tenantId: string; mayChange: boolean }) {
  const [view, setView] = useState<WazeView | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<WazeView>('/integrations/waze')
      .then((v) => live && setView(v))
      .catch((err: unknown) => live && setMessage({ kind: 'error', text: describeFailure(err) }));
    api<{ version: number }>(`/tenants/${tenantId}/config/waze.feed_enabled`)
      .then((c) => live && setVersion(c.version))
      .catch(() => live && setVersion(null));
    return () => {
      live = false;
    };
  }, [tenantId, tick]);
  const toggle = async () => {
    if (!view) return;
    setMessage(null);
    try {
      await api(`/tenants/${tenantId}/config/waze.feed_enabled`, {
        method: 'PUT',
        body: { value: !view.enabled },
        ...(version !== null ? { version } : {}),
      });
      setMessage({
        kind: 'success',
        text: view.enabled ? 'The Waze feed is switched off.' : 'The Waze feed is switched on.',
      });
      setTick((n) => n + 1);
    } catch (err) {
      setMessage({ kind: 'error', text: describeFailure(err) });
    }
  };
  return (
    <section aria-labelledby="waze-h">
      <h2 id="waze-h">Waze for Cities road closure feed</h2>
      <p>
        Waze reads the county&rsquo;s road closures from this address once the county has enrolled
        in Waze for Cities. It lists the roads reported closed, impassable or down to one lane in
        open events, until they are cleared. It holds nothing about any person.
      </p>
      {message ? <Status kind={message.kind}>{message.text}</Status> : null}
      {view ? (
        <>
          <p role="status">
            The feed is <strong>{view.enabled ? 'on' : 'off'}</strong>. Address to give Waze:{' '}
            <code>{`${window.location.origin}${view.feedPath}`}</code>
          </p>
          {mayChange ? (
            <button type="button" onClick={() => void toggle()}>
              {view.enabled ? 'Switch the Waze feed off' : 'Switch the Waze feed on'}
            </button>
          ) : null}
          <DataTable
            caption="Roads in the feed now"
            rows={view.included}
            rowKey={(r) => `${r.street}-${r.since}`}
            empty="No road is closed now."
            columns={[
              { key: 'street', header: 'Road', render: (r) => r.street },
              { key: 'type', header: 'What Waze shows', render: (r) => r.type },
              { key: 'since', header: 'Since', render: (r) => fmt(r.since) },
            ]}
          />
          {view.leftOut.length ? (
            <DataTable
              caption="Roads left out of the feed"
              rows={view.leftOut}
              rowKey={(r) => r.name}
              columns={[
                { key: 'name', header: 'Road', render: (r) => r.name },
                { key: 'why', header: 'Why', render: (r) => r.reason },
              ]}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Single sign-on (SEC-07, ADM-05, WCAG 2.2 AA): staff sign in with the
 * county's own account (SAML or OpenID Connect). The screen gives what the
 * county's identity provider needs from us, shows the provider in force and
 * one waiting for approval, and lets an administrator propose a provider. A
 * second administrator approves or declines it (never the one who proposed
 * it); either may switch it off. The county's sign-in replaces the password;
 * each person's passkey is still asked for, and only invited people get in.
 * Every change is confirmed with a reason and audited. A client secret is
 * entered once and never shown again.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

interface Sso {
  id: string;
  version: number;
  protocol: 'saml' | 'oidc';
  displayName: string;
  idpEntityId: string | null;
  oidc: { issuer: string; clientId: string } | null;
  status: 'proposed' | 'active' | 'declined' | 'replaced' | 'disabled';
  reason: string;
  createdAt: string;
  createdBy: string | null;
  askedByYou: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  disabledAt: string | null;
  appliedAt: string | null;
  applyError: string | null;
}

interface State {
  serviceProvider: { entityId: string; redirectUri: string; metadataUrl: string };
  active: Sso | null;
  proposed: Sso | null;
  history: Sso[];
}

const PROTOCOL: Record<Sso['protocol'], string> = {
  saml: 'SAML 2.0',
  oidc: 'OpenID Connect',
};
const STATUS: Record<Sso['status'], string> = {
  proposed: 'Waiting for a second administrator',
  active: 'In force',
  declined: 'Declined',
  replaced: 'Replaced by a newer one',
  disabled: 'Switched off',
};

export function SsoScreen() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setActions(me.actions))
      .catch((err: unknown) => live && setError(describeFailure(err)));
    return () => {
      live = false;
    };
  }, []);
  const can = (a: string) => actions?.includes(a) ?? false;

  const load = useCallback(() => {
    if (!actions?.includes('sso.read')) return;
    api<State>('/sso')
      .then(setState)
      .catch((err: unknown) => setError(describeFailure(err)));
  }, [actions]);
  useEffect(load, [load]);

  const act = async (s: Sso, op: 'approve' | 'decline' | 'disable', done: string) => {
    setError(null);
    setNotice(null);
    try {
      await api(`/sso/${s.id}/${op}`, { method: 'POST', version: s.version });
      setNotice(done);
      load();
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 403)
        setError(
          'Someone other than the administrator who proposed it approves or declines it, and only an administrator with this permission.',
        );
      else setError(describeFailure(err));
    }
  };

  return (
    <section aria-labelledby="sso-h">
      <h1 id="sso-h">Single sign-on</h1>
      <p>
        Staff can sign in with the county&apos;s own account, through its identity provider (any
        SAML 2.0 or OpenID Connect provider). The county&apos;s sign-in replaces the password; each
        person&apos;s passkey is still asked for. Only people the county has invited here can sign
        in this way: someone with a county account but no invitation is refused. A second
        administrator approves every change.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {notice ? <Status kind="success">{notice}</Status> : null}
      {actions && !can('sso.read') ? (
        <p>You do not have access to the county&apos;s sign-in settings.</p>
      ) : null}
      {can('sso.read') && state === null && !error ? (
        <p role="status">Loading the sign-in settings…</p>
      ) : null}

      {state ? (
        <>
          <section aria-labelledby="sso-sp" className="panel">
            <h2 id="sso-sp">Give these to your identity provider</h2>
            <dl className="meta">
              <dt>Entity ID (audience)</dt>
              <dd>
                <code>{state.serviceProvider.entityId}</code>
              </dd>
              <dt>
                Reply address (SAML assertion consumer service, or OpenID Connect redirect URI)
              </dt>
              <dd>
                <code>{state.serviceProvider.redirectUri}</code>
              </dd>
              <dt>Our SAML metadata, once a SAML provider is in force</dt>
              <dd>
                <code>{state.serviceProvider.metadataUrl}</code>
              </dd>
              <dt>Name ID or claim to send</dt>
              <dd>The person&apos;s work email address, the one they were invited with.</dd>
            </dl>
          </section>

          <section aria-labelledby="sso-active">
            <h2 id="sso-active">In force</h2>
            {state.active ? (
              <>
                <Summary s={state.active} />
                <p role="status">
                  {state.active.applyError
                    ? `Not yet in force on the sign-in page: ${state.active.applyError}. It is tried again.`
                    : state.active.appliedAt
                      ? `On the sign-in page since ${fmt(state.active.appliedAt)}.`
                      : 'Being put on the sign-in page.'}
                </p>
                {can('sso.manage') ? (
                  <button
                    type="button"
                    onClick={() =>
                      void act(
                        state.active!,
                        'disable',
                        'Single sign-on is switched off. Staff sign in with their password and passkey.',
                      )
                    }
                  >
                    Switch off single sign-on
                  </button>
                ) : null}
              </>
            ) : (
              <p>No provider is in force. Staff sign in with their password and passkey.</p>
            )}
          </section>

          {state.proposed ? (
            <section aria-labelledby="sso-proposed">
              <h2 id="sso-proposed">Waiting for approval</h2>
              <Summary s={state.proposed} />
              {state.proposed.askedByYou ? (
                <p>You proposed it, so another administrator approves or declines it.</p>
              ) : can('sso.manage') ? (
                <div className="toolbar">
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void act(
                        state.proposed!,
                        'approve',
                        `${state.proposed!.displayName} is approved and is being put on the sign-in page.`,
                      )
                    }
                  >
                    Approve single sign-on
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void act(
                        state.proposed!,
                        'decline',
                        `${state.proposed!.displayName} is declined.`,
                      )
                    }
                  >
                    Decline
                  </button>
                </div>
              ) : null}
            </section>
          ) : can('sso.manage') ? (
            <Propose
              onMade={(name) => {
                setError(null);
                setNotice(`${name} is proposed. A second administrator approves it.`);
                load();
              }}
              onFail={(err) => setError(describeFailure(err))}
            />
          ) : null}

          {state.history.length ? (
            <section aria-labelledby="sso-history">
              <h2 id="sso-history">Earlier settings</h2>
              <DataTable
                caption="Earlier single sign-on settings"
                rows={state.history}
                rowKey={(s) => s.id}
                columns={[
                  { key: 'name', header: 'Sign-in button', render: (s) => s.displayName },
                  { key: 'protocol', header: 'Kind', render: (s) => PROTOCOL[s.protocol] },
                  { key: 'idp', header: 'Identity provider', render: (s) => s.idpEntityId ?? '' },
                  { key: 'status', header: 'Status', render: (s) => STATUS[s.status] },
                  { key: 'by', header: 'Proposed by', render: (s) => s.createdBy ?? '' },
                  { key: 'decided', header: 'Decided by', render: (s) => s.decidedBy ?? '' },
                ]}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function Summary({ s }: { s: Sso }) {
  return (
    <dl className="meta">
      <dt>Sign-in button</dt>
      <dd>{s.displayName}</dd>
      <dt>Kind</dt>
      <dd>{PROTOCOL[s.protocol]}</dd>
      <dt>Identity provider</dt>
      <dd>
        <code>{s.idpEntityId}</code>
      </dd>
      {s.oidc ? (
        <>
          <dt>Client ID</dt>
          <dd>
            <code>{s.oidc.clientId}</code>
          </dd>
        </>
      ) : null}
      <dt>Status</dt>
      <dd>{STATUS[s.status]}</dd>
      <dt>Proposed by</dt>
      <dd>
        {s.createdBy ?? 'Unknown'} on {fmt(s.createdAt)}: {s.reason}
      </dd>
      {s.decidedBy ? (
        <>
          <dt>Decided by</dt>
          <dd>
            {s.decidedBy}
            {s.decidedAt ? ` on ${fmt(s.decidedAt)}` : ''}
            {s.decisionReason ? `: ${s.decisionReason}` : ''}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

type Problems = Partial<
  Record<
    | 'displayName'
    | 'metadata'
    | 'issuer'
    | 'authorizationUrl'
    | 'tokenUrl'
    | 'jwksUrl'
    | 'clientId'
    | 'clientSecret',
    string
  >
>;

const OIDC_FIELDS = [
  ['issuer', 'Issuer', 'From the provider’s discovery document (issuer).'],
  ['authorizationUrl', 'Authorization address', 'authorization_endpoint'],
  ['tokenUrl', 'Token address', 'token_endpoint'],
  ['jwksUrl', 'Signing keys address', 'jwks_uri'],
] as const;

function Propose({
  onMade,
  onFail,
}: {
  onMade: (name: string) => void;
  onFail: (err: unknown) => void;
}) {
  const [protocol, setProtocol] = useState<'saml' | 'oidc'>('saml');
  const [displayName, setDisplayName] = useState('');
  const [metadata, setMetadata] = useState('');
  const [oidc, setOidc] = useState({
    issuer: '',
    authorizationUrl: '',
    tokenUrl: '',
    jwksUrl: '',
    clientId: '',
    clientSecret: '',
  });
  const [problems, setProblems] = useState<Problems>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const https = (v: string) => /^https:\/\/\S+$/.test(v.trim());
    const found: Problems = {
      ...(displayName.trim().length >= 2
        ? {}
        : { displayName: 'Name the sign-in button, for example "Westwind County account".' }),
      ...(protocol === 'saml'
        ? metadata.trim().length >= 100
          ? {}
          : { metadata: 'Paste the identity provider’s SAML metadata (XML).' }
        : {
            ...Object.fromEntries(
              OIDC_FIELDS.filter(([k]) => !https(oidc[k])).map(([k]) => [
                k,
                'Enter a full address starting with https://.',
              ]),
            ),
            ...(oidc.clientId.trim() ? {} : { clientId: 'Enter the client ID.' }),
            ...(oidc.clientSecret ? {} : { clientSecret: 'Enter the client secret.' }),
          }),
    };
    setProblems(found);
    if (Object.keys(found).length) return;
    try {
      const made = await api<Sso>('/sso', {
        body:
          protocol === 'saml'
            ? { protocol, displayName: displayName.trim(), metadata: metadata.trim() }
            : {
                protocol,
                displayName: displayName.trim(),
                issuer: oidc.issuer.trim(),
                authorizationUrl: oidc.authorizationUrl.trim(),
                tokenUrl: oidc.tokenUrl.trim(),
                jwksUrl: oidc.jwksUrl.trim(),
                clientId: oidc.clientId.trim(),
                clientSecret: oidc.clientSecret,
              },
      });
      setMetadata('');
      setOidc((o) => ({ ...o, clientSecret: '' }));
      onMade(made.displayName);
    } catch (err) {
      if (err instanceof ApiFailure && err.envelope.fields?.length) {
        setProblems(
          Object.fromEntries(err.envelope.fields.map((f) => [f.name, f.message])) as Problems,
        );
        return;
      }
      onFail(err);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="form-grid" aria-labelledby="sso-propose">
      <h2 id="sso-propose">Propose a provider</h2>
      <fieldset>
        <legend>Kind of identity provider</legend>
        {(['saml', 'oidc'] as const).map((p) => (
          <label key={p} className="inline">
            <input
              type="radio"
              name="sso-protocol"
              checked={protocol === p}
              onChange={() => setProtocol(p)}
            />{' '}
            {PROTOCOL[p]}
          </label>
        ))}
      </fieldset>
      <Field
        label="Sign-in button"
        hint="What staff see on the sign-in page, for example: Westwind County account."
        {...(problems.displayName ? { error: problems.displayName } : {})}
      >
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            value={displayName}
            maxLength={80}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        )}
      </Field>
      {protocol === 'saml' ? (
        <Field
          label="Identity provider metadata (XML)"
          hint="Download it from your identity provider (federation metadata) and paste it here. It must not contain a document type declaration."
          {...(problems.metadata ? { error: problems.metadata } : {})}
        >
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              rows={8}
              value={metadata}
              spellCheck={false}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => setMetadata(e.target.value)}
            />
          )}
        </Field>
      ) : (
        <>
          {OIDC_FIELDS.map(([k, label, hint]) => (
            <Field
              key={k}
              label={label}
              hint={hint}
              {...(problems[k] ? { error: problems[k] } : {})}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  type="url"
                  inputMode="url"
                  value={oidc[k]}
                  maxLength={500}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(e) => setOidc((o) => ({ ...o, [k]: e.target.value }))}
                />
              )}
            </Field>
          ))}
          <Field label="Client ID" {...(problems.clientId ? { error: problems.clientId } : {})}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                value={oidc.clientId}
                maxLength={255}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => setOidc((o) => ({ ...o, clientId: e.target.value }))}
              />
            )}
          </Field>
          <Field
            label="Client secret"
            hint="Kept encrypted; it is never shown again."
            {...(problems.clientSecret ? { error: problems.clientSecret } : {})}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="password"
                autoComplete="off"
                value={oidc.clientSecret}
                maxLength={500}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => setOidc((o) => ({ ...o, clientSecret: e.target.value }))}
              />
            )}
          </Field>
        </>
      )}
      <div className="toolbar">
        <button type="submit" className="primary">
          Propose single sign-on
        </button>
      </div>
    </form>
  );
}

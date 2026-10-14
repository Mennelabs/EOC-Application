/**
 * Enclave accounts and approvals (SEC-12, ADM-05, layer-5 plan §4). The
 * agency administrator creates accounts, records fingerprint-check and
 * training dates (status and dates only) and asks for roles; a second
 * administrator approves; activation shows the one-time password once, to be
 * handed over in person. Nobody administers their own account.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure, missingLabel } from '../api/client.ts';
import { DataTable, fmt, Input, label, Status } from '../ui/primitives.tsx';

interface Account {
  id: string;
  email: string;
  displayName: string;
  status: string;
  fingerprintStatus: string;
  fingerprintAdjudicatedOn: string | null;
  trainingCompletedOn: string | null;
  trainingExpiresOn: string | null;
  identityState: string;
  lastSeenAt: string | null;
  roles: string[];
  qualified: boolean;
  missing: string[];
  version: number;
}

interface RoleRequest {
  id: string;
  personId: string;
  role: string;
  change: string;
  status: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  version: number;
}

const ROLES = [
  'officer',
  'supervisor',
  'records_clerk',
  'agency_admin',
  'security_officer',
  'auditor',
].map((r) => [r, label(r)] as const);

export function AccountsScreen({ me }: { me: { personId: string } }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handover, setHandover] = useState<{ name: string; password: string } | null>(null);
  const load = useCallback(() => {
    api<Account[]>('/accounts')
      .then(setAccounts)
      .catch((e: unknown) => setError(describeFailure(e)));
  }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      load();
    } catch (e) {
      setError(describeFailure(e));
    }
  };
  const current = accounts.find((a) => a.id === selected) ?? null;
  return (
    <>
      <h1>Accounts and screening</h1>
      {notice ? <Status kind="success">{notice}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {handover ? (
        <div className="handover" role="alert">
          <h2>One-time password for {handover.name}</h2>
          <p>
            Hand it to the person in person. It is shown only now; they set their own password and
            register a passkey at first sign-in.
          </p>
          <p className="secret">{handover.password}</p>
          <button type="button" onClick={() => setHandover(null)}>
            I have handed it over
          </button>
        </div>
      ) : null}
      <DataTable
        caption="Enclave accounts in your agency"
        rows={accounts}
        rowKey={(a) => a.id}
        columns={[
          {
            key: 'name',
            header: 'Name',
            render: (a) => (
              <button type="button" className="link" onClick={() => setSelected(a.id)}>
                {a.displayName}
              </button>
            ),
          },
          { key: 'status', header: 'Account', render: (a) => label(a.status) },
          { key: 'roles', header: 'Roles', render: (a) => a.roles.map(label).join(', ') || '—' },
          {
            key: 'q',
            header: 'CJIS-qualified',
            render: (a) => (a.qualified ? 'Yes' : `No: ${a.missing.map(missingLabel).join('; ')}`),
          },
          { key: 'training', header: 'Training until', render: (a) => a.trainingExpiresOn ?? '—' },
          { key: 'seen', header: 'Last seen', render: (a) => fmt(a.lastSeenAt) },
        ]}
      />
      <CreateAccount onCreated={(id) => act(async () => setSelected(id), 'Account created.')} />
      {current ? (
        <AccountDetail
          key={`${current.id}:${current.version}`}
          account={current}
          self={current.id === me.personId}
          act={act}
          onHandover={(password) => setHandover({ name: current.displayName, password })}
        />
      ) : null}
    </>
  );
}

function CreateAccount({ onCreated }: { onCreated: (id: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    api<Account>('/accounts', { body: { email, displayName: name } })
      .then((a) => {
        setEmail('');
        setName('');
        onCreated(a.id);
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  };
  return (
    <form onSubmit={submit} className="stack">
      <h2>Create an account</h2>
      {error ? <Status kind="error">{error}</Status> : null}
      <Input label="Name" value={name} onChange={setName} required autoComplete="name" />
      <Input label="Email" type="email" value={email} onChange={setEmail} required />
      <button type="submit">Create the account</button>
    </form>
  );
}

function AccountDetail({
  account,
  self,
  act,
  onHandover,
}: {
  account: Account;
  self: boolean;
  act: (fn: () => Promise<unknown>, done: string) => Promise<void>;
  onHandover: (password: string) => void;
}) {
  const [fingerprint, setFingerprint] = useState(account.fingerprintStatus);
  const [adjudicated, setAdjudicated] = useState(account.fingerprintAdjudicatedOn ?? '');
  const [trained, setTrained] = useState(account.trainingCompletedOn ?? '');
  const [role, setRole] = useState('officer');
  const [reason, setReason] = useState('');
  return (
    <section aria-labelledby="acct-h" className="panel">
      <h2 id="acct-h">{account.displayName}</h2>
      <p className="meta">
        {account.email} · {label(account.status)} · identity {label(account.identityState)}
      </p>
      {self ? (
        <Status kind="info">
          This is your own account. Another administrator records your screening and decides your
          roles.
        </Status>
      ) : (
        <>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () =>
                  api(`/accounts/${account.id}/screening`, {
                    version: account.version,
                    body: {
                      fingerprintStatus: fingerprint,
                      fingerprintAdjudicatedOn: adjudicated || null,
                      trainingCompletedOn: trained || null,
                    },
                  }),
                'Screening recorded.',
              );
            }}
          >
            <h3>Screening</h3>
            <p className="hint">Status and dates only; the check results stay with your agency.</p>
            <Input
              label="Fingerprint-based record check"
              value={fingerprint}
              onChange={setFingerprint}
              options={[
                ['not_started', 'Not started'],
                ['pending', 'Pending'],
                ['cleared', 'Cleared'],
                ['denied', 'Denied'],
              ]}
            />
            <Input
              label="Adjudicated on"
              type="date"
              value={adjudicated}
              onChange={setAdjudicated}
            />
            <Input
              label="Security awareness training completed on"
              hint="Counts for 12 months"
              type="date"
              value={trained}
              onChange={setTrained}
            />
            <button type="submit">Save the screening</button>
          </form>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () =>
                  api('/permission-requests', {
                    body: { personId: account.id, role, change: 'grant', reason },
                  }),
                'Role requested. A second administrator decides it under Approvals.',
              ).then(() => setReason(''));
            }}
          >
            <h3>Ask for a role</h3>
            <Input label="Role" value={role} onChange={setRole} options={ROLES} />
            <Input label="Why" value={reason} onChange={setReason} required />
            <button type="submit">Ask for the role</button>
          </form>
          <div className="actions">
            {account.status === 'invited' ? (
              <button
                type="button"
                className="primary"
                onClick={() =>
                  void act(async () => {
                    const out = await api<{ temporaryPassword: string }>(
                      `/accounts/${account.id}/activate`,
                      { method: 'POST', version: account.version },
                    );
                    onHandover(out.temporaryPassword);
                  }, 'Account activated. The identity is being created.')
                }
              >
                Activate and show the one-time password
              </button>
            ) : null}
            {account.status === 'active' ? (
              <button
                type="button"
                onClick={() =>
                  void act(
                    () =>
                      api(`/accounts/${account.id}/suspend`, {
                        method: 'POST',
                        version: account.version,
                      }),
                    'Account suspended.',
                  )
                }
              >
                Suspend
              </button>
            ) : null}
            {account.status === 'suspended' ? (
              <button
                type="button"
                onClick={() =>
                  void act(
                    () =>
                      api(`/accounts/${account.id}/reactivate`, {
                        method: 'POST',
                        version: account.version,
                      }),
                    'Account reactivated.',
                  )
                }
              >
                Reactivate
              </button>
            ) : null}
            {account.status !== 'deactivated' ? (
              <button
                type="button"
                onClick={() =>
                  void act(
                    () =>
                      api(`/accounts/${account.id}/deactivate`, {
                        method: 'POST',
                        version: account.version,
                      }),
                    'Account deactivated; its roles are revoked.',
                  )
                }
              >
                Deactivate
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

export function ApprovalsScreen({ me }: { me: { personId: string } }) {
  const [requests, setRequests] = useState<RoleRequest[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([
      api<RoleRequest[]>('/permission-requests?status=pending'),
      api<Account[]>('/accounts'),
    ])
      .then(([r, a]) => {
        setRequests(r);
        setAccounts(a);
      })
      .catch((e: unknown) => setError(describeFailure(e)));
  }, []);
  useEffect(load, [load]);
  const name = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? 'Unknown';
  const decide = (r: RoleRequest, outcome: 'approve' | 'reject') => {
    setError(null);
    setNotice(null);
    api(`/permission-requests/${r.id}/${outcome}`, { method: 'POST', version: r.version })
      .then(() => {
        setNotice(outcome === 'approve' ? 'Approved.' : 'Rejected.');
        load();
      })
      .catch((e: unknown) => setError(describeFailure(e)));
  };
  return (
    <>
      <h1>Approvals</h1>
      <p>Role requests wait for a second administrator. Nobody decides their own request.</p>
      {notice ? <Status kind="success">{notice}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Pending role requests"
        rows={requests}
        rowKey={(r) => r.id}
        empty="No pending requests."
        columns={[
          { key: 'who', header: 'For', render: (r) => name(r.personId) },
          { key: 'what', header: 'Change', render: (r) => `${label(r.change)} ${label(r.role)}` },
          { key: 'why', header: 'Why', render: (r) => r.reason },
          { key: 'by', header: 'Asked by', render: (r) => name(r.requestedBy) },
          { key: 'when', header: 'When', render: (r) => fmt(r.requestedAt) },
          {
            key: 'act',
            header: 'Decision',
            render: (r) =>
              r.requestedBy === me.personId || r.personId === me.personId ? (
                <span>Another administrator decides</span>
              ) : (
                <span className="actions">
                  <button type="button" onClick={() => decide(r, 'approve')}>
                    Approve
                  </button>
                  <button type="button" onClick={() => decide(r, 'reject')}>
                    Reject
                  </button>
                </span>
              ),
          },
        ]}
      />
    </>
  );
}

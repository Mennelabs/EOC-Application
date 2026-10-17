/**
 * Roles, preview, change requests and assignments (ADM-04, ADM-05), audit
 * viewer (SEC-18), break-glass (SEC-08), retention and definitions (SEC-13,
 * BRD:FR-00.10). Every consequential action goes through the confirmation
 * dialog the API client raises on 428 (RULE-14).
 */
import { useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  templateKey: string | null;
  currentVersion: number;
  status: string;
}
interface Preview {
  allowedActions: {
    action: string;
    description: string;
    consequential: boolean;
    ownRecordsOnly?: boolean;
  }[];
  deniedActions: string[];
  visibleCategories: string[];
  hiddenCategories: { category: string; reason: string }[];
}
interface RoleDetail extends Role {
  versions: {
    version: number;
    grants: unknown[];
    changeReason: string | null;
    createdAt: string;
    current: boolean;
  }[];
  preview: Preview;
}

export function RolesScreen() {
  const { rows, error, reload } = useList<Role>('/roles');
  const [detail, setDetail] = useState<RoleDetail | null>(null);
  const [templates, setTemplates] = useState<
    { key: string; name: string; description: string }[] | null
  >(null);
  const [form, setForm] = useState({ key: '', name: '', templateKey: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const open = async (r: Role) => {
    try {
      setDetail(await api<RoleDetail>(`/roles/${r.id}`));
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const loadTemplates = async () => {
    if (!templates) setTemplates(await api('/role-templates'));
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/roles', {
        body: { key: form.key, name: form.name, templateKey: form.templateKey || undefined },
      });
      setMsg(`Created role ${form.name}.`);
      setForm({ key: '', name: '', templateKey: '' });
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="roles-h">
      <h1 id="roles-h">Roles</h1>
      <p>
        Roles are versioned. Publishing a new version or assigning a role takes a second
        administrator’s approval.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Roles"
        rows={rows ?? []}
        rowKey={(r) => r.id}
        columns={[
          {
            key: 'name',
            header: 'Name',
            render: (r) => (
              <button type="button" className="link" onClick={() => open(r)}>
                {r.name}
              </button>
            ),
          },
          { key: 'key', header: 'Key', render: (r) => <code>{r.key}</code> },
          { key: 'tpl', header: 'From template', render: (r) => r.templateKey ?? '—' },
          { key: 'v', header: 'Version', render: (r) => r.currentVersion },
          { key: 'status', header: 'Status', render: (r) => r.status },
        ]}
      />
      {detail ? (
        <aside className="panel" aria-labelledby="role-h">
          <h2 id="role-h">What can {detail.name} do?</h2>
          <h3>Allowed ({detail.preview.allowedActions.length})</h3>
          <ul>
            {detail.preview.allowedActions.map((a) => (
              <li key={a.action}>
                <code>{a.action}</code> — {a.description}
                {a.ownRecordsOnly ? ' (only work assigned to them or their team)' : ''}
                {a.consequential ? ' (needs confirmation)' : ''}
              </li>
            ))}
          </ul>
          <h3>Sees these data categories</h3>
          <p>{detail.preview.visibleCategories.join(', ') || 'none'}</p>
          <h3>Never sees</h3>
          <ul>
            {detail.preview.hiddenCategories.map((h) => (
              <li key={h.category}>
                {h.category}: {h.reason}
              </li>
            ))}
          </ul>
          <h3>Versions</h3>
          <ul>
            {detail.versions.map((v) => (
              <li key={v.version}>
                v{v.version}
                {v.current ? ' (current)' : ''} · {fmt(v.createdAt)} · {v.changeReason ?? ''}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setDetail(null)}>
            Close
          </button>
        </aside>
      ) : null}
      <h2>Create a role</h2>
      <form className="form-grid" onSubmit={create} onFocus={() => void loadTemplates()}>
        <Field
          label="From template"
          hint="Start from a shipped role; protected health, counseling and legal fields come only from templates."
        >
          {({ id, describedBy }) => (
            <select
              id={id}
              aria-describedby={describedBy}
              value={form.templateKey}
              onChange={(e) => setForm({ ...form, templateKey: e.target.value })}
            >
              <option value="">Blank role</option>
              {(templates ?? []).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Key" hint="Lowercase, underscores, e.g. shelter_lead">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              pattern="[a-z][a-z0-9_]*"
              required
            />
          )}
        </Field>
        <Field label="Name">
          {({ id }) => (
            <input
              id={id}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          )}
        </Field>
        <Toolbar>
          <button type="submit" className="primary">
            Create
          </button>
        </Toolbar>
      </form>
      {msg ? <Status kind={msg.startsWith('Created') ? 'success' : 'error'}>{msg}</Status> : null}
    </section>
  );
}

interface ChangeRequest {
  id: string;
  version: number;
  kind: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  requestedAt: string;
  status: string;
  decisionReason: string | null;
}

export function ApprovalsScreen() {
  const { rows, error, reload } = useList<ChangeRequest>('/permission-changes?status=pending');
  const accounts = useList<{ id: string; displayName: string; email: string }>('/accounts');
  const roles = useList<Role>('/roles');
  const [form, setForm] = useState({ accountId: '', roleId: '' });
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
  const name = (id: string) =>
    accounts.rows?.find((a) => a.id === id)?.displayName ?? id.slice(0, 8);
  const roleName = (id: string) => roles.rows?.find((r) => r.id === id)?.name ?? id.slice(0, 8);
  return (
    <section aria-labelledby="approvals-h">
      <h1 id="approvals-h">Permission changes</h1>
      <p>
        You cannot approve your own request. Approving applies the change immediately and records
        both names.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Pending requests"
        rows={rows ?? []}
        rowKey={(c) => c.id}
        empty="No pending requests."
        columns={[
          {
            key: 'kind',
            header: 'Change',
            render: (c) =>
              c.kind === 'assign_role'
                ? `Assign ${roleName(String(c.payload['roleId']))} to ${name(String(c.payload['accountId']))}`
                : `Publish ${roleName(String(c.payload['roleId']))} v${String(c.payload['version'])}`,
          },
          { key: 'by', header: 'Requested by', render: (c) => name(c.requestedBy) },
          { key: 'at', header: 'When', render: (c) => fmt(c.requestedAt) },
          {
            key: 'actions',
            header: 'Decision',
            render: (c) => (
              <Toolbar>
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    run(
                      () =>
                        api(`/permission-changes/${c.id}/approve`, {
                          method: 'POST',
                          version: c.version,
                          idempotent: false,
                        }),
                      'Approved and applied.',
                    )
                  }
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() =>
                    run(
                      () =>
                        api(`/permission-changes/${c.id}/reject`, {
                          method: 'POST',
                          version: c.version,
                          idempotent: false,
                        }),
                      'Rejected.',
                    )
                  }
                >
                  Reject
                </button>
              </Toolbar>
            ),
          },
        ]}
      />
      <h2>Request a role assignment</h2>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => api('/permission-changes', { body: { kind: 'assign_role', ...form, scope: {} } }),
            'Requested. Another administrator must approve it.',
          );
        }}
      >
        <Field label="Account">
          {({ id }) => (
            <select
              id={id}
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {(accounts.rows ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName} ({a.email})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Role">
          {({ id }) => (
            <select
              id={id}
              value={form.roleId}
              onChange={(e) => setForm({ ...form, roleId: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {(roles.rows ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Toolbar>
          <button type="submit" className="primary">
            Request
          </button>
        </Toolbar>
      </form>
      {msg ? (
        <Status kind={/Approved|Rejected|Requested/.test(msg) ? 'success' : 'error'}>{msg}</Status>
      ) : null}
    </section>
  );
}

interface AuditRow {
  seq: number;
  occurredAt: string;
  actorKind: string;
  actorAccountId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  classificationRead: string[];
}

export function AuditScreen() {
  const [filter, setFilter] = useState({ action: '', targetType: '' });
  const q = new URLSearchParams({
    limit: '100',
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.targetType ? { targetType: filter.targetType } : {}),
  });
  const { rows, error } = useList<AuditRow>(`/audit?${q}`);
  const verify = useList<never>('/audit/verify');
  const v = verify.rows as unknown as {
    ok: boolean;
    checked: number;
    firstBadSeq: number | null;
    lastAnchor: { anchoredAt: string } | null;
  } | null;
  return (
    <section aria-labelledby="audit-h">
      <h1 id="audit-h">Audit log</h1>
      {v ? (
        <Status kind={v.ok ? 'success' : 'error'}>
          {v.ok
            ? `Chain verified: ${v.checked} records intact.`
            : `Chain broken at record ${v.firstBadSeq}. Contact the security administrator.`}
          {v.lastAnchor ? ` Last anchored ${fmt(v.lastAnchor.anchoredAt)}.` : ' Not anchored yet.'}
        </Status>
      ) : null}
      {verify.error ? <Status kind="error">{verify.error}</Status> : null}
      <form className="toolbar" onSubmit={(e) => e.preventDefault()}>
        <Field label="Action">
          {({ id }) => (
            <input
              id={id}
              value={filter.action}
              onChange={(e) => setFilter({ ...filter, action: e.target.value })}
              placeholder="e.g. event.open"
            />
          )}
        </Field>
        <Field label="Record type">
          {({ id }) => (
            <input
              id={id}
              value={filter.targetType}
              onChange={(e) => setFilter({ ...filter, targetType: e.target.value })}
              placeholder="e.g. tenant"
            />
          )}
        </Field>
      </form>
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Most recent audit records"
        rows={rows ?? []}
        rowKey={(r) => String(r.seq)}
        columns={[
          { key: 'seq', header: '#', render: (r) => r.seq },
          { key: 'at', header: 'When', render: (r) => fmt(r.occurredAt) },
          {
            key: 'who',
            header: 'Who',
            render: (r) =>
              r.actorKind === 'account' ? (r.actorAccountId ?? '').slice(0, 8) : r.actorKind,
          },
          { key: 'action', header: 'Action', render: (r) => <code>{r.action}</code> },
          {
            key: 'target',
            header: 'Record',
            render: (r) => `${r.targetType} ${r.targetId.slice(0, 12)}`,
          },
          {
            key: 'restricted',
            header: 'Restricted read',
            render: (r) => r.classificationRead.join(', ') || '—',
          },
          { key: 'reason', header: 'Reason', render: (r) => r.reason ?? '—' },
        ]}
      />
    </section>
  );
}

interface BreakGlass {
  id: string;
  version: number;
  accountId: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  notifiedAt: string | null;
}

export function BreakGlassScreen({ onChanged }: { onChanged: () => void }) {
  const { rows, error, reload } = useList<BreakGlass>('/break-glass');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      reload();
      onChanged();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="bg-h">
      <h1 id="bg-h">Emergency access (break-glass)</h1>
      <p>
        Read-only access to every record in your organization for up to 24 hours. Every read is
        audited as restricted, the security contact is told at once, and permission changes are
        frozen while it is active.
      </p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => api('/break-glass', { body: { reason, hours: 4 } }),
            'Emergency access started for 4 hours.',
          ).then(() => setReason(''));
        }}
      >
        <Field
          label="Why do you need this?"
          hint="At least 20 characters. Goes to the security contact and the audit log."
        >
          {({ id, describedBy }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              minLength={20}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          )}
        </Field>
        <Toolbar>
          <button type="submit" className="primary">
            Start emergency access
          </button>
        </Toolbar>
      </form>
      {msg ? (
        <Status kind={msg.startsWith('Emergency') || msg.startsWith('Ended') ? 'success' : 'error'}>
          {msg}
        </Status>
      ) : null}
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Sessions"
        rows={rows ?? []}
        rowKey={(s) => s.id}
        columns={[
          { key: 'start', header: 'Started', render: (s) => fmt(s.startedAt) },
          { key: 'exp', header: 'Ends', render: (s) => fmt(s.endedAt ?? s.expiresAt) },
          { key: 'reason', header: 'Reason', render: (s) => s.reason },
          { key: 'notified', header: 'Security contact told', render: (s) => fmt(s.notifiedAt) },
          {
            key: 'act',
            header: '',
            render: (s) =>
              !s.endedAt ? (
                <button
                  type="button"
                  onClick={() =>
                    run(
                      () =>
                        api(`/break-glass/${s.id}/end`, {
                          method: 'POST',
                          version: s.version,
                          idempotent: false,
                        }),
                      'Ended.',
                    )
                  }
                >
                  End now
                </button>
              ) : null,
          },
        ]}
      />
    </section>
  );
}

interface Retention {
  dataCategory: string;
  keepForDays: number | null;
  rule: string;
  note: string | null;
  version: number;
}

/** SEC-13: whole years read as years ("7 years"), anything else in days ("30 days"). */
function keptFor(days: number | null): string {
  if (!days) return 'not set';
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  return days === 1 ? '1 day' : `${days} days`;
}

interface Hold {
  id: string;
  version: number;
  scope: Record<string, unknown>;
  reason: string;
  placedAt: string;
  releasedAt: string | null;
}

export function RetentionScreen() {
  const retention = useList<Retention>('/retention');
  const holds = useList<Hold>('/legal-holds');
  const [hold, setHold] = useState({ targetType: '', targetId: '', reason: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      holds.reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="ret-h">
      <h1 id="ret-h">Retention and legal holds</h1>
      {retention.error ? <Status kind="error">{retention.error}</Status> : null}
      <DataTable
        caption="Retention policy by data category"
        rows={retention.rows ?? []}
        rowKey={(r) => r.dataCategory}
        columns={[
          { key: 'cat', header: 'Category', render: (r) => r.dataCategory.replace('_', ' ') },
          {
            key: 'keep',
            header: 'Kept for',
            render: (r) =>
              r.rule === 'duration'
                ? keptFor(r.keepForDays)
                : r.rule === 'on_confirm'
                  ? 'deleted when the note is confirmed'
                  : 'governed elsewhere',
          },
          { key: 'note', header: 'Note', render: (r) => r.note ?? '—' },
        ]}
      />
      <h2>Legal holds</h2>
      <p>A hold stops deletion for the records it names until it is released.</p>
      {holds.error ? <Status kind="error">{holds.error}</Status> : null}
      <DataTable
        caption="Legal holds"
        rows={holds.rows ?? []}
        rowKey={(h) => h.id}
        empty="No legal holds."
        columns={[
          { key: 'scope', header: 'Scope', render: (h) => JSON.stringify(h.scope) },
          { key: 'reason', header: 'Reason', render: (h) => h.reason },
          { key: 'placed', header: 'Placed', render: (h) => fmt(h.placedAt) },
          { key: 'released', header: 'Released', render: (h) => fmt(h.releasedAt) },
          {
            key: 'act',
            header: '',
            render: (h) =>
              !h.releasedAt ? (
                <button
                  type="button"
                  onClick={() =>
                    run(
                      () =>
                        api(`/legal-holds/${h.id}/release`, {
                          method: 'POST',
                          version: h.version,
                          idempotent: false,
                        }),
                      'Hold released.',
                    )
                  }
                >
                  Release
                </button>
              ) : null,
          },
        ]}
      />
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              api('/legal-holds', {
                body: {
                  scope: { targetType: hold.targetType, targetId: hold.targetId || undefined },
                  reason: hold.reason,
                },
              }),
            'Hold placed.',
          );
        }}
      >
        <Field label="Record type">
          {({ id }) => (
            <input
              id={id}
              value={hold.targetType}
              onChange={(e) => setHold({ ...hold, targetType: e.target.value })}
              required
            />
          )}
        </Field>
        <Field label="Record id (optional)">
          {({ id }) => (
            <input
              id={id}
              value={hold.targetId}
              onChange={(e) => setHold({ ...hold, targetId: e.target.value })}
            />
          )}
        </Field>
        <Field label="Reason">
          {({ id }) => (
            <input
              id={id}
              value={hold.reason}
              onChange={(e) => setHold({ ...hold, reason: e.target.value })}
              minLength={10}
              required
            />
          )}
        </Field>
        <Toolbar>
          <button type="submit" className="primary">
            Place hold
          </button>
        </Toolbar>
      </form>
      {msg ? <Status kind={/placed|released/.test(msg) ? 'success' : 'error'}>{msg}</Status> : null}
    </section>
  );
}

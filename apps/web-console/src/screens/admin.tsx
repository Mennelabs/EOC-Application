/**
 * Administration screens (ADM-01, BRD:FR-01, FR-18): tenants, events,
 * accounts, personnel. Each list loads through the authorized API; what is
 * visible is what the role allows, and nothing is hidden client-side only.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, Toolbar, fmt } from '../ui/primitives.tsx';

export function useList<T>(path: string, deps: unknown[] = []) {
  const [state, setState] = useState<{ rows: T[] | null; error: string | null }>({
    rows: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<T[]>(path)
      .then((rows) => live && setState({ rows, error: null }))
      .catch(
        (e: unknown) => live && setState((s) => ({ rows: s.rows, error: describeFailure(e) })),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  return { rows: state.rows, error: state.error, reload: () => setTick((t) => t + 1) };
}

interface Tenant {
  id: string;
  version: number;
  kind: string;
  slug: string;
  name: string;
  status: string;
  locales: string[];
  timezone: string;
  parentId: string | null;
}

export function TenantsScreen() {
  const { rows, error, reload } = useList<Tenant>('/tenants');
  const [form, setForm] = useState({ parentId: '', kind: 'partner_org', slug: '', name: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/tenants', { body: { ...form, locales: ['en', 'es'] } });
      setMsg(`Created ${form.name}. The worker is setting up its sign-in realm.`);
      setForm({ parentId: '', kind: 'partner_org', slug: '', name: '' });
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="tenants-h">
      <h1 id="tenants-h">Organizations</h1>
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Organizations you can see"
        rows={rows ?? []}
        rowKey={(t) => t.id}
        columns={[
          { key: 'name', header: 'Name', render: (t) => t.name },
          { key: 'kind', header: 'Kind', render: (t) => t.kind.replace('_', ' ') },
          { key: 'slug', header: 'Sign-in realm', render: (t) => <code>{t.slug}</code> },
          { key: 'status', header: 'Status', render: (t) => t.status },
          { key: 'locales', header: 'Languages', render: (t) => t.locales.join(', ') },
        ]}
      />
      <h2>Add a partner organization or child jurisdiction</h2>
      <form onSubmit={create} className="form-grid">
        <Field label="Parent organization">
          {({ id }) => (
            <select
              id={id}
              value={form.parentId}
              onChange={(e) => setForm({ ...form, parentId: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {(rows ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Kind">
          {({ id }) => (
            <select
              id={id}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              <option value="partner_org">Partner organization</option>
              <option value="city">City</option>
              <option value="county">County</option>
              <option value="region">Region or coalition</option>
            </select>
          )}
        </Field>
        <Field
          label="Realm name"
          hint="Lowercase letters, digits and hyphens. Becomes the sign-in address; cannot change later."
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              pattern="[a-z0-9][a-z0-9-]*"
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

interface Event {
  id: string;
  version: number;
  name: string;
  hazardType: string;
  status: 'draft' | 'active' | 'closed';
  intakeSlug: string | null;
  intakeKeywords: string[];
  openedAt: string | null;
  closedAt: string | null;
}

export function EventsScreen() {
  const { rows, error, reload } = useList<Event>('/events');
  const [form, setForm] = useState({ name: '', hazardType: 'tornado' });
  const [openForm, setOpenForm] = useState<{ id: string; slug: string; keywords: string } | null>(
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
  return (
    <section aria-labelledby="events-h">
      <h1 id="events-h">Events</h1>
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Events"
        rows={rows ?? []}
        rowKey={(e) => e.id}
        columns={[
          { key: 'name', header: 'Name', render: (e) => e.name },
          { key: 'hazard', header: 'Hazard', render: (e) => e.hazardType },
          { key: 'status', header: 'Status', render: (e) => e.status },
          {
            key: 'intake',
            header: 'Intake',
            render: (e) =>
              e.intakeSlug ? `/${e.intakeSlug} · ${e.intakeKeywords.join(' / ')}` : '—',
          },
          { key: 'opened', header: 'Opened', render: (e) => fmt(e.openedAt) },
          {
            key: 'actions',
            header: 'Actions',
            render: (e) => (
              <Toolbar>
                {e.status === 'draft' ? (
                  <button
                    type="button"
                    onClick={() => setOpenForm({ id: e.id, slug: '', keywords: '' })}
                  >
                    Open…
                  </button>
                ) : null}
                {e.status === 'active' ? (
                  <button
                    type="button"
                    onClick={() =>
                      run(
                        () =>
                          api(`/events/${e.id}/close`, {
                            method: 'POST',
                            version: e.version,
                            idempotent: false,
                          }),
                        `Closed ${e.name}.`,
                      )
                    }
                  >
                    Close
                  </button>
                ) : null}
              </Toolbar>
            ),
          },
        ]}
      />
      {openForm ? (
        <form
          className="form-grid"
          aria-labelledby="open-h"
          onSubmit={(ev) => {
            ev.preventDefault();
            const target = rows?.find((r) => r.id === openForm.id);
            if (!target) return;
            void run(
              () =>
                api(`/events/${openForm.id}/open`, {
                  method: 'POST',
                  version: target.version,
                  idempotent: false,
                  body: {
                    intakeSlug: openForm.slug,
                    intakeKeywords: openForm.keywords
                      .split(/[\s,]+/)
                      .filter(Boolean)
                      .map((k) => k.toUpperCase()),
                  },
                }),
              'Event opened. Intake is live.',
            ).then(() => setOpenForm(null));
          }}
        >
          <h2 id="open-h">Open event and publish intake</h2>
          <Field label="Intake link" hint="Short address residents will see, e.g. westwind">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={openForm.slug}
                onChange={(e) => setOpenForm({ ...openForm, slug: e.target.value })}
                pattern="[a-z0-9][a-z0-9-]*"
                required
              />
            )}
          </Field>
          <Field label="SMS keywords" hint="One per language, e.g. DAMAGE DAÑOS">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={openForm.keywords}
                onChange={(e) => setOpenForm({ ...openForm, keywords: e.target.value })}
                required
              />
            )}
          </Field>
          <Toolbar>
            <button type="button" onClick={() => setOpenForm(null)}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Open event
            </button>
          </Toolbar>
        </form>
      ) : null}
      <h2>New event</h2>
      <form
        className="form-grid"
        onSubmit={(ev) => {
          ev.preventDefault();
          void run(() => api('/events', { body: form }), `Created ${form.name} as a draft.`).then(
            () => setForm({ name: '', hazardType: 'tornado' }),
          );
        }}
      >
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
        <Field label="Hazard">
          {({ id }) => (
            <select
              id={id}
              value={form.hazardType}
              onChange={(e) => setForm({ ...form, hazardType: e.target.value })}
            >
              {['tornado', 'flood', 'winter_storm', 'wildfire', 'severe_storm', 'other'].map(
                (h) => (
                  <option key={h} value={h}>
                    {h.replace('_', ' ')}
                  </option>
                ),
              )}
            </select>
          )}
        </Field>
        <Toolbar>
          <button type="submit" className="primary">
            Create draft
          </button>
        </Toolbar>
      </form>
      {msg ? (
        <Status kind={/Created|opened|Closed/.test(msg) ? 'success' : 'error'}>{msg}</Status>
      ) : null}
    </section>
  );
}

interface Account {
  id: string;
  version: number;
  email: string;
  displayName: string;
  status: 'invited' | 'active' | 'suspended' | 'deactivated';
  lastLoginAt: string | null;
}

export function AccountsScreen() {
  const { rows, error, reload } = useList<Account>('/accounts');
  const [form, setForm] = useState({ email: '', displayName: '' });
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
  const transition = (a: Account, t: 'activate' | 'suspend' | 'deactivate') =>
    run(
      () =>
        api(`/accounts/${a.id}/${t}`, {
          method: 'POST',
          version: a.version,
          idempotent: false,
          body: {},
        }),
      `${a.displayName}: ${t}d.`,
    );
  return (
    <section aria-labelledby="accounts-h">
      <h1 id="accounts-h">Staff accounts</h1>
      <p>
        Accounts are separate from personnel records; deactivating one keeps every action it ever
        took in the audit log.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Staff accounts"
        rows={rows ?? []}
        rowKey={(a) => a.id}
        columns={[
          { key: 'name', header: 'Name', render: (a) => a.displayName },
          { key: 'email', header: 'Email', render: (a) => a.email },
          { key: 'status', header: 'Status', render: (a) => a.status },
          { key: 'login', header: 'Last sign-in', render: (a) => fmt(a.lastLoginAt) },
          {
            key: 'actions',
            header: 'Actions',
            render: (a) => (
              <Toolbar>
                {a.status !== 'active' && a.status !== 'deactivated' ? (
                  <button type="button" onClick={() => transition(a, 'activate')}>
                    Activate
                  </button>
                ) : null}
                {a.status === 'active' ? (
                  <button type="button" onClick={() => transition(a, 'suspend')}>
                    Suspend
                  </button>
                ) : null}
                {a.status !== 'deactivated' ? (
                  <button type="button" onClick={() => transition(a, 'deactivate')}>
                    Deactivate
                  </button>
                ) : null}
              </Toolbar>
            ),
          },
        ]}
      />
      <h2>Invite a staff member</h2>
      <form
        className="form-grid"
        onSubmit={(ev) => {
          ev.preventDefault();
          void run(
            () => api('/accounts/invite', { body: form }),
            `Invitation sent to ${form.email}.`,
          ).then(() => setForm({ email: '', displayName: '' }));
        }}
      >
        <Field label="Email">
          {({ id }) => (
            <input
              id={id}
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          )}
        </Field>
        <Field label="Name">
          {({ id }) => (
            <input
              id={id}
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              required
            />
          )}
        </Field>
        <Toolbar>
          <button type="submit" className="primary">
            Send invitation
          </button>
        </Toolbar>
      </form>
      {msg ? (
        <Status kind={/sent|activated|suspended|deactivated/.test(msg) ? 'success' : 'error'}>
          {msg}
        </Status>
      ) : null}
    </section>
  );
}

interface Personnel {
  id: string;
  version: number;
  name: string;
  agency: string | null;
  operationalRole: string | null;
  skills: string[];
  dutyStatus: string;
  availability: string;
  status: string;
  contact?: { phone?: string; email?: string } | null;
}

export function PersonnelScreen() {
  const { rows, error, reload } = useList<Personnel>('/personnel');
  const [detail, setDetail] = useState<Personnel | null>(null);
  const [form, setForm] = useState({
    name: '',
    agency: '',
    operationalRole: '',
    skills: '',
    phone: '',
  });
  const [msg, setMsg] = useState<string | null>(null);
  const open = async (p: Personnel) => {
    setMsg(null);
    try {
      setDetail(await api<Personnel>(`/personnel/${p.id}`));
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const create = async (ev: FormEvent) => {
    ev.preventDefault();
    setMsg(null);
    try {
      await api('/personnel', {
        body: {
          name: form.name,
          agency: form.agency || undefined,
          operationalRole: form.operationalRole || undefined,
          skills: form.skills.split(/[\s,]+/).filter(Boolean),
          contact: form.phone ? { phone: form.phone } : undefined,
        },
      });
      setMsg(`Added ${form.name}.`);
      setForm({ name: '', agency: '', operationalRole: '', skills: '', phone: '' });
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="personnel-h">
      <h1 id="personnel-h">Personnel</h1>
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Personnel"
        rows={rows ?? []}
        rowKey={(p) => p.id}
        columns={[
          {
            key: 'name',
            header: 'Name',
            render: (p) => (
              <button type="button" className="link" onClick={() => open(p)}>
                {p.name}
              </button>
            ),
          },
          { key: 'agency', header: 'Agency', render: (p) => p.agency ?? '—' },
          { key: 'role', header: 'Role', render: (p) => p.operationalRole ?? '—' },
          { key: 'skills', header: 'Skills', render: (p) => p.skills.join(', ') || '—' },
          {
            key: 'avail',
            header: 'Availability',
            render: (p) => `${p.dutyStatus.replace('_', ' ')}, ${p.availability}`,
          },
        ]}
      />
      {detail ? (
        <aside aria-labelledby="person-h" className="panel">
          <h2 id="person-h">{detail.name}</h2>
          <dl className="meta">
            <dt>Agency</dt>
            <dd>{detail.agency ?? '—'}</dd>
            <dt>Contact</dt>
            <dd>
              {detail.contact === undefined
                ? 'Not visible to your role'
                : detail.contact
                  ? `${detail.contact.phone ?? ''} ${detail.contact.email ?? ''}`.trim() || '—'
                  : 'None recorded'}
            </dd>
          </dl>
          <button type="button" onClick={() => setDetail(null)}>
            Close
          </button>
        </aside>
      ) : null}
      <h2>Add a person</h2>
      <form className="form-grid" onSubmit={create}>
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
        <Field label="Agency">
          {({ id }) => (
            <input
              id={id}
              value={form.agency}
              onChange={(e) => setForm({ ...form, agency: e.target.value })}
            />
          )}
        </Field>
        <Field label="Operational role">
          {({ id }) => (
            <input
              id={id}
              value={form.operationalRole}
              onChange={(e) => setForm({ ...form, operationalRole: e.target.value })}
            />
          )}
        </Field>
        <Field label="Skills" hint="Separate with commas">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.skills}
              onChange={(e) => setForm({ ...form, skills: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Phone"
          hint="Stored encrypted; shown only to roles that may see contact details."
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          )}
        </Field>
        <Toolbar>
          <button type="submit" className="primary">
            Add
          </button>
        </Toolbar>
      </form>
      {msg ? <Status kind={msg.startsWith('Added') ? 'success' : 'error'}>{msg}</Status> : null}
    </section>
  );
}

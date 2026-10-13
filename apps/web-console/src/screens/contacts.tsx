/**
 * Interagency contacts (plan console screen 10; BRD:FR-17.01/17.02, CNT-01,
 * F17): who to reach at each agency, 24-hour and backup contacts, verified
 * on a date and due for re-verification; names and numbers are shown only
 * to roles with the contact category and every read is recorded.
 */
import { useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';

interface Contact {
  id: string;
  version: number;
  agency: string;
  role: string | null;
  type: string;
  active: boolean;
  verifiedAt: string | null;
  verifyBy: string | null;
  due: boolean;
  name: string | null;
  methods: { phone?: string; phoneAfterHours?: string; email?: string; radio?: string } | null;
}

const TYPES = ['operations', 'twenty_four_hour', 'backup', 'media', 'liaison'];
const label = (s: string) => s.replace(/_/g, ' ');
const blank = {
  agency: '',
  name: '',
  role: '',
  type: 'operations',
  phone: '',
  phoneAfterHours: '',
  email: '',
};

export function ContactsScreen() {
  const { rows, error, reload } = useList<Contact>('/contacts?limit=200');
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState<string | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/contacts', {
        body: {
          agency: form.agency,
          name: form.name,
          role: form.role || null,
          type: form.type,
          methods: {
            ...(form.phone ? { phone: form.phone } : {}),
            ...(form.phoneAfterHours ? { phoneAfterHours: form.phoneAfterHours } : {}),
            ...(form.email ? { email: form.email } : {}),
          },
        },
      });
      setMsg(`${form.name} added and verified today.`);
      setForm(blank);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const verify = async (c: Contact) => {
    setMsg(null);
    try {
      await api(`/contacts/${c.id}/verify`, { body: {} });
      setMsg(`${c.agency}: verified; due again in 180 days.`);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="contacts-h">
      <h1 id="contacts-h">Interagency contacts</h1>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      <DataTable
        caption="Contacts"
        rows={rows ?? []}
        rowKey={(c) => c.id}
        columns={[
          { key: 'agency', header: 'Agency', render: (c) => c.agency },
          { key: 'type', header: 'Type', render: (c) => label(c.type) },
          { key: 'name', header: 'Name', render: (c) => c.name ?? '(restricted)' },
          { key: 'role', header: 'Role', render: (c) => c.role ?? '—' },
          {
            key: 'reach',
            header: 'Reach',
            render: (c) =>
              c.methods
                ? [
                    c.methods.phone,
                    c.methods.phoneAfterHours && `after hours ${c.methods.phoneAfterHours}`,
                    c.methods.email,
                    c.methods.radio,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : '(restricted)',
          },
          {
            key: 'verified',
            header: 'Verified',
            render: (c) => `${fmt(c.verifiedAt)}${c.verifyBy ? `, due ${c.verifyBy}` : ''}`,
          },
          {
            key: 'due',
            header: 'Status',
            render: (c) =>
              c.active ? (
                c.due ? (
                  <span className="badge badge-full">re-verify</span>
                ) : (
                  'current'
                )
              ) : (
                'inactive'
              ),
          },
          {
            key: 'act',
            header: 'Actions',
            render: (c) => (
              <button type="button" onClick={() => verify(c)}>
                Verified today
              </button>
            ),
          },
        ]}
      />
      <h2>Add a contact</h2>
      <form onSubmit={create} className="form-grid">
        <Field label="Agency">
          {({ id }) => (
            <input
              id={id}
              value={form.agency}
              onChange={(e) => setForm({ ...form, agency: e.target.value })}
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
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Role">
          {({ id }) => (
            <input
              id={id}
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
          )}
        </Field>
        <Field label="Type">
          {({ id }) => (
            <select
              id={id}
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Phone">
          {({ id }) => (
            <input
              id={id}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="After-hours phone">
          {({ id }) => (
            <input
              id={id}
              value={form.phoneAfterHours}
              onChange={(e) => setForm({ ...form, phoneAfterHours: e.target.value })}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Email">
          {({ id }) => (
            <input
              id={id}
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              autoComplete="off"
            />
          )}
        </Field>
        <div className="actions">
          <button type="submit" className="primary">
            Add contact
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * Partner onboarding (plan console screen 12; ADM-02, SCL-01, NED-04): the
 * county drafts a data-sharing agreement with a partner organization naming
 * the organization type residents consent to, the service it provides and
 * the data categories it may receive; the partner organization signs it from
 * its own workspace with the record version and a reason; the county can
 * revoke it; signed agreements drive the share grants.
 */
import { useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';

interface Agreement {
  id: string;
  version: number;
  fromTenantId: string;
  toTenantId: string;
  scope: string;
  dataCategories: string[];
  status: string;
  signedAt: string | null;
  terms: { orgType?: string; service?: string };
}
interface Tenant {
  id: string;
  name: string;
  kind: string;
}

const ORG_TYPES = ['volunteer_cleanup', 'relief_agencies', 'community_groups', 'faith_based'];
const SERVICES = ['cleanup', 'feeding', 'shelter', 'counseling', 'legal', 'coordination'];
const CATEGORIES = ['contact', 'location_exact', 'household', 'access_needs'];
const label = (s: string) => s.replace(/_/g, ' ');

export function PartnersScreen({ me }: { me: { tenantId: string } | null }) {
  const agreements = useList<Agreement>('/agreements');
  const tenants = useList<Tenant>('/tenants');
  const [form, setForm] = useState({
    toTenantId: '',
    orgType: 'volunteer_cleanup',
    service: 'cleanup',
    categories: ['contact'] as string[],
  });
  const [msg, setMsg] = useState<string | null>(null);
  const name = (id: string) => tenants.rows?.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  const draft = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/agreements', {
        body: {
          toTenantId: form.toTenantId,
          scope: 'consented_records',
          dataCategories: form.categories,
          terms: {
            orgType: form.orgType,
            service: form.service,
            recallOnWithdrawal: true,
            deleteOnRecall: true,
          },
        },
      });
      setMsg('Agreement drafted; the partner organization signs it from its own workspace.');
      agreements.reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };

  // Layer-1 rule: the county's draft is its commitment; the receiving organization signs
  // (with the record version and a reason); the county revokes.
  const act = async (a: Agreement, verb: 'sign' | 'revoke') => {
    setMsg(null);
    try {
      await api<Agreement>(`/agreements/${a.id}/${verb}`, { body: {}, version: a.version });
      setMsg(
        verb === 'sign'
          ? 'Signed; sharing follows residents’ consent from now on.'
          : 'Agreement revoked; grants under it end at the next sync.',
      );
      agreements.reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };

  return (
    <section aria-labelledby="partners-h">
      <h1 id="partners-h">Partner organizations</h1>
      <p>
        Add the organization under Organizations first; then draft its agreement here. Residents
        still choose, per organization type, whether anything is shared.
      </p>
      {agreements.error ? <Status kind="error">{agreements.error}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      <DataTable
        caption="Data-sharing agreements"
        rows={agreements.rows ?? []}
        rowKey={(a) => a.id}
        empty="No agreements yet."
        columns={[
          {
            key: 'with',
            header: 'With',
            render: (a) =>
              a.fromTenantId === me?.tenantId ? name(a.toTenantId) : name(a.fromTenantId),
          },
          { key: 'org', header: 'Organization type', render: (a) => label(a.terms.orgType ?? '—') },
          { key: 'service', header: 'Service', render: (a) => a.terms.service ?? '—' },
          {
            key: 'cats',
            header: 'May receive',
            render: (a) => a.dataCategories.map(label).join(', ') || 'basic only',
          },
          {
            key: 'status',
            header: 'Status',
            render: (a) => (a.status === 'draft' ? 'waiting for the partner to sign' : a.status),
          },
          { key: 'signed', header: 'Signed', render: (a) => fmt(a.signedAt) },
          {
            key: 'act',
            header: 'Actions',
            render: (a) => (
              <span className="actions">
                {a.status === 'draft' && a.toTenantId === me?.tenantId ? (
                  <button type="button" className="primary" onClick={() => act(a, 'sign')}>
                    Sign…
                  </button>
                ) : null}
                {a.status === 'signed' && a.fromTenantId === me?.tenantId ? (
                  <button type="button" onClick={() => act(a, 'revoke')}>
                    Revoke…
                  </button>
                ) : null}
              </span>
            ),
          },
        ]}
      />
      <h2>Draft an agreement</h2>
      <form onSubmit={draft} className="form-grid">
        <Field label="Partner organization">
          {({ id }) => (
            <select
              id={id}
              value={form.toTenantId}
              onChange={(e) => setForm({ ...form, toTenantId: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {(tenants.rows ?? [])
                .filter((t) => t.kind === 'partner_org')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field label="Organization type residents consent to">
          {({ id }) => (
            <select
              id={id}
              value={form.orgType}
              onChange={(e) => setForm({ ...form, orgType: e.target.value })}
            >
              {ORG_TYPES.map((o) => (
                <option key={o} value={o}>
                  {label(o)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Service" hint="Fixes the minimum fields the partner may see (NED-04).">
          {({ id, describedBy }) => (
            <select
              id={id}
              aria-describedby={describedBy}
              value={form.service}
              onChange={(e) => setForm({ ...form, service: e.target.value })}
            >
              {SERVICES.map((sv) => (
                <option key={sv} value={sv}>
                  {sv}
                </option>
              ))}
            </select>
          )}
        </Field>
        <fieldset>
          <legend>Data categories the partner may receive</legend>
          {CATEGORIES.map((c) => (
            <label key={c} className="inline">
              <input
                type="checkbox"
                checked={form.categories.includes(c)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    categories: e.target.checked
                      ? [...form.categories, c]
                      : form.categories.filter((x) => x !== c),
                  })
                }
              />{' '}
              {label(c)}
            </label>
          ))}
        </fieldset>
        <div className="actions">
          <button type="submit" className="primary">
            Draft agreement
          </button>
        </div>
      </form>
    </section>
  );
}

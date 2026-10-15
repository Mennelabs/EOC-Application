/**
 * Partner workspace, "Our services" (decided 2026-10-15; PUB-01, PUB-03,
 * PUB-05, PUB-06, CON-16, REC-13): a partner organization posts the shelter,
 * feeding site, POD or other service it runs, and its approver publishes it
 * on the county's Find help page, feeds and text replies at once, with the
 * confirmation dialog and a reason. The county is told and can edit, close or
 * withdraw it. The partner also confirms status and census on every site it
 * runs, including the county's own sites it operates.
 */
import { useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';

interface Service {
  id: string;
  version: number;
  kind: string;
  name: string;
  status: string;
  address: { line1: string | null; city: string | null; postal: string | null } | null;
  position: { lat: number; lon: number } | null;
  capacity: number | null;
  occupancy: number | null;
  hours: Record<string, unknown>;
  services: string[];
  pets: string;
  accessibility: Record<string, unknown>;
  languages: string[];
  notes: string | null;
  confidential: boolean;
  confirmEveryHours: number;
  lastConfirmedAt: string | null;
  stale: boolean;
  confirmDueAt: string | null;
  published: boolean;
  publishedAt: string | null;
  postedBy: { tenantId: string; name: string | null } | null;
}

const KINDS = ['shelter', 'feeding', 'pod', 'cooling', 'warming', 'charging', 'other'];
const STATUSES = ['planned', 'open', 'limited', 'full', 'closed'];
const ACCESS: [string, string][] = [
  ['ada', 'Accessible entrance and restrooms'],
  ['wheelchair', 'Wheelchair accessible'],
  ['quiet_room', 'Quiet room'],
  ['asl_on_request', 'ASL interpreter on request'],
];
const LANGS: [string, string][] = [
  ['en', 'English'],
  ['es', 'Spanish'],
];
const label = (s: string) => s.replace(/_/g, ' ');

const blank = {
  kind: 'feeding',
  name: '',
  line1: '',
  city: '',
  postal: '',
  lat: '',
  lon: '',
  status: 'open',
  capacity: '',
  hours: '',
  services: '',
  pets: 'unknown',
  access: [] as string[],
  languages: ['en'] as string[],
  notes: '',
  confidential: false,
  confirmEveryHours: '12',
};
type Form = typeof blank;

function toForm(s: Service): Form {
  return {
    kind: s.kind,
    name: s.name,
    line1: s.address?.line1 ?? '',
    city: s.address?.city ?? '',
    postal: s.address?.postal ?? '',
    lat: s.position ? String(s.position.lat) : '',
    lon: s.position ? String(s.position.lon) : '',
    status: s.status,
    capacity: s.capacity !== null ? String(s.capacity) : '',
    hours: typeof s.hours['daily'] === 'string' ? s.hours['daily'] : '',
    services: s.services.join(', '),
    pets: s.pets,
    access: ACCESS.map(([k]) => k).filter((k) => s.accessibility[k] === true),
    languages: s.languages,
    notes: s.notes ?? '',
    confidential: s.confidential,
    confirmEveryHours: String(s.confirmEveryHours),
  };
}

function toBody(f: Form) {
  return {
    kind: f.kind,
    name: f.name.trim(),
    status: f.status,
    address: { line1: f.line1 || null, city: f.city || null, postal: f.postal || null },
    position: f.lat && f.lon ? { lat: Number(f.lat), lon: Number(f.lon) } : null,
    capacity: f.capacity ? Number(f.capacity) : null,
    hours: f.hours ? { daily: f.hours } : {},
    services: f.services
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    pets: f.pets,
    accessibility: Object.fromEntries(f.access.map((k) => [k, true])),
    languages: f.languages.length ? f.languages : ['en'],
    notes: f.notes || null,
    confidential: f.confidential,
    confirmEveryHours: Number(f.confirmEveryHours) || 12,
  };
}

export function OurServicesScreen({
  me,
}: {
  me: { tenantId: string; tenantKind?: string } | null;
}) {
  const partner = me?.tenantKind === 'partner_org';
  const { rows, error, reload } = useList<Service>('/partner/sites', [partner]);
  const [form, setForm] = useState<Form>(blank);
  const [editing, setEditing] = useState<Service | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState('');

  if (me && !partner)
    return (
      <section aria-labelledby="ours-h">
        <h1 id="ours-h">Our services</h1>
        <Status kind="info">
          This workspace is for partner organizations. County staff manage every site, including
          those partners post, under Sites.
        </Status>
      </section>
    );

  const services = partner ? (rows ?? []) : [];
  const mine = (s: Service) => s.postedBy?.tenantId === me?.tenantId;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      if (editing) {
        await api(`/partner/sites/${editing.id}`, {
          method: 'PATCH',
          body: toBody(form),
          version: editing.version,
        });
        setMsg(`${form.name} saved.`);
      } else {
        await api('/partner/sites', { body: toBody(form) });
        setMsg(
          `${form.name} posted as a draft. Publish it when it is ready; it goes live at once on the county's public pages.`,
        );
      }
      setForm(blank);
      setEditing(null);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const act = async (s: Service, path: string, body: Record<string, unknown>, done: string) => {
    setMsg(null);
    try {
      await api(path, { body });
      setMsg(`${s.name}: ${done}.`);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const confirm = (s: Service, extra: Record<string, unknown>, done: string) =>
    act(s, `/sites/${s.id}/confirm`, { ...extra, note: note || undefined }, done);
  const toggle = (list: string[], key: string, on: boolean) =>
    on ? [...new Set([...list, key])] : list.filter((k) => k !== key);

  return (
    <section aria-labelledby="ours-h">
      <h1 id="ours-h">Our services</h1>
      <p>
        Post the shelter, feeding site, POD or other service your organization runs. Your approver
        publishes it on the county’s Find help page, its feeds and its text replies at once, with a
        reason; the county is told and can edit or withdraw it. A confidential site is never
        published. Confirm each service within its window, or it is hidden until you do.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      <Field
        label="Note for the next confirmation"
        hint="Optional; it goes into the county's audit log with the confirmation."
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <DataTable
        caption="Services your organization runs"
        rows={services}
        rowKey={(s) => s.id}
        empty={rows === null ? 'Loading…' : 'No services yet. Post one below.'}
        columns={[
          {
            key: 'name',
            header: 'Service',
            render: (s) =>
              `${s.name}${s.confidential ? ' (confidential)' : ''}${mine(s) ? '' : ' (county site you run)'}`,
          },
          { key: 'kind', header: 'Kind', render: (s) => label(s.kind) },
          {
            key: 'status',
            header: 'Status',
            render: (s) => <span className={`badge badge-${s.status}`}>{label(s.status)}</span>,
          },
          {
            key: 'where',
            header: 'Address',
            render: (s) =>
              [s.address?.line1, s.address?.city, s.address?.postal].filter(Boolean).join(', ') ||
              '—',
          },
          {
            key: 'cap',
            header: 'Occupancy',
            render: (s) => (s.capacity !== null ? `${s.occupancy ?? '—'} / ${s.capacity}` : '—'),
          },
          {
            key: 'pub',
            header: 'Public',
            render: (s) =>
              s.published ? (
                s.stale ? (
                  <span className="badge badge-full">
                    hidden: confirm due {fmt(s.confirmDueAt)}
                  </span>
                ) : (
                  `published ${fmt(s.publishedAt)}`
                )
              ) : (
                'not published'
              ),
          },
          { key: 'confirmed', header: 'Last confirmed', render: (s) => fmt(s.lastConfirmedAt) },
          {
            key: 'act',
            header: 'Actions',
            render: (s) => (
              <span className="actions">
                <button
                  type="button"
                  aria-label={`Confirm ${s.name}`}
                  onClick={() => confirm(s, {}, 'confirmed')}
                >
                  Confirm
                </button>
                {s.status !== 'full' ? (
                  <button
                    type="button"
                    aria-label={`Full: ${s.name}`}
                    onClick={() => confirm(s, { status: 'full' }, 'marked full')}
                  >
                    Full
                  </button>
                ) : null}
                {s.status !== 'open' ? (
                  <button
                    type="button"
                    aria-label={`Open: ${s.name}`}
                    onClick={() => confirm(s, { status: 'open' }, 'marked open')}
                  >
                    Open
                  </button>
                ) : null}
                {mine(s) ? (
                  <button
                    type="button"
                    aria-label={`Edit ${s.name}`}
                    onClick={() => {
                      setEditing(s);
                      setForm(toForm(s));
                      document.getElementById('ours-form-h')?.focus();
                    }}
                  >
                    Edit
                  </button>
                ) : null}
                {mine(s) && !s.confidential ? (
                  s.published ? (
                    <button
                      type="button"
                      aria-label={`Withdraw ${s.name}…`}
                      onClick={() =>
                        act(
                          s,
                          `/partner/sites/${s.id}/unpublish`,
                          {},
                          'withdrawn from every channel',
                        )
                      }
                    >
                      Withdraw…
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      aria-label={`Publish ${s.name}…`}
                      onClick={() =>
                        act(s, `/partner/sites/${s.id}/publish`, {}, 'published on every channel')
                      }
                    >
                      Publish…
                    </button>
                  )
                ) : null}
              </span>
            ),
          },
        ]}
      />
      <h2 id="ours-form-h" tabIndex={-1}>
        {editing ? `Edit ${editing.name}` : 'Post a service'}
      </h2>
      <form onSubmit={save} className="form-grid" aria-labelledby="ours-form-h">
        <Field label="Kind">
          {({ id }) => (
            <select
              id={id}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Name" hint="As residents will see it, for example “Main Street canteen”.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          )}
        </Field>
        <Field label="Street address">
          {({ id }) => (
            <input
              id={id}
              value={form.line1}
              onChange={(e) => setForm({ ...form, line1: e.target.value })}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="City">
          {({ id }) => (
            <input
              id={id}
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
          )}
        </Field>
        <Field label="ZIP">
          {({ id }) => (
            <input
              id={id}
              value={form.postal}
              onChange={(e) => setForm({ ...form, postal: e.target.value })}
              inputMode="numeric"
            />
          )}
        </Field>
        <Field label="Latitude" hint="Optional; needed for nearest-first and the map.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.lat}
              onChange={(e) => setForm({ ...form, lat: e.target.value })}
              inputMode="decimal"
            />
          )}
        </Field>
        <Field label="Longitude">
          {({ id }) => (
            <input
              id={id}
              value={form.lon}
              onChange={(e) => setForm({ ...form, lon: e.target.value })}
              inputMode="decimal"
            />
          )}
        </Field>
        <Field label="Status">
          {({ id }) => (
            <select
              id={id}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Capacity">
          {({ id }) => (
            <input
              id={id}
              value={form.capacity}
              onChange={(e) => setForm({ ...form, capacity: e.target.value })}
              inputMode="numeric"
            />
          )}
        </Field>
        <Field label="Hours" hint="For example 11:00–19:00, or leave empty for 24 hours.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.hours}
              onChange={(e) => setForm({ ...form, hours: e.target.value })}
            />
          )}
        </Field>
        <Field label="What is offered" hint="Separate with commas, for example: hot meals, water.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.services}
              onChange={(e) => setForm({ ...form, services: e.target.value })}
            />
          )}
        </Field>
        <Field label="Pets">
          {({ id }) => (
            <select
              id={id}
              value={form.pets}
              onChange={(e) => setForm({ ...form, pets: e.target.value })}
            >
              <option value="unknown">Ask</option>
              <option value="yes">Pets welcome</option>
              <option value="service_animals">Service animals only</option>
              <option value="no">No pets</option>
            </select>
          )}
        </Field>
        <fieldset>
          <legend>Accessibility</legend>
          {ACCESS.map(([k, text]) => (
            <label key={k} className="inline">
              <input
                type="checkbox"
                checked={form.access.includes(k)}
                onChange={(e) =>
                  setForm({ ...form, access: toggle(form.access, k, e.target.checked) })
                }
              />{' '}
              {text}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Languages spoken on site</legend>
          {LANGS.map(([k, text]) => (
            <label key={k} className="inline">
              <input
                type="checkbox"
                checked={form.languages.includes(k)}
                onChange={(e) =>
                  setForm({ ...form, languages: toggle(form.languages, k, e.target.checked) })
                }
              />{' '}
              {text}
            </label>
          ))}
        </fieldset>
        <Field label="Notes for residents" hint="Plain words; never alert-style wording.">
          {({ id, describedBy }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Reconfirm every (hours)"
          hint="Past this, the service is hidden on every public channel until you confirm it (PUB-03)."
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.confirmEveryHours}
              onChange={(e) => setForm({ ...form, confirmEveryHours: e.target.value })}
              inputMode="numeric"
            />
          )}
        </Field>
        <Field
          label="Confidential"
          hint="For example a domestic-violence shelter: the county sees it, the public never does (PUB-05)."
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              type="checkbox"
              aria-describedby={describedBy}
              checked={form.confidential}
              onChange={(e) => setForm({ ...form, confidential: e.target.checked })}
            />
          )}
        </Field>
        <div className="actions">
          <button type="submit" className="primary">
            {editing ? 'Save changes' : 'Post as draft'}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setForm(blank);
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

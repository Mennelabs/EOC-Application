/**
 * The facility registry in the console (layer-7 task D; REC-01, REC-10,
 * SEC-18, WCAG 2.2 AA). Planners see every approved place with what is known
 * and what is not ("unknown" is shown, never guessed), when it was last
 * re-checked and whether it is stale; they confirm an entry is still right,
 * add a place (county EM enters it directly; others propose it) and change
 * one (others' changes wait for approval). Contacts appear only on the entry
 * itself, for roles that may see them, and the read is audited. County EM
 * decides the approval queue with a reason, never on their own proposal.
 */
import { useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';

interface Contact {
  name: string;
  role?: string;
  phone?: string;
  email?: string;
}
interface Facility {
  id: string;
  version: number;
  name: string;
  kind: string;
  address: { line1: string | null; city: string | null; postal: string | null } | null;
  sqft: number | null;
  ada: boolean | null;
  powerBackup: string | null;
  kitchen: boolean | null;
  showers: number | null;
  petPolicy: string | null;
  parkingSpaces: number | null;
  truckAccess: boolean | null;
  floodplain: string | null;
  mouStatus: string;
  communities: string[];
  notes: string | null;
  source: string;
  lastConfirmedAt: string;
  confirmDueAt: string;
  stale: boolean;
  unknown: string[];
  contacts: Contact[] | null;
}
interface Change {
  id: string;
  version: number;
  facilityName: string | null;
  change: string;
  proposed: Record<string, unknown>;
  source: string;
  createdAt: string;
}

const KINDS: [string, string][] = [
  ['school', 'School'],
  ['place_of_worship', 'Place of worship'],
  ['community_center', 'Community center'],
  ['parking_lot', 'Parking lot'],
  ['government', 'Government building'],
  ['commercial', 'Business'],
  ['other', 'Other'],
];
const kindName = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? k;
const yn = (v: boolean | null) => (v === null ? 'unknown' : v ? 'yes' : 'no');
const label = (s: string | null) => (s === null ? 'unknown' : s.replace(/_/g, ' '));
const words = (k: string) => k.replace(/([A-Z])/g, ' $1').toLowerCase();

const blank = {
  name: '',
  kind: 'school',
  line1: '',
  city: '',
  postal: '',
  sqft: '',
  ada: '',
  powerBackup: '',
  kitchen: '',
  showers: '',
  petPolicy: '',
  parkingSpaces: '',
  truckAccess: '',
  floodplain: '',
  mouStatus: 'none',
  communities: '',
  notes: '',
  contactName: '',
  contactPhone: '',
  contactEmail: '',
};
type Form = typeof blank;

const tri = (v: string) => (v === 'yes' ? true : v === 'no' ? false : null);
const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null);

function toBody(f: Form, withContacts: boolean) {
  return {
    name: f.name.trim(),
    kind: f.kind,
    address: { line1: f.line1 || null, city: f.city || null, postal: f.postal || null },
    sqft: int(f.sqft),
    ada: tri(f.ada),
    powerBackup: f.powerBackup || null,
    kitchen: tri(f.kitchen),
    showers: int(f.showers),
    petPolicy: f.petPolicy || null,
    parkingSpaces: int(f.parkingSpaces),
    truckAccess: tri(f.truckAccess),
    floodplain: f.floodplain || null,
    mouStatus: f.mouStatus,
    communities: f.communities
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    notes: f.notes || null,
    ...(withContacts && f.contactName
      ? {
          contacts: [
            {
              name: f.contactName,
              ...(f.contactPhone ? { phone: f.contactPhone } : {}),
              ...(f.contactEmail ? { email: f.contactEmail } : {}),
            },
          ],
        }
      : {}),
  };
}

const triOf = (v: boolean | null) => (v === null ? '' : v ? 'yes' : 'no');
function toForm(f: Facility): Form {
  const c = f.contacts?.[0];
  return {
    name: f.name,
    kind: f.kind,
    line1: f.address?.line1 ?? '',
    city: f.address?.city ?? '',
    postal: f.address?.postal ?? '',
    sqft: f.sqft !== null ? String(f.sqft) : '',
    ada: triOf(f.ada),
    powerBackup: f.powerBackup ?? '',
    kitchen: triOf(f.kitchen),
    showers: f.showers !== null ? String(f.showers) : '',
    petPolicy: f.petPolicy ?? '',
    parkingSpaces: f.parkingSpaces !== null ? String(f.parkingSpaces) : '',
    truckAccess: triOf(f.truckAccess),
    floodplain: f.floodplain ?? '',
    mouStatus: f.mouStatus,
    communities: f.communities.join(', '),
    notes: f.notes ?? '',
    contactName: c?.name ?? '',
    contactPhone: c?.phone ?? '',
    contactEmail: c?.email ?? '',
  };
}

export function Select({
  label: text,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  hint?: string;
}) {
  return (
    <Field label={text} {...(hint ? { hint } : {})}>
      {({ id, describedBy }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Text({
  label: text,
  value,
  onChange,
  hint,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  inputMode?: 'numeric' | 'email' | 'tel';
}) {
  return (
    <Field label={text} {...(hint ? { hint } : {})}>
      {({ id, describedBy }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          value={value}
          {...(inputMode ? { inputMode } : {})}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

const UNKNOWN: [string, string] = ['', 'Unknown'];
const YN: [string, string][] = [UNKNOWN, ['yes', 'Yes'], ['no', 'No']];

export function FacilitiesScreen() {
  const [kind, setKind] = useState('');
  const [staleOnly, setStaleOnly] = useState(false);
  const path = `/facilities?limit=200${kind ? `&kind=${kind}` : ''}${staleOnly ? '&stale=true' : ''}`;
  const { rows, error, reload } = useList<Facility>(path, [path]);
  const [open, setOpen] = useState<Facility | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [editing, setEditing] = useState<Facility | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof Form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const show = async (f: Facility) => {
    setMsg(null);
    try {
      setOpen(await api<Facility>(`/facilities/${f.id}`));
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const confirm = async (f: Facility) => {
    setMsg(null);
    try {
      const done = await api<Facility>(`/facilities/${f.id}/confirm`, {
        body: {},
        version: f.version,
      });
      setOpen(done.contacts ? done : { ...done, contacts: open?.contacts ?? null });
      setMsg(`${f.name}: confirmed as still right. Next re-check ${fmt(done.confirmDueAt)}.`);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const body = toBody(form, true);
      const out = editing
        ? await api<{ state?: string; name?: string }>(`/facilities/${editing.id}`, {
            method: 'PATCH',
            body,
            version: editing.version,
          })
        : await api<{ state?: string; name?: string }>('/facilities', { body });
      setMsg(
        out.state === 'pending'
          ? `${form.name}: sent for approval. County EM decides it in Facility approvals.`
          : `${form.name}: saved in the registry.`,
      );
      setForm(blank);
      setEditing(null);
      setOpen(null);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };

  return (
    <section aria-labelledby="fac-h">
      <h1 id="fac-h">Facility registry</h1>
      <p>
        Places the county could use for shelters, supply points or a recovery center, kept current
        all year. What is not known is marked unknown; recommendations never fill it in. Each entry
        is re-checked every 12 months.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      <div className="toolbar">
        <Select
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[['', 'All kinds'], ...KINDS]}
        />
        <label className="choice">
          <input
            type="checkbox"
            checked={staleOnly}
            onChange={(e) => setStaleOnly(e.target.checked)}
          />{' '}
          Only those past their re-check
        </label>
      </div>
      <DataTable
        caption="Facilities"
        rows={rows ?? []}
        rowKey={(f) => f.id}
        empty={rows ? 'No facility matches.' : 'Loading…'}
        columns={[
          {
            key: 'name',
            header: 'Name',
            render: (f) => (
              <button type="button" className="link" onClick={() => void show(f)}>
                {f.name}
              </button>
            ),
          },
          { key: 'kind', header: 'Kind', render: (f) => kindName(f.kind) },
          {
            key: 'sqft',
            header: 'Space (sq ft)',
            render: (f) => (f.sqft === null ? 'unknown' : f.sqft.toLocaleString()),
          },
          { key: 'ada', header: 'ADA', render: (f) => yn(f.ada) },
          { key: 'power', header: 'Backup power', render: (f) => label(f.powerBackup) },
          { key: 'agreement', header: 'Agreement', render: (f) => label(f.mouStatus) },
          {
            key: 'recheck',
            header: 'Re-check',
            render: (f) =>
              f.stale ? `Stale since ${fmt(f.confirmDueAt)}` : `Due ${fmt(f.confirmDueAt)}`,
          },
          {
            key: 'unknown',
            header: 'Unknown',
            render: (f) => (f.unknown.length ? f.unknown.map(words).join(', ') : 'nothing'),
          },
        ]}
      />

      {open ? (
        <section aria-labelledby="fac-one">
          <h2 id="fac-one">{open.name}</h2>
          <dl className="meta">
            <dt>Address</dt>
            <dd>
              {[open.address?.line1, open.address?.city, open.address?.postal]
                .filter(Boolean)
                .join(', ') || 'unknown'}
            </dd>
            <dt>Kitchen</dt>
            <dd>{yn(open.kitchen)}</dd>
            <dt>Showers</dt>
            <dd>{open.showers ?? 'unknown'}</dd>
            <dt>Pets</dt>
            <dd>{label(open.petPolicy)}</dd>
            <dt>Parking spaces</dt>
            <dd>{open.parkingSpaces ?? 'unknown'}</dd>
            <dt>Semi-truck access</dt>
            <dd>{yn(open.truckAccess)}</dd>
            <dt>Floodplain</dt>
            <dd>
              {open.floodplain === null
                ? 'unknown'
                : open.floodplain === 'in'
                  ? 'inside'
                  : 'outside'}
            </dd>
            <dt>Communities that use it</dt>
            <dd>{open.communities.join(', ') || '—'}</dd>
            <dt>Contacts</dt>
            <dd>
              {open.contacts === null
                ? 'Not shown for your role.'
                : open.contacts.length
                  ? open.contacts
                      .map((c) => [c.name, c.role, c.phone, c.email].filter(Boolean).join(', '))
                      .join('; ')
                  : 'None recorded.'}
            </dd>
            <dt>Last re-checked</dt>
            <dd>{fmt(open.lastConfirmedAt)}</dd>
          </dl>
          <div className="actions">
            <button type="button" onClick={() => void confirm(open)}>
              Confirm {open.name} is still right
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(open);
                setForm(toForm(open));
              }}
            >
              Change {open.name}
            </button>
          </div>
        </section>
      ) : null}

      <form onSubmit={(e) => void save(e)} aria-labelledby="fac-form">
        <h2 id="fac-form">{editing ? `Change ${editing.name}` : 'Add a facility'}</h2>
        <p>
          Leave anything you do not know as unknown. County EM saves directly; others send it for
          approval.
        </p>
        <Text label="Name" value={form.name} onChange={set('name')} />
        <Select label="Kind of place" value={form.kind} onChange={set('kind')} options={KINDS} />
        <Text label="Street address" value={form.line1} onChange={set('line1')} />
        <Text label="City" value={form.city} onChange={set('city')} />
        <Text label="ZIP code" value={form.postal} onChange={set('postal')} inputMode="numeric" />
        <Text
          label="Usable space (square feet)"
          value={form.sqft}
          onChange={set('sqft')}
          inputMode="numeric"
        />
        <Select label="ADA-accessible" value={form.ada} onChange={set('ada')} options={YN} />
        <Select
          label="Backup power"
          value={form.powerBackup}
          onChange={set('powerBackup')}
          options={[
            UNKNOWN,
            ['none', 'None'],
            ['generator', 'Generator'],
            ['transfer_switch', 'Transfer switch'],
          ]}
        />
        <Select label="Kitchen" value={form.kitchen} onChange={set('kitchen')} options={YN} />
        <Text label="Showers" value={form.showers} onChange={set('showers')} inputMode="numeric" />
        <Select
          label="Pets"
          value={form.petPolicy}
          onChange={set('petPolicy')}
          options={[
            UNKNOWN,
            ['none', 'No animals'],
            ['service_animals', 'Service animals only'],
            ['pets_inside', 'Pets inside'],
            ['pets_outside_area', 'Pets in an outside area'],
          ]}
        />
        <Text
          label="Parking spaces"
          value={form.parkingSpaces}
          onChange={set('parkingSpaces')}
          inputMode="numeric"
        />
        <Select
          label="Semi-truck access"
          value={form.truckAccess}
          onChange={set('truckAccess')}
          options={YN}
        />
        <Select
          label="Floodplain"
          value={form.floodplain}
          onChange={set('floodplain')}
          options={[UNKNOWN, ['out', 'Outside'], ['in', 'Inside']]}
        />
        <Select
          label="Use agreement"
          value={form.mouStatus}
          onChange={set('mouStatus')}
          options={[
            ['none', 'None'],
            ['pending', 'Pending'],
            ['signed', 'Signed'],
            ['expired', 'Expired'],
          ]}
        />
        <Text
          label="Communities that use it"
          hint="Separate with commas."
          value={form.communities}
          onChange={set('communities')}
        />
        <Text label="Notes" value={form.notes} onChange={set('notes')} />
        <Text label="Contact name" value={form.contactName} onChange={set('contactName')} />
        <Text
          label="Contact phone"
          value={form.contactPhone}
          onChange={set('contactPhone')}
          inputMode="tel"
        />
        <Text
          label="Contact email"
          value={form.contactEmail}
          onChange={set('contactEmail')}
          inputMode="email"
        />
        <div className="actions">
          {editing ? (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setForm(blank);
              }}
            >
              Cancel the change
            </button>
          ) : null}
          <button type="submit" className="primary" disabled={!form.name.trim()}>
            {editing ? 'Save the change' : 'Add the facility'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function FacilityApprovalsScreen() {
  const { rows, error, reload } = useList<Change>('/facility-changes?limit=100');
  const [open, setOpen] = useState<Change | null>(null);
  const [decision, setDecision] = useState('approve');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const decide = async (e: FormEvent) => {
    e.preventDefault();
    if (!open) return;
    setMsg(null);
    try {
      await api(`/facility-changes/${open.id}/decision`, {
        body: { decision, reason },
        version: open.version,
      });
      setMsg(
        `${open.facilityName ?? 'Proposal'}: ${decision === 'approve' ? 'approved' : 'rejected'}.`,
      );
      setOpen(null);
      setReason('');
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };

  return (
    <section aria-labelledby="facq-h">
      <h1 id="facq-h">Facility approvals</h1>
      <p>
        Places proposed by the COAD, partners and staff, and offers from the public form. Nothing
        enters the registry until someone other than the proposer approves it, with a reason.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      <DataTable
        caption="Proposals waiting for a decision"
        rows={rows ?? []}
        rowKey={(c) => c.id}
        empty={rows ? 'Nothing is waiting.' : 'Loading…'}
        columns={[
          { key: 'name', header: 'Facility', render: (c) => c.facilityName ?? '—' },
          { key: 'change', header: 'Change', render: (c) => c.change },
          { key: 'source', header: 'From', render: (c) => c.source.replace(/_/g, ' ') },
          {
            key: 'what',
            header: 'Proposed',
            render: (c) =>
              Object.entries(c.proposed)
                .filter(
                  ([k, v]) =>
                    k !== 'name' && v !== null && v !== undefined && typeof v !== 'object',
                )
                .map(([k, v]) => `${words(k)}: ${String(v)}`)
                .join('; ') || '—',
          },
          { key: 'when', header: 'Received', render: (c) => fmt(c.createdAt) },
          {
            key: 'act',
            header: 'Decide',
            render: (c) => (
              <button type="button" onClick={() => setOpen(c)}>
                Decide {c.facilityName ?? 'proposal'}
              </button>
            ),
          },
        ]}
      />
      {open ? (
        <form onSubmit={(e) => void decide(e)} aria-labelledby="facq-form">
          <h2 id="facq-form">Decide {open.facilityName ?? 'the proposal'}</h2>
          <Select
            label="Decision"
            value={decision}
            onChange={setDecision}
            options={[
              ['approve', 'Approve'],
              ['reject', 'Reject'],
            ]}
          />
          <Text
            label="Reason for the decision"
            hint="Recorded with your name."
            value={reason}
            onChange={setReason}
          />
          <div className="actions">
            <button type="button" onClick={() => setOpen(null)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={reason.trim().length < 3}>
              Record the decision
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

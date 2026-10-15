/**
 * Needs board and partner workspace (plan console screens 5–6; CON-08,
 * CON-15, NED-04, NED-07, AC-17B/C, FL-10, FL-11): open, claimed, in
 * progress and met needs with filters; claim, assign, release, done and
 * reopen with a note; overlap warnings when another organization holds a
 * claim nearby; who holds a claim as the county configured; CSV export with
 * confirmation. The partner workspace shows what a grant covers: the
 * consented records (only the sections granted), the organization's claims,
 * referrals in and out, and "send an update" to the resident.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, describeFailure, download } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';
import { useOpenDraft, useRecordChanged, useScreenRecord } from '../ui/screen-record.ts';

export interface Need {
  id: string;
  version: number;
  reportId: string | null;
  referenceCode: string | null;
  eventId: string | null;
  category: string;
  status: string;
  source: string;
  detail: string | null;
  area: { city: string | null; postal: string | null } | null;
  address: { line1: string | null; city: string | null; postal: string | null } | null;
  claimed: boolean;
  claim: {
    tenantId: string;
    tenantName: string;
    accountId: string | null;
    at: string | null;
  } | null;
  sharedWith: { tenantId: string; name: string }[];
  doneAt: string | null;
  doneNote: string | null;
  createdAt: string;
}
interface Warning {
  kind: string;
  needId: string;
  category: string;
  claimedByTenantName: string | null;
}
interface ActionResult {
  need: Need;
  warnings: Warning[];
}

const STATUSES = ['open', 'claimed', 'in_progress', 'met', 'closed'] as const;
const CATEGORIES = [
  'shelter_tonight',
  'food_water',
  'cleanup_tarp',
  'medical_power',
  'transportation',
  'pets',
  'someone_to_talk',
  'other',
];
const label = (s: string) => s.replace(/_/g, ' ');

/** One need's actions; which ones apply follows its status and who holds it. */
function NeedActions({
  need,
  mine,
  county,
  onResult,
}: {
  need: Need;
  mine: boolean;
  county: boolean;
  onResult: (r: ActionResult, verb: string) => void;
}) {
  const [note, setNote] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const noteBox = useRef<HTMLInputElement>(null);
  // CMD-29, AC-C09: a typed note is unsaved work the command window asks about.
  useOpenDraft({ kind: 'need', id: need.id }, note.trim().length > 0, 'the note', {
    focus: () => noteBox.current?.focus(),
    discard: () => setNote(''),
  });
  const act = async (verb: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      onResult(await api<ActionResult>(`/needs/${need.id}/${verb}`, { body }), verb);
      setNote('');
    } catch (err) {
      setError(describeFailure(err));
    }
  };
  const holdsIt = need.claim ? mine : false;
  return (
    <div className="need-actions">
      <Field label="Note" hint="Goes into the need's history.">
        {({ id, describedBy }) => (
          <input
            ref={noteBox}
            id={id}
            aria-describedby={describedBy}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <div className="actions">
        {need.status === 'open' || (need.claimed && !holdsIt && county) ? (
          <button type="button" onClick={() => act('claim', { note })}>
            Claim
          </button>
        ) : null}
        {county && need.sharedWith.length > 0 && need.status !== 'met' ? (
          <>
            <label className="inline">
              Assign to
              <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                <option value="">Choose a partner…</option>
                {need.sharedWith.map((p) => (
                  <option key={p.tenantId} value={p.tenantId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!assignTo}
              onClick={() => act('assign', { toTenantId: assignTo, note })}
            >
              Assign
            </button>
          </>
        ) : null}
        {need.claimed && (holdsIt || county) && need.status !== 'met' ? (
          <button type="button" onClick={() => act('release', { note })}>
            Release
          </button>
        ) : null}
        {need.status !== 'met' && (holdsIt || county) ? (
          <button
            type="button"
            className="primary"
            disabled={note.trim().length < 3}
            onClick={() => act('done', { note })}
          >
            Done
          </button>
        ) : null}
        {county && need.status === 'met' ? (
          <button
            type="button"
            disabled={note.trim().length < 3}
            onClick={() => act('reopen', { note })}
          >
            Reopen
          </button>
        ) : null}
      </div>
      {error ? <Status kind="error">{error}</Status> : null}
    </div>
  );
}

export function NeedsBoardScreen({ me }: { me: { tenantId: string; tenantKind?: string } | null }) {
  const [filters, setFilters] = useState({
    status: '',
    category: '',
    postal: '',
    source: '',
    reference: '',
  });
  const query = new URLSearchParams({ limit: '200' });
  for (const [k, v] of Object.entries(filters)) if (v) query.set(k, v);
  const { rows, error, reload } = useList<Need>(`/needs?${query}`);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const county = me?.tenantKind !== 'partner_org';
  const shown = open ? rows?.find((n) => n.id === open) : undefined;
  // CMD-06: the need whose panel is open is what "this" means in the command window.
  useScreenRecord(
    shown
      ? { kind: 'need', id: shown.id, label: shown.referenceCode ?? label(shown.category) }
      : null,
  );
  useRecordChanged('need', open, reload);
  const onResult = (r: ActionResult, verb: string) => {
    const warn = r.warnings.length
      ? ` Warning: ${r.warnings.map((w) => `${label(w.kind)} (${label(w.category)}${w.claimedByTenantName ? `, ${w.claimedByTenantName}` : ''})`).join('; ')}.`
      : '';
    const past: Record<string, string> = {
      claim: 'claimed',
      assign: 'assigned',
      release: 'released',
      done: 'marked done',
      reopen: 'reopened',
    };
    setNotice(`${label(r.need.category)} ${past[verb] ?? verb}.${warn}`);
    // The action is done: close its panel; the status line announces the result (CON-08).
    setOpen(null);
    reload();
  };
  const exportCsv = () => {
    download(`/needs.csv?${query}`, 'needs.csv').then(
      () => setNotice('Export downloaded; the export is in the audit log.'),
      (err: unknown) => setNotice(describeFailure(err)),
    );
  };
  return (
    <section aria-labelledby="needs-h">
      <h1 id="needs-h">Needs board</h1>
      <form className="toolbar filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          Status
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select
            value={filters.category}
            onChange={(e) => setFilters({ ...filters, category: e.target.value })}
          >
            <option value="">Any</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
        <label>
          ZIP
          <input
            value={filters.postal}
            onChange={(e) => setFilters({ ...filters, postal: e.target.value })}
            inputMode="numeric"
          />
        </label>
        <label>
          Reference
          <input
            value={filters.reference}
            onChange={(e) => setFilters({ ...filters, reference: e.target.value })}
          />
        </label>
        <label>
          Source
          <select
            value={filters.source}
            onChange={(e) => setFilters({ ...filters, source: e.target.value })}
          >
            <option value="">Any</option>
            <option value="report">With a damage report</option>
            <option value="standalone">Need only</option>
          </select>
        </label>
        {county ? (
          <button type="button" onClick={exportCsv}>
            Export CSV
          </button>
        ) : null}
      </form>
      {error ? <Status kind="error">{error}</Status> : null}
      {notice ? <Status kind="info">{notice}</Status> : null}
      <DataTable
        caption="Needs"
        rows={rows ?? []}
        rowKey={(n) => n.id}
        empty="No needs match."
        columns={[
          { key: 'ref', header: 'Reference', render: (n) => <code>{n.referenceCode ?? '—'}</code> },
          { key: 'cat', header: 'Need', render: (n) => label(n.category) },
          {
            key: 'status',
            header: 'Status',
            render: (n) => <span className={`badge badge-${n.status}`}>{label(n.status)}</span>,
          },
          {
            key: 'area',
            header: 'Area',
            render: (n) => [n.area?.city, n.area?.postal].filter(Boolean).join(' ') || '—',
          },
          {
            key: 'claim',
            header: 'Held by',
            render: (n) =>
              n.claim
                ? `${n.claim.tenantName}${n.claim.at ? ` since ${fmt(n.claim.at)}` : ''}`
                : n.claimed
                  ? 'claimed'
                  : '—',
          },
          {
            key: 'shared',
            header: 'Shared with',
            render: (n) => n.sharedWith.map((p) => p.name).join(', ') || '—',
          },
          {
            key: 'source',
            header: 'Source',
            render: (n) => (n.source === 'standalone' ? 'need only' : n.source),
          },
          {
            key: 'act',
            header: 'Actions',
            render: (n) => (
              <button
                type="button"
                className="link"
                aria-expanded={open === n.id}
                onClick={() => setOpen(open === n.id ? null : n.id)}
              >
                {open === n.id ? 'Close' : 'Act'}
              </button>
            ),
          },
        ]}
      />
      {open && rows?.find((n) => n.id === open) ? (
        <div className="panel">
          <h2>{label(rows.find((n) => n.id === open)!.category)}</h2>
          {rows.find((n) => n.id === open)!.detail ? (
            <p>{rows.find((n) => n.id === open)!.detail}</p>
          ) : null}
          <NeedActions
            need={rows.find((n) => n.id === open)!}
            mine={rows.find((n) => n.id === open)!.claim?.tenantId === me?.tenantId}
            county={county}
            onResult={onResult}
          />
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- partner

interface Shared {
  grantIds: string[];
  reportId: string;
  referenceCode: string | null;
  orgTypes: string[];
  sections: string[];
  maskedSections: string[];
  name: string | null;
  contact: { phone?: string; email?: string } | null;
  contactPreference: string | null;
  address: { line1?: string; city?: string; postal?: string } | null;
  area: { city?: string; postal?: string } | null;
  householdBand: string | null;
  needs: { id: string; category: string; status: string }[] | null;
  accessNeeds: string[] | null;
  grantedAt: string;
}
interface Referral {
  id: string;
  status: string;
  fromTenantName: string | null;
  toTenantName: string | null;
  toTenantId: string | null;
  fromTenantId: string;
  referenceCode: string | null;
  purpose: string;
  outcome: string | null;
  createdAt: string;
}

function SendUpdate({ reportId, onSent }: { reportId: string; onSent: (m: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ queued: boolean; channel: string | null; reason: string | null }>(
        `/reports/${reportId}/messages`,
        { body: { text } },
      );
      onSent(
        r.queued ? `Update queued by ${r.channel}.` : `Not sent: ${r.reason ?? 'no channel'}.`,
      );
      setText('');
    } catch (err) {
      setError(describeFailure(err));
    }
  };
  return (
    <form onSubmit={send} className="form-grid">
      <Field
        label="Update for the resident"
        hint="Plain words, no promises of aid or eligibility. Sent by text only with opt-in, else by email."
        {...(error ? { error } : {})}
      >
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={480}
            required
          />
        )}
      </Field>
      <div className="actions">
        <button type="submit" className="primary">
          Send update
        </button>
      </div>
    </form>
  );
}

export function PartnerScreen({ me }: { me: { tenantId: string } | null }) {
  const shared = useList<Shared>('/shared/reports?limit=200');
  const claims = useList<Need>(`/needs?limit=200${me ? `&claimedBy=${me.tenantId}` : ''}`);
  const referrals = useList<Referral>('/referrals?limit=200');
  const [notice, setNotice] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [referNote, setReferNote] = useState('');
  const respond = async (id: string, verb: 'accept' | 'decline' | 'done', note: string) => {
    try {
      const r = await api<Referral>(`/referrals/${id}/${verb}`, { body: { note } });
      const kept = note.trim() !== '' && verb !== 'accept' && r.outcome === null;
      // FL:FR-23: a legal aid organization's notes stay with it; only the status is shared.
      setNotice(
        `Referral ${verb === 'done' ? 'finished' : verb + 'ed'}.${kept ? ' Your note was not shared or stored: only the status reaches the referring organization.' : ''}`,
      );
      referrals.reload();
    } catch (err) {
      setNotice(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="partner-h">
      <h1 id="partner-h">Partner workspace</h1>
      <p>
        Only the sections each resident agreed to share with your organization are shown; every read
        is recorded.
      </p>
      {notice ? <Status kind="info">{notice}</Status> : null}
      <h2>Shared with your organization</h2>
      {shared.error ? <Status kind="error">{shared.error}</Status> : null}
      <DataTable
        caption="Consented records"
        rows={shared.rows ?? []}
        rowKey={(r) => r.reportId}
        empty="Nothing is shared with your organization right now."
        columns={[
          { key: 'ref', header: 'Reference', render: (r) => <code>{r.referenceCode ?? '—'}</code> },
          { key: 'name', header: 'Name', render: (r) => r.name ?? '—' },
          {
            key: 'contact',
            header: 'Contact',
            render: (r) => [r.contact?.phone, r.contact?.email].filter(Boolean).join(' · ') || '—',
          },
          {
            key: 'where',
            header: 'Where',
            render: (r) =>
              [
                r.address?.line1,
                r.address?.city ?? r.area?.city,
                r.address?.postal ?? r.area?.postal,
              ]
                .filter(Boolean)
                .join(', ') || '—',
          },
          {
            key: 'needs',
            header: 'Needs',
            render: (r) =>
              (r.needs ?? []).map((n) => `${label(n.category)} (${label(n.status)})`).join(', ') ||
              '—',
          },
          { key: 'band', header: 'Household', render: (r) => r.householdBand ?? '—' },
          {
            key: 'access',
            header: 'Access needs',
            render: (r) => (r.accessNeeds ?? []).map(label).join(', ') || '—',
          },
          { key: 'sections', header: 'Sections', render: (r) => r.sections.map(label).join(', ') },
          {
            key: 'act',
            header: 'Actions',
            render: (r) =>
              r.sections.includes('contact') ? (
                <button
                  type="button"
                  className="link"
                  aria-expanded={openReport === r.reportId}
                  onClick={() => setOpenReport(openReport === r.reportId ? null : r.reportId)}
                >
                  {openReport === r.reportId ? 'Close' : 'Send update'}
                </button>
              ) : null,
          },
        ]}
      />
      {openReport ? (
        <div className="panel">
          <h3>
            Send an update about{' '}
            {shared.rows?.find((r) => r.reportId === openReport)?.referenceCode}
          </h3>
          <SendUpdate reportId={openReport} onSent={setNotice} />
        </div>
      ) : null}
      <h2>Your claims</h2>
      {claims.error ? <Status kind="error">{claims.error}</Status> : null}
      <DataTable
        caption="Needs your organization holds"
        rows={claims.rows ?? []}
        rowKey={(n) => n.id}
        empty="Your organization holds no needs. Claim them on the needs board."
        columns={[
          { key: 'ref', header: 'Reference', render: (n) => <code>{n.referenceCode ?? '—'}</code> },
          { key: 'cat', header: 'Need', render: (n) => label(n.category) },
          { key: 'status', header: 'Status', render: (n) => label(n.status) },
          {
            key: 'area',
            header: 'Area',
            render: (n) => [n.area?.city, n.area?.postal].filter(Boolean).join(' ') || '—',
          },
          { key: 'since', header: 'Since', render: (n) => fmt(n.claim?.at) },
        ]}
      />
      <h2>Referrals</h2>
      {referrals.error ? <Status kind="error">{referrals.error}</Status> : null}
      <Field
        label="Note for the next referral action"
        hint="Why you accept, decline or finish; goes into the referral's history."
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            value={referNote}
            onChange={(e) => setReferNote(e.target.value)}
          />
        )}
      </Field>
      <DataTable
        caption="Referrals to and from your organization"
        rows={referrals.rows ?? []}
        rowKey={(r) => r.id}
        empty="No referrals."
        columns={[
          { key: 'ref', header: 'Reference', render: (r) => <code>{r.referenceCode ?? '—'}</code> },
          {
            key: 'dir',
            header: 'Direction',
            render: (r) =>
              r.toTenantId === me?.tenantId
                ? `In from ${r.fromTenantName ?? '—'}`
                : `Out to ${r.toTenantName ?? '—'}`,
          },
          { key: 'purpose', header: 'Purpose', render: (r) => r.purpose },
          { key: 'status', header: 'Status', render: (r) => r.status },
          { key: 'outcome', header: 'Outcome', render: (r) => r.outcome ?? '—' },
          {
            key: 'act',
            header: 'Actions',
            render: (r) =>
              r.toTenantId === me?.tenantId && r.status !== 'done' && r.status !== 'declined' ? (
                <span className="actions">
                  {r.status === 'open' ? (
                    <>
                      <button type="button" onClick={() => respond(r.id, 'accept', referNote)}>
                        Accept
                      </button>
                      <button
                        type="button"
                        disabled={referNote.trim().length < 3}
                        onClick={() => respond(r.id, 'decline', referNote)}
                      >
                        Decline
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="primary"
                    disabled={referNote.trim().length < 3}
                    onClick={() => respond(r.id, 'done', referNote)}
                  >
                    Done
                  </button>
                </span>
              ) : null,
          },
        ]}
      />
    </section>
  );
}

/** Key counts for the console home (CON-04) with their as-of time. */
export function KeyCounts() {
  const [counts, setCounts] = useState<{
    asOf: string;
    reports: { total: number; byState: Record<string, number>; danger: number };
    needs: { total: number; byStatus: Record<string, number>; standalone: number };
    sites: { byStatus: Record<string, number>; published: number };
    sharing: { activeGrants: number; partners: number };
    claims: { name: string; count: number }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<NonNullable<typeof counts>>('/dashboard/counts')
      .then(setCounts)
      .catch((e: unknown) => setError(describeFailure(e)));
  }, []);
  if (error) return null; // a role without the dashboard simply has no counts
  if (!counts) return <p role="status">Loading key counts…</p>;
  const cell = (n: number | undefined) => n ?? 0;
  return (
    <section aria-labelledby="counts-h" className="counts">
      <h2 id="counts-h">Key counts</h2>
      <p className="hint">As of {fmt(counts.asOf)}</p>
      <dl className="meta">
        <dt>Reports</dt>
        <dd>
          {counts.reports.total} ({cell(counts.reports.byState['submitted'])} new,{' '}
          {cell(counts.reports.byState['under_review'])} in review,{' '}
          {cell(counts.reports.byState['approved'])} approved, {counts.reports.danger} danger)
        </dd>
        <dt>Needs</dt>
        <dd>
          {counts.needs.total} ({cell(counts.needs.byStatus['open'])} open,{' '}
          {cell(counts.needs.byStatus['claimed'])} claimed, {cell(counts.needs.byStatus['met'])}{' '}
          met; {counts.needs.standalone} without a damage report)
        </dd>
        <dt>Sites</dt>
        <dd>
          {cell(counts.sites.byStatus['open'])} open, {cell(counts.sites.byStatus['full'])} full,{' '}
          {cell(counts.sites.byStatus['closed'])} closed; {counts.sites.published} published
        </dd>
        <dt>Sharing</dt>
        <dd>
          {counts.sharing.activeGrants} active grants with {counts.sharing.partners} partner
          organizations
        </dd>
        <dt>Claims by partner</dt>
        <dd>{counts.claims.map((c) => `${c.name}: ${c.count}`).join(', ') || 'none'}</dd>
      </dl>
    </section>
  );
}

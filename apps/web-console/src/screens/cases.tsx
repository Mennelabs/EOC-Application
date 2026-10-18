/**
 * Case work (FL-13, FL-03, FL:FR-07, FL:FR-18, FL:FR-27; WCAG 2.2 AA). The
 * caseworker's cases: one case per household, opened on a report by its
 * reference code; help received with source, type and dollar value and the
 * duplication-of-benefits totals (dollars only for roles with the financial
 * category); the recovery plan of what is still unmet; appointments texted
 * to the survivor with the time and place, never the purpose; the day-30
 * hand-off to the long-term recovery group, and closing with a reason. A
 * partner organization sees the cases its grants reach, cut to the sections
 * the survivor consented to.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { StatTile, Tiles } from '@cg/ui';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

type CaseStatus = 'open' | 'handed_off' | 'closed';
type HelpSource =
  | 'fema_ia'
  | 'sba_loan'
  | 'insurance'
  | 'ngo_grant'
  | 'ltrg_commitment'
  | 'goods'
  | 'services'
  | 'other';
type PlanStatus = 'open' | 'in_progress' | 'met' | 'dropped';

interface Help {
  id: string;
  sourceKind: HelpSource;
  sourceName: string;
  helpType: string;
  description: string | null;
  amount: number | null;
  givenOn: string;
  recordedBy: string | null;
  recordedByTenant: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}
interface PlanItem {
  id: string;
  version: number;
  unmet: string;
  ownerName: string | null;
  ownerLabel: string | null;
  dueOn: string | null;
  status: PlanStatus;
  note: string | null;
}
interface Appointment {
  id: string;
  version: number;
  withLabel: string;
  place: string;
  startsAt: string;
  purpose: string | null;
  status: 'scheduled' | 'kept' | 'missed' | 'cancelled';
  noticeChannel: 'sms' | 'email' | null;
  noticeSent: boolean;
  reminderQueuedAt: string | null;
  reminderSent: boolean;
  cancelReason: string | null;
}
interface CaseSummary {
  id: string;
  version: number;
  reportId: string;
  referenceCode: string | null;
  eventName: string | null;
  status: CaseStatus;
  leadTenantName: string | null;
  leadIsYou: boolean;
  openedAt: string;
  openedBy: string | null;
  handedOffAt: string | null;
  handedOffToTenantName: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
  financialVisible: boolean;
  openPlanItems: number;
  helpEntries: number;
}
interface Case extends CaseSummary {
  helpReceived: Help[];
  recoveryPlan: PlanItem[];
  appointments: Appointment[];
}
interface Duplication {
  entries: number;
  entriesWithoutAmount: number;
  total: number;
  bySource: { sourceKind: HelpSource; entries: number; total: number }[];
  byType: { helpType: string; entries: number; total: number }[];
}

const STATUS: Record<CaseStatus, string> = {
  open: 'Open',
  handed_off: 'Handed off to long-term recovery',
  closed: 'Closed',
};
const SOURCE: Record<HelpSource, string> = {
  fema_ia: 'FEMA Individual Assistance',
  sba_loan: 'SBA disaster loan',
  insurance: 'Insurance',
  ngo_grant: 'Nonprofit grant',
  ltrg_commitment: 'Long-term recovery commitment',
  goods: 'Goods',
  services: 'Services',
  other: 'Other',
};
const PLAN: Record<PlanStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  met: 'Met',
  dropped: 'Dropped',
};
const APPT: Record<Appointment['status'], string> = {
  scheduled: 'Scheduled',
  kept: 'Kept',
  missed: 'Missed',
  cancelled: 'Cancelled',
};
const money = (n: number | null) =>
  n === null ? 'Not shown' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const EMPTY_HELP = {
  sourceKind: 'fema_ia' as HelpSource,
  sourceName: '',
  helpType: '',
  description: '',
  amount: '',
  givenOn: new Date().toISOString().slice(0, 10),
};
const EMPTY_PLAN = { unmet: '', ownerLabel: '', dueOn: '', note: '' };
const EMPTY_APPT = { withLabel: '', place: '', startsAt: '', purpose: '' };

export function CasesScreen() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [list, setList] = useState<CaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [filter, setFilter] = useState<'' | CaseStatus>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Case | null>(null);
  const [dup, setDup] = useState<Duplication | null>(null);
  const [code, setCode] = useState('');
  const [help, setHelp] = useState(EMPTY_HELP);
  const [plan, setPlan] = useState(EMPTY_PLAN);
  const [appt, setAppt] = useState(EMPTY_APPT);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setActions(me.actions))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, []);
  const can = (a: string) => actions?.includes(a) ?? false;
  // The detail shown is the one for the chosen case; a stale one is never shown for another.
  const shown = detail && detail.id === selected ? detail : null;
  const shownDup = shown ? dup : null;

  useEffect(() => {
    if (!actions?.includes('case.read')) return;
    let live = true;
    const q = filter ? `?status=${filter}` : '';
    api<{ items: CaseSummary[] }>(`/cases${q}`)
      .then((d) => live && (setList(d.items), setError(null)))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [actions, tick, filter]);

  useEffect(() => {
    if (!selected || !actions?.includes('case.read')) return;
    let live = true;
    api<Case>(`/cases/${selected}`)
      .then((c) => {
        if (!live) return;
        setDetail(c);
        if (c.financialVisible)
          api<Duplication>(`/cases/${selected}/duplication`)
            .then((d) => live && setDup(d))
            .catch(() => live && setDup(null));
        else setDup(null);
      })
      .catch((e: unknown) => live && setMsg({ kind: 'error', text: describeFailure(e) }));
    return () => {
      live = false;
    };
  }, [selected, actions, tick]);

  const run = async (work: () => Promise<string>) => {
    try {
      const text = await work();
      setMsg({ kind: 'success', text });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
    reload();
  };

  const openCase = (e: FormEvent) => {
    e.preventDefault();
    const ref = code.trim().toUpperCase();
    if (ref.length < 6) {
      setMsg({ kind: 'error', text: 'Enter the reference code on the report.' });
      return;
    }
    void run(async () => {
      const reports = await api<{ id: string; referenceCode: string }[]>(
        `/reports?reference=${encodeURIComponent(ref)}&includeWithdrawn=false`,
      );
      const report = reports.find((r) => r.referenceCode === ref) ?? reports[0];
      if (!report) throw new Error(`No report ${ref} in your county.`);
      const c = await api<Case>('/cases', { body: { reportId: report.id } });
      setSelected(c.id);
      setCode('');
      setFilter('');
      return c.helpEntries || c.openPlanItems
        ? `${ref} already has a case; it is open below.`
        : `A case is open on ${ref}.`;
    });
  };

  const addHelp = (e: FormEvent) => {
    e.preventDefault();
    if (!shown) return;
    void run(async () => {
      await api(`/cases/${shown.id}/help`, {
        body: {
          sourceKind: help.sourceKind,
          sourceName: help.sourceName.trim(),
          helpType: help.helpType.trim(),
          ...(help.description.trim() ? { description: help.description.trim() } : {}),
          amount: help.amount.trim() === '' ? null : Number(help.amount),
          givenOn: help.givenOn,
        },
      });
      setHelp(EMPTY_HELP);
      return 'Help received is logged. It can be voided with a reason, never changed.';
    });
  };

  const voidHelp = (h: Help) =>
    void run(async () => {
      await api(`/cases/${shown!.id}/help/${h.id}/void`, { method: 'POST' });
      return `The ${SOURCE[h.sourceKind]} entry is voided; it stays in the record as voided.`;
    });

  const addPlan = (e: FormEvent) => {
    e.preventDefault();
    if (!shown) return;
    void run(async () => {
      await api(`/cases/${shown.id}/plan`, {
        body: {
          unmet: plan.unmet.trim(),
          ...(plan.ownerLabel.trim() ? { ownerLabel: plan.ownerLabel.trim() } : {}),
          ...(plan.dueOn ? { dueOn: plan.dueOn } : {}),
          ...(plan.note.trim() ? { note: plan.note.trim() } : {}),
        },
      });
      setPlan(EMPTY_PLAN);
      return 'The unmet need is on the recovery plan.';
    });
  };

  const setPlanStatus = (item: PlanItem, status: PlanStatus) =>
    void run(async () => {
      await api(`/cases/${shown!.id}/plan/${item.id}`, {
        method: 'PATCH',
        body: { status },
        version: item.version,
      });
      return `"${item.unmet}" is ${PLAN[status].toLowerCase()}.`;
    });

  const schedule = (e: FormEvent) => {
    e.preventDefault();
    if (!shown) return;
    if (!appt.startsAt) {
      setMsg({ kind: 'error', text: 'Choose when the appointment is.' });
      return;
    }
    void run(async () => {
      const a = await api<Appointment>(`/cases/${shown.id}/appointments`, {
        body: {
          withLabel: appt.withLabel.trim(),
          place: appt.place.trim(),
          startsAt: new Date(appt.startsAt).toISOString(),
          ...(appt.purpose.trim() ? { purpose: appt.purpose.trim() } : {}),
        },
      });
      setAppt(EMPTY_APPT);
      return a.noticeChannel === 'sms'
        ? 'The appointment is scheduled; the survivor is texted the time and place, and reminded the day before.'
        : a.noticeChannel === 'email'
          ? 'The appointment is scheduled; the survivor is emailed the time and place (no text opt-in on file).'
          : 'The appointment is scheduled. The survivor left no opted-in phone or email, so tell them another way.';
    });
  };

  const apptStatus = (a: Appointment, status: 'kept' | 'missed' | 'cancelled') =>
    void run(async () => {
      const reason =
        status === 'cancelled' ? window.prompt('Why is the appointment cancelled?') : null;
      if (status === 'cancelled' && !(reason && reason.trim().length >= 3))
        throw new Error('Cancelling needs a reason of a few words.');
      await api(`/cases/${shown!.id}/appointments/${a.id}/status`, {
        method: 'POST',
        body: { status, ...(reason ? { reason: reason.trim() } : {}) },
        version: a.version,
      });
      return `The appointment with ${a.withLabel} is ${APPT[status].toLowerCase()}.`;
    });

  const close = () =>
    void run(async () => {
      await api(`/cases/${shown!.id}/close`, { method: 'POST', version: shown!.version });
      return `Case ${shown!.referenceCode ?? ''} is closed.`;
    });

  const setH = (k: keyof typeof EMPTY_HELP) => (e: { target: { value: string } }) =>
    setHelp({ ...help, [k]: e.target.value });
  const setP = (k: keyof typeof EMPTY_PLAN) => (e: { target: { value: string } }) =>
    setPlan({ ...plan, [k]: e.target.value });
  const setA = (k: keyof typeof EMPTY_APPT) => (e: { target: { value: string } }) =>
    setAppt({ ...appt, [k]: e.target.value });
  const writable = shown?.status === 'open' || shown?.status === 'handed_off';

  return (
    <section aria-labelledby="cases-h">
      <h1 id="cases-h">Case work</h1>
      <p>
        One case per household, on the report the survivor filed. Help received is logged with its
        source, type and dollar value and totalled so duplication of benefits is seen before FEMA,
        the SBA or a grant decides; an entry is voided with a reason, never changed. The recovery
        plan lists what is still unmet and who owns it. An appointment texts the survivor the time
        and place, never the purpose. After the county&rsquo;s hand-off period a case with the
        survivor&rsquo;s consent goes to the long-term recovery group. Dollar values show only to
        roles with the financial category.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {actions && !can('case.read') ? <p>You do not have access to case work.</p> : null}
      {can('case.read') && list === null && !error ? <p role="status">Loading cases…</p> : null}

      {can('case.open') ? (
        <form onSubmit={openCase} className="panel" aria-labelledby="case-open-h">
          <h2 id="case-open-h">Open a case</h2>
          <Field
            label="Reference code on the report"
            hint="The code the survivor was given. A report with a case already opens that case."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                required
              />
            )}
          </Field>
          <button type="submit">Open the case</button>
        </form>
      ) : null}

      {can('case.read') ? (
        <>
          <div className="toolbar">
            <Field label="Show">
              {({ id }) => (
                <select
                  id={id}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as '' | CaseStatus)}
                >
                  <option value="">All cases</option>
                  {(Object.keys(STATUS) as CaseStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS[s]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <DataTable
            caption="Cases"
            empty="No cases yet. Open one on a report by its reference code."
            rows={list ?? []}
            rowKey={(c) => c.id}
            columns={[
              { key: 'ref', header: 'Report', render: (c) => c.referenceCode ?? '—' },
              { key: 'status', header: 'Status', render: (c) => STATUS[c.status] },
              {
                key: 'lead',
                header: 'Lead organization',
                render: (c) => `${c.leadTenantName ?? '—'}${c.leadIsYou ? ' (yours)' : ''}`,
              },
              { key: 'opened', header: 'Opened', render: (c) => fmt(c.openedAt) },
              { key: 'help', header: 'Help entries', render: (c) => String(c.helpEntries) },
              { key: 'plan', header: 'Unmet items', render: (c) => String(c.openPlanItems) },
              {
                key: 'act',
                header: 'Actions',
                render: (c) => (
                  <button type="button" onClick={() => setSelected(c.id)}>
                    Open {c.referenceCode ?? 'case'}
                  </button>
                ),
              },
            ]}
          />
        </>
      ) : null}

      {shown ? (
        <article className="panel" aria-labelledby="case-detail-h">
          <h2 id="case-detail-h">Case {shown.referenceCode ?? ''}</h2>
          <dl className="pairs">
            <dt>Status</dt>
            <dd>{STATUS[shown.status]}</dd>
            <dt>Event</dt>
            <dd>{shown.eventName ?? '—'}</dd>
            <dt>Lead organization</dt>
            <dd>{shown.leadTenantName ?? '—'}</dd>
            <dt>Opened</dt>
            <dd>
              {fmt(shown.openedAt)}
              {shown.openedBy ? ` by ${shown.openedBy}` : ''}
            </dd>
            {shown.handedOffAt ? (
              <>
                <dt>Handed off</dt>
                <dd>
                  {fmt(shown.handedOffAt)} to{' '}
                  {shown.handedOffToTenantName ?? 'the long-term recovery group'}
                </dd>
              </>
            ) : null}
            {shown.closedAt ? (
              <>
                <dt>Closed</dt>
                <dd>
                  {fmt(shown.closedAt)}
                  {shown.closedBy ? ` by ${shown.closedBy}` : ''}: {shown.closeReason}
                </dd>
              </>
            ) : null}
          </dl>
          {shown.status !== 'closed' && can('case.close') ? (
            <p>
              <button type="button" onClick={close}>
                Close this case (with a reason)
              </button>
            </p>
          ) : null}

          <h3>Help received</h3>
          {!shown.financialVisible ? (
            <p className="hint">
              Dollar values are not shown to your role; the entries and their sources are.
            </p>
          ) : null}
          {shownDup ? (
            <Tiles>
              <StatTile
                label="Total help with a dollar value"
                value={money(shownDup.total)}
                detail={`${shownDup.entries} standing entries, ${shownDup.entriesWithoutAmount} without a value`}
              />
              {shownDup.bySource.map((x) => (
                <StatTile key={x.sourceKind} label={SOURCE[x.sourceKind]} value={money(x.total)} />
              ))}
            </Tiles>
          ) : null}
          <DataTable
            caption="Help received, newest first"
            empty="No help logged yet."
            rows={shown.helpReceived}
            rowKey={(h) => h.id}
            columns={[
              {
                key: 'source',
                header: 'Source',
                render: (h) => `${SOURCE[h.sourceKind]}: ${h.sourceName}`,
              },
              { key: 'type', header: 'Type', render: (h) => h.helpType },
              { key: 'amount', header: 'Dollar value', render: (h) => money(h.amount) },
              { key: 'given', header: 'Given on', render: (h) => h.givenOn },
              {
                key: 'by',
                header: 'Recorded by',
                render: (h) =>
                  `${h.recordedBy ?? '—'}${h.recordedByTenant ? ` (${h.recordedByTenant})` : ''}`,
              },
              {
                key: 'state',
                header: 'Standing',
                render: (h) =>
                  h.voidedAt
                    ? `Voided ${fmt(h.voidedAt)}${h.voidedBy ? ` by ${h.voidedBy}` : ''}: ${h.voidReason ?? ''}`
                    : 'Standing',
              },
              {
                key: 'act',
                header: 'Actions',
                render: (h) =>
                  !h.voidedAt && writable && can('help_received.void') ? (
                    <button type="button" onClick={() => voidHelp(h)}>
                      Void {SOURCE[h.sourceKind]} entry (with a reason)
                    </button>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          {writable && can('help_received.write') ? (
            <form onSubmit={addHelp} className="panel" aria-labelledby="help-form-h">
              <h4 id="help-form-h">Log help received</h4>
              <Field label="Source">
                {({ id }) => (
                  <select id={id} value={help.sourceKind} onChange={setH('sourceKind')}>
                    {(Object.keys(SOURCE) as HelpSource[]).map((s) => (
                      <option key={s} value={s}>
                        {SOURCE[s]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                label="Who gave it"
                hint="The organization's name as it appears on its letter or award."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={help.sourceName}
                    onChange={setH('sourceName')}
                    required
                  />
                )}
              </Field>
              <Field
                label="Type of help"
                hint="Such as rental assistance, structure claim advance, appliance grant."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={help.helpType}
                    onChange={setH('helpType')}
                    required
                  />
                )}
              </Field>
              <Field
                label="Dollar value (US dollars)"
                hint="Leave empty for goods or services without one."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    value={help.amount}
                    onChange={setH('amount')}
                  />
                )}
              </Field>
              <Field label="Given on">
                {({ id }) => (
                  <input
                    id={id}
                    type="date"
                    value={help.givenOn}
                    onChange={setH('givenOn')}
                    required
                  />
                )}
              </Field>
              <Field label="Notes">
                {({ id }) => (
                  <textarea
                    id={id}
                    rows={2}
                    value={help.description}
                    onChange={setH('description')}
                  />
                )}
              </Field>
              <button type="submit">Log it</button>
            </form>
          ) : null}

          <h3>Recovery plan</h3>
          <DataTable
            caption="What is still unmet"
            empty="Nothing on the plan yet."
            rows={shown.recoveryPlan}
            rowKey={(p) => p.id}
            columns={[
              { key: 'unmet', header: 'Unmet need', render: (p) => p.unmet },
              { key: 'owner', header: 'Owner', render: (p) => p.ownerName ?? p.ownerLabel ?? '—' },
              { key: 'due', header: 'Due', render: (p) => p.dueOn ?? '—' },
              { key: 'status', header: 'Status', render: (p) => PLAN[p.status] },
              { key: 'note', header: 'Note', render: (p) => p.note ?? '—' },
              {
                key: 'act',
                header: 'Actions',
                render: (p) =>
                  writable &&
                  can('recovery_plan.write') &&
                  (p.status === 'open' || p.status === 'in_progress') ? (
                    <span className="toolbar">
                      {p.status === 'open' ? (
                        <button type="button" onClick={() => setPlanStatus(p, 'in_progress')}>
                          Start "{p.unmet}"
                        </button>
                      ) : null}
                      <button type="button" onClick={() => setPlanStatus(p, 'met')}>
                        Mark "{p.unmet}" met
                      </button>
                      <button type="button" onClick={() => setPlanStatus(p, 'dropped')}>
                        Drop "{p.unmet}"
                      </button>
                    </span>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          {writable && can('recovery_plan.write') ? (
            <form onSubmit={addPlan} className="panel" aria-labelledby="plan-form-h">
              <h4 id="plan-form-h">Add an unmet need</h4>
              <Field label="What is unmet">
                {({ id }) => <input id={id} value={plan.unmet} onChange={setP('unmet')} required />}
              </Field>
              <Field
                label="Who owns it"
                hint="An organization or a person's role; the referral can follow."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={plan.ownerLabel}
                    onChange={setP('ownerLabel')}
                  />
                )}
              </Field>
              <Field label="Due by">
                {({ id }) => (
                  <input id={id} type="date" value={plan.dueOn} onChange={setP('dueOn')} />
                )}
              </Field>
              <Field label="Note">
                {({ id }) => (
                  <textarea id={id} rows={2} value={plan.note} onChange={setP('note')} />
                )}
              </Field>
              <button type="submit">Add to the plan</button>
            </form>
          ) : null}

          <h3>Appointments</h3>
          <DataTable
            caption="Appointments, latest first"
            empty="No appointments."
            rows={shown.appointments}
            rowKey={(a) => a.id}
            columns={[
              { key: 'when', header: 'When', render: (a) => fmt(a.startsAt) },
              { key: 'with', header: 'With', render: (a) => a.withLabel },
              { key: 'place', header: 'Where', render: (a) => a.place },
              { key: 'purpose', header: 'Purpose (never texted)', render: (a) => a.purpose ?? '—' },
              {
                key: 'notice',
                header: 'Survivor told',
                render: (a) =>
                  a.noticeChannel
                    ? `${a.noticeChannel === 'sms' ? 'Text' : 'Email'} ${a.noticeSent ? 'sent' : 'queued'}${a.reminderSent ? '; reminder sent' : a.reminderQueuedAt ? '; reminder queued' : ''}`
                    : 'No opted-in channel on file',
              },
              {
                key: 'status',
                header: 'Status',
                render: (a) => `${APPT[a.status]}${a.cancelReason ? `: ${a.cancelReason}` : ''}`,
              },
              {
                key: 'act',
                header: 'Actions',
                render: (a) =>
                  a.status === 'scheduled' && can('appointment.write') ? (
                    <span className="toolbar">
                      <button type="button" onClick={() => apptStatus(a, 'kept')}>
                        Kept
                      </button>
                      <button type="button" onClick={() => apptStatus(a, 'missed')}>
                        Missed
                      </button>
                      <button type="button" onClick={() => apptStatus(a, 'cancelled')}>
                        Cancel appointment with {a.withLabel}
                      </button>
                    </span>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          {writable && can('appointment.write') ? (
            <form onSubmit={schedule} className="panel" aria-labelledby="appt-form-h">
              <h4 id="appt-form-h">Schedule an appointment</h4>
              <p className="hint">
                The survivor is texted the time, the place and who it is with, in their language;
                the purpose stays here.
              </p>
              <Field
                label="With"
                hint="The organization or table, such as County Human Services or SBA."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={appt.withLabel}
                    onChange={setA('withLabel')}
                    required
                  />
                )}
              </Field>
              <Field label="Where">
                {({ id }) => <input id={id} value={appt.place} onChange={setA('place')} required />}
              </Field>
              <Field label="When">
                {({ id }) => (
                  <input
                    id={id}
                    type="datetime-local"
                    value={appt.startsAt}
                    onChange={setA('startsAt')}
                    required
                  />
                )}
              </Field>
              <Field label="Purpose (kept here, never texted)">
                {({ id }) => (
                  <textarea id={id} rows={2} value={appt.purpose} onChange={setA('purpose')} />
                )}
              </Field>
              <button type="submit">Schedule and tell the survivor</button>
            </form>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}

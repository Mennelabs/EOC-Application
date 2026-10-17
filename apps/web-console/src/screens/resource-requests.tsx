/**
 * Resource requests to the state (CON-13, the ICS 213 RR blocks; ADM-05 G4;
 * RULE-14; WCAG 2.2 AA). A section drafts a request for an event: what, how
 * many, where to deliver it, who asks and in which position, how urgent. It
 * is submitted with a reason, approved by a second person as section chief
 * (never the one who submitted it), placed by logistics with the state or
 * locally, then marked en route and received. Finance's reply and the cost
 * stay on the request; when the county sets a threshold, logistics cannot
 * place a request at or above it until finance has replied. Every step is
 * in the request's history with who and when.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

type RRStatus =
  'draft' | 'submitted' | 'approved' | 'placed' | 'en_route' | 'received' | 'cancelled';
type Priority = 'urgent' | 'high' | 'low';

interface Line {
  lineNo: number;
  quantity: number;
  unit: string | null;
  kind: string;
  type: string | null;
  description: string | null;
  eta: string | null;
  cost: number | null;
}
interface Step {
  step: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  stateTrackingNumber: string | null;
  occurredAt: string;
  actorKind: string;
  actorName: string | null;
}
interface RR {
  id: string;
  version: number;
  updatedAt: string;
  eventId: string;
  eventName: string | null;
  requestNumber: string;
  status: RRStatus;
  priority: Priority;
  supplyRequestId: string | null;
  deliveryLocation: string | null;
  requestedByName: string;
  requestedByPosition: string | null;
  substitutes: string | null;
  suggestedSources: string | null;
  notes: string | null;
  costEstimate: number | null;
  financeReply: string | null;
  financeRepliedAt: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  submittedByYou: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  placedAt: string | null;
  placedWith: 'state' | 'local' | null;
  stateTrackingNumber: string | null;
  supplier: string | null;
  logisticsOrderNumber: string | null;
  eta: string | null;
  arrivedAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  financeReplyNeeded: boolean;
  lines: Line[];
  steps: Step[];
}
interface EventRow {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'closed';
}

const STATUS: Record<RRStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted: waiting for approval',
  approved: 'Approved: waiting to be placed',
  placed: 'Placed',
  en_route: 'En route',
  received: 'Received',
  cancelled: 'Cancelled',
};
const PRIORITY: Record<Priority, string> = { urgent: 'Urgent', high: 'High', low: 'Low' };
const STEP: Record<string, string> = {
  drafted: 'Drafted',
  changed: 'Changed',
  submitted: 'Submitted',
  approved: 'Approved',
  finance_replied: 'Finance replied',
  placed: 'Placed',
  en_route: 'En route',
  received: 'Received',
  cancelled: 'Cancelled',
  state_update: 'Update from the state',
};

interface LineForm {
  quantity: string;
  unit: string;
  kind: string;
  type: string;
  description: string;
}
const EMPTY_LINE: LineForm = { quantity: '', unit: '', kind: '', type: '', description: '' };
const EMPTY = {
  eventId: '',
  priority: 'high' as Priority,
  deliveryLocation: '',
  requestedByPosition: '',
  costEstimate: '',
  substitutes: '',
  suggestedSources: '',
  notes: '',
};

const money = (n: number | null) =>
  n === null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });

export function ResourceRequestsScreen() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [list, setList] = useState<RR[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [filterEvent, setFilterEvent] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [f, setF] = useState(EMPTY);
  const [lines, setLines] = useState<LineForm[]>([{ ...EMPTY_LINE }]);
  const [editing, setEditing] = useState<RR | null>(null);
  const [placing, setPlacing] = useState<RR | null>(null);
  const [place, setPlace] = useState({
    with: 'state' as 'state' | 'local',
    stateTrackingNumber: '',
    supplier: '',
    logisticsOrderNumber: '',
    eta: '',
  });
  const [financeFor, setFinanceFor] = useState<RR | null>(null);
  const [financeReply, setFinanceReply] = useState('');
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setActions(me.actions))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    api<EventRow[]>('/events')
      .then((d) => live && setEvents(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const can = (a: string) => actions?.includes(a) ?? false;
  useEffect(() => {
    if (!actions?.includes('resource_request.read')) return;
    let live = true;
    const q = new URLSearchParams();
    if (filterEvent) q.set('eventId', filterEvent);
    if (filterStatus) q.set('status', filterStatus);
    api<RR[]>(`/resource-requests${q.size ? `?${q}` : ''}`)
      .then((d) => live && (setList(d), setError(null)))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [actions, tick, filterEvent, filterStatus]);

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const setLine = (i: number, k: keyof LineForm) => (e: { target: { value: string } }) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const bodyLines = lines
      .filter((l) => l.kind.trim())
      .map((l) => ({
        quantity: Number(l.quantity),
        kind: l.kind.trim(),
        ...(l.unit.trim() ? { unit: l.unit.trim() } : {}),
        ...(l.type.trim() ? { type: l.type.trim() } : {}),
        ...(l.description.trim() ? { description: l.description.trim() } : {}),
      }));
    if (bodyLines.some((l) => !(l.quantity > 0))) {
      setMsg({ kind: 'error', text: 'Each line needs a count above zero.' });
      return;
    }
    const header = {
      priority: f.priority,
      deliveryLocation: f.deliveryLocation.trim(),
      requestedByPosition: f.requestedByPosition.trim(),
      substitutes: f.substitutes.trim(),
      suggestedSources: f.suggestedSources.trim(),
      notes: f.notes.trim(),
      costEstimate: f.costEstimate.trim() === '' ? null : Number(f.costEstimate),
    };
    try {
      if (editing) {
        await api(`/resource-requests/${editing.id}`, {
          method: 'PATCH',
          body: { ...header, ...(bodyLines.length ? { lines: bodyLines } : {}) },
          version: editing.version,
        });
        setMsg({ kind: 'success', text: `${editing.requestNumber} saved. It is still a draft.` });
      } else {
        if (!f.eventId) {
          setMsg({ kind: 'error', text: 'Choose the event the request is for.' });
          return;
        }
        if (!bodyLines.length) {
          setMsg({ kind: 'error', text: 'Add at least one line: what is needed and how many.' });
          return;
        }
        const r = await api<RR>('/resource-requests', {
          body: { ...header, eventId: f.eventId, lines: bodyLines },
        });
        setMsg({
          kind: 'success',
          text: `${r.requestNumber} saved as a draft. Submit it with a reason when it is ready.`,
        });
        setSelected(r.id);
      }
      setF(EMPTY);
      setLines([{ ...EMPTY_LINE }]);
      setEditing(null);
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };

  const edit = (r: RR) => {
    setEditing(r);
    setF({
      eventId: r.eventId,
      priority: r.priority,
      deliveryLocation: r.deliveryLocation ?? '',
      requestedByPosition: r.requestedByPosition ?? '',
      costEstimate: r.costEstimate === null ? '' : String(r.costEstimate),
      substitutes: r.substitutes ?? '',
      suggestedSources: r.suggestedSources ?? '',
      notes: r.notes ?? '',
    });
    setLines(
      r.lines.length
        ? r.lines.map((l) => ({
            quantity: String(l.quantity),
            unit: l.unit ?? '',
            kind: l.kind,
            type: l.type ?? '',
            description: l.description ?? '',
          }))
        : [{ ...EMPTY_LINE }],
    );
    setMsg(null);
  };

  const failed = (err: unknown) => {
    if (err instanceof ApiFailure && err.status === 403)
      return 'A second person approves a request as section chief: never the one who submitted it.';
    if (err instanceof ApiFailure && err.status === 409 && /finance/i.test(err.message))
      return "This request's cost reaches the county's threshold: finance replies before it is placed.";
    return describeFailure(err);
  };

  const transition = async (r: RR, op: 'submit' | 'approve' | 'cancel') => {
    try {
      await api(`/resource-requests/${r.id}/${op}`, { method: 'POST', version: r.version });
      setMsg({
        kind: 'success',
        text:
          op === 'submit'
            ? `${r.requestNumber} is submitted. A second person approves it as section chief.`
            : op === 'approve'
              ? `${r.requestNumber} is approved. Logistics places it with the state or locally.`
              : `${r.requestNumber} is cancelled.`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: failed(err) });
    }
    reload();
  };

  const status = async (r: RR, to: 'en_route' | 'received') => {
    try {
      await api(`/resource-requests/${r.id}/status`, {
        method: 'POST',
        body: { status: to },
        version: r.version,
      });
      setMsg({
        kind: 'success',
        text:
          to === 'en_route'
            ? `${r.requestNumber} is en route.`
            : `${r.requestNumber} is received. Its history is complete.`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: failed(err) });
    }
    reload();
  };

  const submitPlace = async (e: FormEvent) => {
    e.preventDefault();
    if (!placing) return;
    try {
      await api(`/resource-requests/${placing.id}/place`, {
        method: 'POST',
        body: {
          with: place.with,
          ...(place.stateTrackingNumber.trim()
            ? { stateTrackingNumber: place.stateTrackingNumber.trim() }
            : {}),
          ...(place.supplier.trim() ? { supplier: place.supplier.trim() } : {}),
          ...(place.logisticsOrderNumber.trim()
            ? { logisticsOrderNumber: place.logisticsOrderNumber.trim() }
            : {}),
          ...(place.eta ? { eta: new Date(place.eta).toISOString() } : {}),
        },
        version: placing.version,
      });
      setMsg({
        kind: 'success',
        text: `${placing.requestNumber} is placed ${place.with === 'state' ? 'with the state' : 'locally'}.`,
      });
      setPlacing(null);
    } catch (err) {
      setMsg({ kind: 'error', text: failed(err) });
    }
    reload();
  };

  const submitFinance = async (e: FormEvent) => {
    e.preventDefault();
    if (!financeFor) return;
    try {
      await api(`/resource-requests/${financeFor.id}/finance`, {
        method: 'POST',
        body: { reply: financeReply.trim() },
        version: financeFor.version,
      });
      setMsg({ kind: 'success', text: `Finance's reply is on ${financeFor.requestNumber}.` });
      setFinanceFor(null);
      setFinanceReply('');
    } catch (err) {
      setMsg({ kind: 'error', text: failed(err) });
    }
    reload();
  };

  const detail = list?.find((r) => r.id === selected) ?? null;
  const open = (r: RR) =>
    ['draft', 'submitted', 'approved', 'placed', 'en_route'].includes(r.status);

  return (
    <section aria-labelledby="rr-h">
      <h1 id="rr-h">Resource requests</h1>
      <p>
        Requests to the state or a local supplier in the ICS 213 RR blocks: what is needed, how
        many, where to deliver it, who asks and how urgent. A section submits a request with a
        reason; a second person approves it as section chief, never the one who submitted it;
        logistics places it with the state and records the state&rsquo;s tracking number, then marks
        it en route and received. Every step is kept with who did it and when.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {actions && !can('resource_request.read') ? (
        <p>You do not have access to resource requests.</p>
      ) : null}
      {can('resource_request.read') && list === null && !error ? (
        <p role="status">Loading resource requests…</p>
      ) : null}

      {can('resource_request.write') ? (
        <form onSubmit={(e) => void save(e)} className="panel" aria-labelledby="rr-form-h">
          <h2 id="rr-form-h">
            {editing ? `Change ${editing.requestNumber}` : 'Draft a resource request'}
          </h2>
          {!editing ? (
            <Field label="Event">
              {({ id }) => (
                <select id={id} value={f.eventId} onChange={set('eventId')} required>
                  <option value="">Choose an event</option>
                  {events
                    .filter((ev) => ev.status !== 'closed')
                    .map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.name}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          ) : null}
          <Field label="Priority">
            {({ id }) => (
              <select id={id} value={f.priority} onChange={set('priority')}>
                {(Object.keys(PRIORITY) as Priority[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY[p]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Deliver or report to" hint="The site or address, and where on it.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={f.deliveryLocation}
                onChange={set('deliveryLocation')}
              />
            )}
          </Field>
          <Field
            label="Your position"
            hint="The ICS position you ask in, such as Mass Care Coordinator. Your roster position is used when this is empty."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={f.requestedByPosition}
                onChange={set('requestedByPosition')}
              />
            )}
          </Field>

          <fieldset>
            <legend>Lines: what is needed</legend>
            {lines.map((l, i) => (
              <div key={i} className="toolbar" role="group" aria-label={`Line ${i + 1}`}>
                <Field label={`Line ${i + 1} count`}>
                  {({ id }) => (
                    <input
                      id={id}
                      type="number"
                      min={0.01}
                      step="any"
                      inputMode="decimal"
                      value={l.quantity}
                      onChange={setLine(i, 'quantity')}
                      required={!!l.kind.trim()}
                    />
                  )}
                </Field>
                <Field label={`Line ${i + 1} unit`}>
                  {({ id }) => <input id={id} value={l.unit} onChange={setLine(i, 'unit')} />}
                </Field>
                <Field label={`Line ${i + 1} kind`}>
                  {({ id }) => <input id={id} value={l.kind} onChange={setLine(i, 'kind')} />}
                </Field>
                <Field label={`Line ${i + 1} type`}>
                  {({ id }) => <input id={id} value={l.type} onChange={setLine(i, 'type')} />}
                </Field>
                <Field label={`Line ${i + 1} description`}>
                  {({ id }) => (
                    <input id={id} value={l.description} onChange={setLine(i, 'description')} />
                  )}
                </Field>
                {lines.length > 1 ? (
                  <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                    Remove line {i + 1}
                  </button>
                ) : null}
              </div>
            ))}
            <p>
              <button type="button" onClick={() => setLines([...lines, { ...EMPTY_LINE }])}>
                Add a line
              </button>
            </p>
          </fieldset>

          <Field label="Cost estimate (US dollars)" hint="Finance sees it; leave empty if unknown.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={f.costEstimate}
                onChange={set('costEstimate')}
              />
            )}
          </Field>
          <Field label="Substitutes acceptable">
            {({ id }) => (
              <textarea id={id} rows={2} value={f.substitutes} onChange={set('substitutes')} />
            )}
          </Field>
          <Field label="Suggested sources">
            {({ id }) => (
              <textarea
                id={id}
                rows={2}
                value={f.suggestedSources}
                onChange={set('suggestedSources')}
              />
            )}
          </Field>
          <Field label="Notes">
            {({ id }) => <textarea id={id} rows={3} value={f.notes} onChange={set('notes')} />}
          </Field>
          <p>
            <button type="submit" className="primary">
              {editing ? 'Save the change' : 'Save the draft'}
            </button>{' '}
            {editing ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setF(EMPTY);
                  setLines([{ ...EMPTY_LINE }]);
                }}
              >
                Cancel the change
              </button>
            ) : null}
          </p>
        </form>
      ) : null}

      {list ? (
        <>
          <div className="toolbar">
            <Field label="Event">
              {({ id }) => (
                <select
                  id={id}
                  value={filterEvent}
                  onChange={(e) => setFilterEvent(e.target.value)}
                >
                  <option value="">Every event</option>
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Status">
              {({ id }) => (
                <select
                  id={id}
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                >
                  <option value="">Every status</option>
                  {(Object.keys(STATUS) as RRStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS[s]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <DataTable
            caption="Resource requests, most urgent first"
            rows={list}
            rowKey={(r) => r.id}
            empty="No resource requests for this choice."
            columns={[
              { key: 'n', header: 'Number', render: (r) => r.requestNumber },
              { key: 'e', header: 'Event', render: (r) => r.eventName ?? '—' },
              { key: 'p', header: 'Priority', render: (r) => PRIORITY[r.priority] },
              {
                key: 's',
                header: 'Status',
                render: (r) =>
                  STATUS[r.status] +
                  (r.status === 'placed' || r.status === 'en_route'
                    ? r.placedWith === 'state'
                      ? ` with the state${r.stateTrackingNumber ? ` (${r.stateTrackingNumber})` : ''}`
                      : ' locally'
                    : '') +
                  (r.financeReplyNeeded ? '; finance has not replied' : ''),
              },
              { key: 'd', header: 'Deliver to', render: (r) => r.deliveryLocation ?? '—' },
              {
                key: 'w',
                header: 'Requested by',
                render: (r) =>
                  `${r.requestedByName}${r.requestedByPosition ? `, ${r.requestedByPosition}` : ''}`,
              },
              { key: 'c', header: 'Cost', render: (r) => money(r.costEstimate) },
              { key: 'u', header: 'Last change', render: (r) => fmt(r.updatedAt) },
              {
                key: 'x',
                header: 'Action',
                render: (r) => (
                  <>
                    <button
                      type="button"
                      aria-pressed={selected === r.id}
                      onClick={() => setSelected(selected === r.id ? null : r.id)}
                    >
                      {selected === r.id ? 'Hide' : 'Show'} {r.requestNumber}
                    </button>
                    {can('resource_request.write') && r.status === 'draft' ? (
                      <>
                        {' '}
                        <button type="button" onClick={() => edit(r)}>
                          Change {r.requestNumber}
                        </button>
                      </>
                    ) : null}
                    {can('resource_request.submit') && r.status === 'draft' ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void transition(r, 'submit')}
                        >
                          Submit {r.requestNumber}
                        </button>
                      </>
                    ) : null}
                    {can('resource_request.approve') &&
                    r.status === 'submitted' &&
                    !r.submittedByYou ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void transition(r, 'approve')}
                        >
                          Approve {r.requestNumber}
                        </button>
                      </>
                    ) : null}
                    {can('resource_request.write') &&
                    ['draft', 'submitted', 'approved'].includes(r.status) &&
                    !r.financeReply ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          onClick={() => {
                            setFinanceFor(r);
                            setFinanceReply('');
                            setPlacing(null);
                          }}
                        >
                          Finance reply for {r.requestNumber}
                        </button>
                      </>
                    ) : null}
                    {can('resource_request.place') && r.status === 'approved' ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="primary"
                          onClick={() => {
                            setPlacing(r);
                            setFinanceFor(null);
                          }}
                        >
                          Place {r.requestNumber}
                        </button>
                      </>
                    ) : null}
                    {can('resource_request.write') && r.status === 'placed' ? (
                      <>
                        {' '}
                        <button type="button" onClick={() => void status(r, 'en_route')}>
                          {r.requestNumber} is en route
                        </button>
                      </>
                    ) : null}
                    {can('resource_request.write') && ['placed', 'en_route'].includes(r.status) ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void status(r, 'received')}
                        >
                          {r.requestNumber} is received
                        </button>
                      </>
                    ) : null}
                    {can('resource_request.cancel') && open(r) ? (
                      <>
                        {' '}
                        <button type="button" onClick={() => void transition(r, 'cancel')}>
                          Cancel {r.requestNumber}
                        </button>
                      </>
                    ) : null}
                  </>
                ),
              },
            ]}
          />
        </>
      ) : null}

      {placing ? (
        <form onSubmit={(e) => void submitPlace(e)} className="panel" aria-labelledby="rr-place-h">
          <h2 id="rr-place-h">Place {placing.requestNumber}</h2>
          {placing.financeReplyNeeded ? (
            <Status kind="error">
              This request&rsquo;s cost reaches the county&rsquo;s threshold: finance replies before
              it is placed.
            </Status>
          ) : null}
          <Field label="Placed with">
            {({ id }) => (
              <select
                id={id}
                value={place.with}
                onChange={(e) => setPlace({ ...place, with: e.target.value as 'state' | 'local' })}
              >
                <option value="state">The state</option>
                <option value="local">A local supplier</option>
              </select>
            )}
          </Field>
          <Field label="State tracking number" hint="As the state gives it; it can be added later.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={place.stateTrackingNumber}
                onChange={(e) => setPlace({ ...place, stateTrackingNumber: e.target.value })}
              />
            )}
          </Field>
          <Field label="Supplier">
            {({ id }) => (
              <input
                id={id}
                value={place.supplier}
                onChange={(e) => setPlace({ ...place, supplier: e.target.value })}
              />
            )}
          </Field>
          <Field label="Logistics order number">
            {({ id }) => (
              <input
                id={id}
                value={place.logisticsOrderNumber}
                onChange={(e) => setPlace({ ...place, logisticsOrderNumber: e.target.value })}
              />
            )}
          </Field>
          <Field label="Estimated arrival">
            {({ id }) => (
              <input
                id={id}
                type="datetime-local"
                value={place.eta}
                onChange={(e) => setPlace({ ...place, eta: e.target.value })}
              />
            )}
          </Field>
          <p>
            <button type="submit" className="primary">
              Place it
            </button>{' '}
            <button type="button" onClick={() => setPlacing(null)}>
              Cancel
            </button>
          </p>
        </form>
      ) : null}

      {financeFor ? (
        <form
          onSubmit={(e) => void submitFinance(e)}
          className="panel"
          aria-labelledby="rr-finance-h"
        >
          <h2 id="rr-finance-h">Finance&rsquo;s reply on {financeFor.requestNumber}</h2>
          <Field label="Reply" hint="Block 13 of the 213 RR: the funding line or the condition.">
            {({ id, describedBy }) => (
              <textarea
                id={id}
                aria-describedby={describedBy}
                rows={3}
                value={financeReply}
                onChange={(e) => setFinanceReply(e.target.value)}
                minLength={3}
                required
              />
            )}
          </Field>
          <p>
            <button type="submit" className="primary">
              Record the reply
            </button>{' '}
            <button type="button" onClick={() => setFinanceFor(null)}>
              Cancel
            </button>
          </p>
        </form>
      ) : null}

      {detail ? (
        <section className="panel" aria-labelledby="rr-detail-h">
          <h2 id="rr-detail-h">
            {detail.requestNumber}: {STATUS[detail.status]}
          </h2>
          <dl className="meta">
            <dt>Event</dt>
            <dd>{detail.eventName ?? '—'}</dd>
            <dt>Priority</dt>
            <dd>{PRIORITY[detail.priority]}</dd>
            <dt>Deliver or report to</dt>
            <dd>{detail.deliveryLocation ?? '—'}</dd>
            <dt>Requested by</dt>
            <dd>
              {detail.requestedByName}
              {detail.requestedByPosition ? `, ${detail.requestedByPosition}` : ''}
            </dd>
            <dt>Substitutes</dt>
            <dd>{detail.substitutes ?? '—'}</dd>
            <dt>Suggested sources</dt>
            <dd>{detail.suggestedSources ?? '—'}</dd>
            <dt>Notes</dt>
            <dd>{detail.notes ?? '—'}</dd>
            <dt>Cost estimate</dt>
            <dd>{money(detail.costEstimate)}</dd>
            <dt>Finance</dt>
            <dd>
              {detail.financeReply
                ? `${detail.financeReply} (${fmt(detail.financeRepliedAt)})`
                : detail.financeReplyNeeded
                  ? 'Reply needed before placing'
                  : 'No reply yet'}
            </dd>
            <dt>Submitted</dt>
            <dd>
              {detail.submittedBy ? `${detail.submittedBy}, ${fmt(detail.submittedAt)}` : '—'}
            </dd>
            <dt>Approved</dt>
            <dd>{detail.approvedBy ? `${detail.approvedBy}, ${fmt(detail.approvedAt)}` : '—'}</dd>
            <dt>Placed</dt>
            <dd>
              {detail.placedAt
                ? `${detail.placedWith === 'state' ? 'With the state' : 'Locally'}, ${fmt(detail.placedAt)}${
                    detail.stateTrackingNumber ? `; state number ${detail.stateTrackingNumber}` : ''
                  }${detail.supplier ? `; ${detail.supplier}` : ''}${
                    detail.logisticsOrderNumber ? `; order ${detail.logisticsOrderNumber}` : ''
                  }`
                : '—'}
            </dd>
            <dt>Estimated arrival</dt>
            <dd>{fmt(detail.eta)}</dd>
            <dt>Received</dt>
            <dd>{detail.receivedAt ? fmt(detail.arrivedAt ?? detail.receivedAt) : '—'}</dd>
            {detail.supplyRequestId ? (
              <>
                <dt>Raised from</dt>
                <dd>A site&rsquo;s supply request</dd>
              </>
            ) : null}
          </dl>
          <DataTable
            caption={`Lines on ${detail.requestNumber}`}
            rows={detail.lines}
            rowKey={(l) => String(l.lineNo)}
            empty="No lines."
            columns={[
              { key: 'n', header: 'Line', render: (l) => String(l.lineNo) },
              {
                key: 'q',
                header: 'Count',
                render: (l) => `${l.quantity}${l.unit ? ` ${l.unit}` : ''}`,
              },
              { key: 'k', header: 'Kind', render: (l) => l.kind },
              { key: 't', header: 'Type', render: (l) => l.type ?? '—' },
              { key: 'd', header: 'Description', render: (l) => l.description ?? '—' },
            ]}
          />
          <DataTable
            caption={`History of ${detail.requestNumber}`}
            rows={detail.steps}
            rowKey={(s) => `${s.step}-${s.occurredAt}`}
            empty="No steps yet."
            columns={[
              { key: 'w', header: 'When', render: (s) => fmt(s.occurredAt) },
              { key: 's', header: 'Step', render: (s) => STEP[s.step] ?? s.step },
              {
                key: 'a',
                header: 'By',
                render: (s) =>
                  s.actorName ??
                  (s.actorKind === 'api_key'
                    ? 'The state, through its key'
                    : s.actorKind === 'system'
                      ? 'The system'
                      : '—'),
              },
              {
                key: 'r',
                header: 'Reason or note',
                render: (s) =>
                  [s.reason, s.stateTrackingNumber ? `State number ${s.stateTrackingNumber}` : null]
                    .filter(Boolean)
                    .join('; ') || '—',
              },
            ]}
          />
          <p>
            Source: this organization&rsquo;s resource requests; last change {fmt(detail.updatedAt)}
            .
          </p>
        </section>
      ) : null}
    </section>
  );
}

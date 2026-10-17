/**
 * ICS forms (CON-13; ADM-05 G4; RULE-10; SEC-18; WCAG 2.2 AA): the
 * objectives of the operational period (ICS 202), general messages
 * (ICS 213: drafted, approved by a second person, sent, replied to), and the
 * forms as documents: pick a form and what it covers, preview it, issue it
 * frozen with its hash, and download the PDF or CSV of an issued form.
 * Forms name staff and positions, never residents.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure, download } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

interface EventRow {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'closed';
}
interface Objective {
  id: string;
  version: number;
  periodFrom: string;
  periodTo: string;
  position: number;
  objective: string;
  ownerPosition: string | null;
  status: 'open' | 'met' | 'dropped';
}
interface GM {
  id: string;
  version: number;
  messageNumber: string;
  status: 'draft' | 'approved' | 'sent' | 'replied' | 'cancelled';
  to: { name: string; position: string | null };
  from: { name: string; position: string | null };
  subject: string;
  body: string;
  writtenBy: string | null;
  writtenByYou: boolean;
  approvedBy: string | null;
  sentAt: string | null;
  reply: string | null;
  repliedBy: { name: string; position: string | null } | null;
  updatedAt: string;
}
interface FormKind {
  form: string;
  number: string;
  title: string;
  edition: string;
  scope: string;
}
interface Block {
  no: string;
  label: string;
  kind: 'value' | 'text' | 'table';
  value?: string | number | null;
  text?: string | null;
  columns?: string[];
  rows?: (string | number | null)[][];
}
interface Content {
  form: string;
  number: string;
  title: string;
  edition: string;
  incident: string;
  preparedBy: { name: string; position: string | null };
  preparedAt: string;
  blocks: Block[];
}
interface Issue {
  id: string;
  form: string;
  number: string;
  edition: string;
  sequence: number;
  title: string;
  contentHash: string;
  issuedAt: string;
  issuedBy: string | null;
}
interface Team {
  id: string;
  name: string;
  callsign: string | null;
}
interface RR {
  id: string;
  requestNumber: string;
  status: string;
}

const GM_STATUS: Record<GM['status'], string> = {
  draft: 'Draft: waiting for a second person to approve it',
  approved: 'Approved: ready to send',
  sent: 'Sent: waiting for the reply',
  replied: 'Replied',
  cancelled: 'Cancelled',
};
const OBJ_STATUS: Record<Objective['status'], string> = {
  open: 'Open',
  met: 'Met',
  dropped: 'Dropped',
};

/** A local date-time as a datetime-local input takes it. */
const local = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const periodStart = () => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() < 12 ? 0 : 12);
  return d;
};
const show = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '—' : String(v);

export function IcsFormsScreen() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventId, setEventId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  const [objectives, setObjectives] = useState<Objective[] | null>(null);
  const [objForm, setObjForm] = useState({
    periodFrom: local(periodStart()),
    periodTo: local(new Date(periodStart().getTime() + 12 * 3_600_000)),
    objective: '',
    ownerPosition: '',
  });
  const [messages, setMessages] = useState<GM[] | null>(null);
  const [gmForm, setGmForm] = useState({ toName: '', toPosition: '', subject: '', body: '' });
  const [replying, setReplying] = useState<GM | null>(null);
  const [replyText, setReplyText] = useState('');

  const [forms, setForms] = useState<FormKind[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [requests, setRequests] = useState<RR[]>([]);
  const [scope, setScope] = useState({
    form: 'ics_201',
    periodFrom: local(periodStart()),
    periodTo: local(new Date(periodStart().getTime() + 12 * 3_600_000)),
    generalMessageId: '',
    resourceRequestId: '',
    teamId: '',
    net: '',
  });
  const [preview, setPreview] = useState<Content | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);

  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setActions(me.actions))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    api<EventRow[]>('/events')
      .then((d) => {
        if (!live) return;
        setEvents(d);
        const first = d.find((e) => e.status === 'active') ?? d[0];
        if (first) setEventId((cur) => cur || first.id);
      })
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, []);
  const can = (a: string) => actions?.includes(a) ?? false;

  useEffect(() => {
    if (!actions || !eventId) return;
    let live = true;
    const q = `eventId=${eventId}`;
    if (actions.includes('incident_objective.read'))
      api<Objective[]>(`/incident-objectives?${q}`)
        .then((d) => live && setObjectives(d))
        .catch((e: unknown) => live && setError(describeFailure(e)));
    if (actions.includes('general_message.read'))
      api<GM[]>(`/general-messages?${q}&limit=100`)
        .then((d) => live && setMessages(d))
        .catch((e: unknown) => live && setError(describeFailure(e)));
    if (actions.includes('ics_form.read')) {
      api<FormKind[]>('/ics-forms')
        .then((d) => live && setForms(d))
        .catch((e: unknown) => live && setError(describeFailure(e)));
      api<Issue[]>(`/ics-forms/issues?${q}&limit=100`)
        .then((d) => live && setIssues(d))
        .catch((e: unknown) => live && setError(describeFailure(e)));
      api<Team[]>(`/teams?${q}&limit=200`)
        .then((d) => live && setTeams(d))
        .catch(() => undefined);
      api<RR[]>(`/resource-requests?${q}&limit=100`)
        .then((d) => live && setRequests(d))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [actions, eventId, tick]);

  const failed = (err: unknown) =>
    err instanceof ApiFailure && err.status === 403
      ? 'A second person approves a message: never the one who wrote it, and only with the approver grant.'
      : describeFailure(err);

  // ---------------------------------------------------------------- objectives
  const addObjective = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/incident-objectives', {
        body: {
          eventId,
          periodFrom: new Date(objForm.periodFrom).toISOString(),
          periodTo: new Date(objForm.periodTo).toISOString(),
          objective: objForm.objective.trim(),
          ...(objForm.ownerPosition.trim() ? { ownerPosition: objForm.ownerPosition.trim() } : {}),
        },
      });
      setMsg({ kind: 'success', text: 'Objective added to the period.' });
      setObjForm({ ...objForm, objective: '', ownerPosition: '' });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const setObjective = async (o: Objective, status: Objective['status']) => {
    try {
      await api(`/incident-objectives/${o.id}`, {
        method: 'PATCH',
        body: { status },
        version: o.version,
      });
      setMsg({
        kind: 'success',
        text: `Objective ${o.position} is ${OBJ_STATUS[status].toLowerCase()}.`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
    reload();
  };

  // ---------------------------------------------------------------- general messages
  const draftMessage = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const m = await api<GM>('/general-messages', {
        body: {
          eventId,
          to: {
            name: gmForm.toName.trim(),
            ...(gmForm.toPosition.trim() ? { position: gmForm.toPosition.trim() } : {}),
          },
          subject: gmForm.subject.trim(),
          body: gmForm.body.trim(),
        },
      });
      setMsg({
        kind: 'success',
        text: `${m.messageNumber} drafted. Someone else approves it before it is sent.`,
      });
      setGmForm({ toName: '', toPosition: '', subject: '', body: '' });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const messageStep = async (m: GM, op: 'approve' | 'send' | 'cancel') => {
    try {
      await api(`/general-messages/${m.id}/${op}`, {
        method: 'POST',
        ...(op === 'send' ? { body: {} } : {}),
        version: m.version,
      });
      setMsg({
        kind: 'success',
        text:
          op === 'approve'
            ? `${m.messageNumber} is approved.`
            : op === 'send'
              ? `${m.messageNumber} is sent. Record the reply when it comes.`
              : `${m.messageNumber} is cancelled.`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: failed(err) });
    }
    reload();
  };
  const sendReply = async (e: FormEvent) => {
    e.preventDefault();
    if (!replying) return;
    try {
      await api(`/general-messages/${replying.id}/reply`, {
        method: 'POST',
        body: { reply: replyText.trim() },
        version: replying.version,
      });
      setMsg({ kind: 'success', text: `The reply is on ${replying.messageNumber}.` });
      setReplying(null);
      setReplyText('');
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
    reload();
  };

  // ---------------------------------------------------------------- forms
  const scopeBody = () => ({
    eventId,
    ...(['ics_201', 'ics_214', 'ics_309'].includes(scope.form)
      ? {
          periodFrom: new Date(scope.periodFrom).toISOString(),
          periodTo: new Date(scope.periodTo).toISOString(),
        }
      : {}),
    ...(scope.form === 'ics_213' && scope.generalMessageId
      ? { generalMessageId: scope.generalMessageId }
      : {}),
    ...(scope.form === 'ics_213rr' && scope.resourceRequestId
      ? { resourceRequestId: scope.resourceRequestId }
      : {}),
    ...(scope.form === 'ics_214' && scope.teamId ? { teamId: scope.teamId } : {}),
    ...(scope.form === 'ics_309' && scope.net.trim() ? { net: scope.net.trim() } : {}),
  });
  const doPreview = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setPreview(await api<Content>(`/ics-forms/${scope.form}/preview`, { body: scopeBody() }));
      setMsg(null);
    } catch (err) {
      setPreview(null);
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const doIssue = async () => {
    try {
      const i = await api<Issue>(`/ics-forms/${scope.form}/issue`, { body: scopeBody() });
      setMsg({
        kind: 'success',
        text: `${i.number} issue ${i.sequence} is frozen with its hash. Download it below.`,
      });
      setPreview(null);
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const get = async (i: Issue, format: 'pdf' | 'csv') => {
    try {
      await download(
        `/ics-forms/issues/${i.id}/${format}`,
        `${i.form.replace('_', '-')}-${i.sequence}.${format}`,
      );
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };

  const formKind = forms.find((f) => f.form === scope.form);
  const setS = (k: keyof typeof scope) => (e: { target: { value: string } }) =>
    setScope({ ...scope, [k]: e.target.value });
  const anyAccess =
    can('incident_objective.read') || can('general_message.read') || can('ics_form.read');

  return (
    <section aria-labelledby="ics-h">
      <h1 id="ics-h">ICS forms</h1>
      <p>
        The objectives of the operational period (ICS 202), general messages (ICS 213) and the forms
        as documents: the 201 incident briefing, 213, 213 RR, 214 activity log and 309
        communications log. A form is previewed, then issued: frozen with its hash and numbered,
        corrected only by a later issue. Forms name staff and their positions, never residents.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {actions && !anyAccess ? <p>You do not have access to ICS forms.</p> : null}
      {anyAccess ? (
        <div className="toolbar">
          <Field label="Event">
            {({ id }) => (
              <select id={id} value={eventId} onChange={(e) => setEventId(e.target.value)}>
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      ) : null}

      {can('incident_objective.read') ? (
        <section className="panel" aria-labelledby="ics-obj-h">
          <h2 id="ics-obj-h">Objectives of the operational period (ICS 202)</h2>
          {objectives === null ? (
            <p role="status">Loading objectives…</p>
          ) : (
            <DataTable
              caption="Objectives"
              rows={objectives}
              rowKey={(o) => o.id}
              empty="No objectives for the latest period yet."
              columns={[
                { key: 'n', header: 'No.', render: (o) => String(o.position) },
                { key: 'o', header: 'Objective', render: (o) => o.objective },
                { key: 'w', header: 'Owner', render: (o) => o.ownerPosition ?? '—' },
                {
                  key: 'p',
                  header: 'Period',
                  render: (o) => `${fmt(o.periodFrom)} to ${fmt(o.periodTo)}`,
                },
                { key: 's', header: 'Status', render: (o) => OBJ_STATUS[o.status] },
                {
                  key: 'x',
                  header: 'Action',
                  render: (o) =>
                    can('incident_objective.write') && o.status === 'open' ? (
                      <>
                        <button type="button" onClick={() => void setObjective(o, 'met')}>
                          Objective {o.position} met
                        </button>{' '}
                        <button type="button" onClick={() => void setObjective(o, 'dropped')}>
                          Drop objective {o.position}
                        </button>
                      </>
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
          )}
          {can('incident_objective.write') ? (
            <form onSubmit={(e) => void addObjective(e)} aria-labelledby="ics-obj-form-h">
              <h3 id="ics-obj-form-h">Add an objective</h3>
              <div className="toolbar">
                <Field label="Period from">
                  {({ id }) => (
                    <input
                      id={id}
                      type="datetime-local"
                      value={objForm.periodFrom}
                      onChange={(e) => setObjForm({ ...objForm, periodFrom: e.target.value })}
                      required
                    />
                  )}
                </Field>
                <Field label="Period to">
                  {({ id }) => (
                    <input
                      id={id}
                      type="datetime-local"
                      value={objForm.periodTo}
                      onChange={(e) => setObjForm({ ...objForm, periodTo: e.target.value })}
                      required
                    />
                  )}
                </Field>
              </div>
              <Field label="Objective">
                {({ id }) => (
                  <textarea
                    id={id}
                    rows={2}
                    value={objForm.objective}
                    onChange={(e) => setObjForm({ ...objForm, objective: e.target.value })}
                    minLength={3}
                    required
                  />
                )}
              </Field>
              <Field label="Owner (ICS position)">
                {({ id }) => (
                  <input
                    id={id}
                    value={objForm.ownerPosition}
                    onChange={(e) => setObjForm({ ...objForm, ownerPosition: e.target.value })}
                  />
                )}
              </Field>
              <p>
                <button type="submit" className="primary">
                  Add the objective
                </button>
              </p>
            </form>
          ) : null}
        </section>
      ) : null}

      {can('general_message.read') ? (
        <section className="panel" aria-labelledby="ics-gm-h">
          <h2 id="ics-gm-h">General messages (ICS 213)</h2>
          {messages === null ? (
            <p role="status">Loading general messages…</p>
          ) : (
            <DataTable
              caption="General messages"
              rows={messages}
              rowKey={(m) => m.id}
              empty="No general messages for this event."
              columns={[
                { key: 'n', header: 'Number', render: (m) => m.messageNumber },
                {
                  key: 't',
                  header: 'To',
                  render: (m) => `${m.to.name}${m.to.position ? `, ${m.to.position}` : ''}`,
                },
                {
                  key: 'f',
                  header: 'From',
                  render: (m) => `${m.from.name}${m.from.position ? `, ${m.from.position}` : ''}`,
                },
                { key: 's', header: 'Subject', render: (m) => m.subject },
                {
                  key: 'st',
                  header: 'Status',
                  render: (m) =>
                    GM_STATUS[m.status] +
                    (m.approvedBy ? ` (approved by ${m.approvedBy})` : '') +
                    (m.reply ? `: ${m.reply}` : ''),
                },
                { key: 'u', header: 'Last change', render: (m) => fmt(m.updatedAt) },
                {
                  key: 'x',
                  header: 'Action',
                  render: (m) => (
                    <>
                      {can('general_message.approve') && m.status === 'draft' && !m.writtenByYou ? (
                        <>
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void messageStep(m, 'approve')}
                          >
                            Approve {m.messageNumber}
                          </button>{' '}
                        </>
                      ) : null}
                      {can('general_message.send') && m.status === 'approved' ? (
                        <>
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void messageStep(m, 'send')}
                          >
                            Send {m.messageNumber}
                          </button>{' '}
                        </>
                      ) : null}
                      {can('general_message.write') && m.status === 'sent' ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setReplying(m);
                              setReplyText('');
                            }}
                          >
                            Reply to {m.messageNumber}
                          </button>{' '}
                        </>
                      ) : null}
                      {can('general_message.write') && ['draft', 'approved'].includes(m.status) ? (
                        <button type="button" onClick={() => void messageStep(m, 'cancel')}>
                          Cancel {m.messageNumber}
                        </button>
                      ) : null}
                      {m.status === 'cancelled' || m.status === 'replied' ? '—' : null}
                    </>
                  ),
                },
              ]}
            />
          )}
          {replying ? (
            <form onSubmit={(e) => void sendReply(e)} aria-labelledby="ics-reply-h">
              <h3 id="ics-reply-h">Reply to {replying.messageNumber}</h3>
              <Field label="Reply" hint="Recorded with your name and position (blocks 8 and 9).">
                {({ id, describedBy }) => (
                  <textarea
                    id={id}
                    aria-describedby={describedBy}
                    rows={3}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    required
                  />
                )}
              </Field>
              <p>
                <button type="submit" className="primary">
                  Record the reply
                </button>{' '}
                <button type="button" onClick={() => setReplying(null)}>
                  Cancel
                </button>
              </p>
            </form>
          ) : null}
          {can('general_message.write') ? (
            <form onSubmit={(e) => void draftMessage(e)} aria-labelledby="ics-gm-form-h">
              <h3 id="ics-gm-form-h">Draft a general message</h3>
              <div className="toolbar">
                <Field label="To (name)">
                  {({ id }) => (
                    <input
                      id={id}
                      value={gmForm.toName}
                      onChange={(e) => setGmForm({ ...gmForm, toName: e.target.value })}
                      required
                    />
                  )}
                </Field>
                <Field label="To (ICS position)">
                  {({ id }) => (
                    <input
                      id={id}
                      value={gmForm.toPosition}
                      onChange={(e) => setGmForm({ ...gmForm, toPosition: e.target.value })}
                    />
                  )}
                </Field>
              </div>
              <Field label="Subject">
                {({ id }) => (
                  <input
                    id={id}
                    value={gmForm.subject}
                    onChange={(e) => setGmForm({ ...gmForm, subject: e.target.value })}
                    required
                  />
                )}
              </Field>
              <Field label="Message">
                {({ id }) => (
                  <textarea
                    id={id}
                    rows={4}
                    value={gmForm.body}
                    onChange={(e) => setGmForm({ ...gmForm, body: e.target.value })}
                    required
                  />
                )}
              </Field>
              <p>
                <button type="submit" className="primary">
                  Save the draft
                </button>
              </p>
            </form>
          ) : null}
        </section>
      ) : null}

      {can('ics_form.read') ? (
        <section className="panel" aria-labelledby="ics-issue-h">
          <h2 id="ics-issue-h">Preview and issue a form</h2>
          <form onSubmit={(e) => void doPreview(e)}>
            <Field
              label="Form"
              {...(formKind
                ? { hint: `${formKind.edition}. Covers: ${formKind.scope.toLowerCase()}.` }
                : {})}
            >
              {({ id, describedBy }) => (
                <select
                  id={id}
                  aria-describedby={describedBy}
                  value={scope.form}
                  onChange={setS('form')}
                >
                  {forms.map((f) => (
                    <option key={f.form} value={f.form}>
                      {f.number} {f.title}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {['ics_201', 'ics_214', 'ics_309'].includes(scope.form) ? (
              <div className="toolbar">
                <Field label="Period from">
                  {({ id }) => (
                    <input
                      id={id}
                      type="datetime-local"
                      value={scope.periodFrom}
                      onChange={setS('periodFrom')}
                      required
                    />
                  )}
                </Field>
                <Field label="Period to">
                  {({ id }) => (
                    <input
                      id={id}
                      type="datetime-local"
                      value={scope.periodTo}
                      onChange={setS('periodTo')}
                      required
                    />
                  )}
                </Field>
              </div>
            ) : null}
            {scope.form === 'ics_213' ? (
              <Field label="General message">
                {({ id }) => (
                  <select
                    id={id}
                    value={scope.generalMessageId}
                    onChange={setS('generalMessageId')}
                    required
                  >
                    <option value="">Choose a message</option>
                    {(messages ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.messageNumber}: {m.subject}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            {scope.form === 'ics_213rr' ? (
              <Field label="Resource request">
                {({ id }) => (
                  <select
                    id={id}
                    value={scope.resourceRequestId}
                    onChange={setS('resourceRequestId')}
                    required
                  >
                    <option value="">Choose a request</option>
                    {requests.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.requestNumber} ({r.status.replace('_', ' ')})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            {scope.form === 'ics_214' ? (
              <Field label="Team">
                {({ id }) => (
                  <select id={id} value={scope.teamId} onChange={setS('teamId')} required>
                    <option value="">Choose a team</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.callsign ? ` (${t.callsign})` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            {scope.form === 'ics_309' ? (
              <Field label="Net" hint="Leave empty for every net of the period.">
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={scope.net}
                    onChange={setS('net')}
                  />
                )}
              </Field>
            ) : null}
            <p>
              <button type="submit">Preview the form</button>{' '}
              {can('ics_form.issue') ? (
                <button type="button" className="primary" onClick={() => void doIssue()}>
                  Issue the form
                </button>
              ) : null}
            </p>
          </form>
          {preview ? (
            <section className="panel" aria-labelledby="ics-preview-h">
              <h3 id="ics-preview-h">
                Preview: {preview.number} {preview.title}, {preview.incident}
              </h3>
              <p>
                {preview.edition}. Prepared by {preview.preparedBy.name}
                {preview.preparedBy.position ? `, ${preview.preparedBy.position}` : ''},{' '}
                {fmt(preview.preparedAt)}. Not issued.
              </p>
              <dl className="meta">
                {preview.blocks
                  .filter((b) => b.kind !== 'table')
                  .map((b) => (
                    <div key={b.no}>
                      <dt>
                        {b.no}. {b.label}
                      </dt>
                      <dd style={{ whiteSpace: 'pre-wrap' }}>
                        {show(b.kind === 'text' ? b.text : b.value)}
                      </dd>
                    </div>
                  ))}
              </dl>
              {preview.blocks
                .filter((b) => b.kind === 'table')
                .map((b) => (
                  <DataTable
                    key={b.no}
                    caption={`${b.no}. ${b.label}`}
                    rows={(b.rows ?? []).map((r, i) => ({ i, r }))}
                    rowKey={(x) => String(x.i)}
                    empty="None."
                    columns={(b.columns ?? []).map((c, ci) => ({
                      key: String(ci),
                      header: c,
                      render: (x: { r: (string | number | null)[] }) => show(x.r[ci]),
                    }))}
                  />
                ))}
            </section>
          ) : null}
        </section>
      ) : null}

      {can('ics_form.read') ? (
        <section className="panel" aria-labelledby="ics-issued-h">
          <h2 id="ics-issued-h">Issued forms</h2>
          {issues === null ? (
            <p role="status">Loading issued forms…</p>
          ) : (
            <DataTable
              caption="Issued forms, latest first"
              rows={issues}
              rowKey={(i) => i.id}
              empty="No forms issued for this event yet."
              columns={[
                { key: 't', header: 'Form', render: (i) => `${i.number} issue ${i.sequence}` },
                { key: 'e', header: 'Edition', render: (i) => i.edition },
                {
                  key: 'b',
                  header: 'Issued',
                  render: (i) => `${i.issuedBy ?? '—'}, ${fmt(i.issuedAt)}`,
                },
                { key: 'h', header: 'SHA-256', render: (i) => `${i.contentHash.slice(0, 12)}…` },
                {
                  key: 'x',
                  header: 'Download',
                  render: (i) =>
                    can('ics_form.export') ? (
                      <>
                        <button type="button" onClick={() => void get(i, 'pdf')}>
                          {i.number} issue {i.sequence} as PDF
                        </button>{' '}
                        <button type="button" onClick={() => void get(i, 'csv')}>
                          {i.number} issue {i.sequence} as CSV
                        </button>
                      </>
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
          )}
        </section>
      ) : null}
    </section>
  );
}

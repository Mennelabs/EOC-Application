/**
 * Job aids (FL-15, BRD:FR-18.03, ADM-05, WCAG 2.2 AA): the checklists,
 * damage matrices, standards and briefings field phones carry for each role
 * and language. Each is written as a draft and approved by someone other
 * than the last person to change it, with a reason; only approved aids reach
 * the phones. Changing an approved aid takes it off them until it is approved
 * again; retiring takes it off for good. Text is plain: "## " starts a
 * heading, "- " a list item, and a blank line separates paragraphs.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

interface Aid {
  id: string;
  version: number;
  key: string;
  roleKey: string | null;
  lang: string;
  kind: Kind;
  title: string;
  text: string;
  status: 'draft' | 'exercise_draft' | 'approved' | 'retired';
  onPhones: boolean;
  updatedAt: string;
  lastChangedBy: string | null;
  lastChangedByYou: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
}

type Kind = 'checklist' | 'matrix' | 'standard' | 'briefing' | 'guidance';
const KINDS: [Kind, string][] = [
  ['checklist', 'Checklist'],
  ['matrix', 'Damage matrix'],
  ['standard', 'Standard'],
  ['briefing', 'Safety briefing'],
  ['guidance', 'Guidance'],
];

/** Field roles that carry job aids (the server accepts any shipped role). */
const ROLES: [string, string][] = [
  ['damage_assessor', 'Damage assessor'],
  ['canvasser', 'Canvasser'],
  ['cleanup_crew_lead', 'Cleanup crew lead'],
  ['shelter_worker', 'Shelter worker'],
  ['shelter_nurse', 'Shelter nurse'],
  ['crisis_counselor', 'Crisis counselor or chaplain'],
  ['team_lead', 'Team lead'],
  ['field_volunteer', 'Field volunteer'],
  ['safety_officer', 'Safety officer'],
  ['search_rescue', 'Fire and rescue'],
  ['building_inspector', 'Building inspector'],
  ['road_crew', 'Road crew'],
  ['public_health_inspector', 'Public health'],
  ['animal_services', 'Animal services'],
  ['facility_host', 'Facility host'],
  ['checkpoint_officer', 'Checkpoint officer'],
  ['volunteer_reception', 'Volunteer reception'],
  ['warehouse_staff', 'Warehouse staff'],
  ['canteen_crew', 'Canteen crew'],
  ['distribution_staff', 'Distribution staff'],
  ['interpreter', 'Interpreter'],
  ['child_space_staff', 'Child-friendly space staff'],
  ['ems_medical_assist', 'EMS'],
];
const roleName = (k: string | null) =>
  k === null ? 'Every role' : (ROLES.find(([key]) => key === k)?.[1] ?? k);
const LANGS: Record<string, string> = { en: 'English', es: 'Español' };

const STATUS: Record<Aid['status'], string> = {
  draft: 'Draft: not on phones until someone else approves it',
  exercise_draft: 'Exercise draft: on phones in exercises only, marked not reviewed',
  approved: 'Approved: on phones',
  retired: 'Retired',
};

const EMPTY = {
  key: '',
  roleKey: '',
  lang: 'en',
  kind: 'checklist' as Kind,
  title: '',
  text: '',
};

export function JobAidsScreen() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [list, setList] = useState<Aid[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [f, setF] = useState(EMPTY);
  const [editing, setEditing] = useState<Aid | null>(null);
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
  useEffect(() => {
    if (!actions?.includes('job_aid.edit')) return;
    let live = true;
    api<Aid[]>('/job-aids')
      .then((d) => live && (setList(d), setError(null)))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [actions, tick]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      kind: f.kind,
      roleKey: f.roleKey || null,
      title: f.title.trim(),
      text: f.text.trim(),
    };
    try {
      if (editing) {
        await api(`/job-aids/${editing.id}`, { method: 'PATCH', body, version: editing.version });
        setMsg({
          kind: 'success',
          text:
            editing.status === 'draft'
              ? `"${body.title}" saved. It is still a draft.`
              : `"${body.title}" saved as a draft. It is off the phones until someone else approves it.`,
        });
      } else {
        await api('/job-aids', { body: { ...body, key: f.key.trim(), lang: f.lang } });
        setMsg({
          kind: 'success',
          text: `"${body.title}" saved as a draft. Someone else approves it before phones show it.`,
        });
      }
      setF(EMPTY);
      setEditing(null);
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };

  const decide = async (a: Aid, op: 'approve' | 'retire') => {
    try {
      await api(`/job-aids/${a.id}/${op}`, { method: 'POST', version: a.version });
      setMsg({
        kind: 'success',
        text:
          op === 'approve'
            ? `"${a.title}" is approved. Phones get it on their next sync.`
            : `"${a.title}" is retired. Phones drop it on their next sync.`,
      });
    } catch (err) {
      setMsg({
        kind: 'error',
        text:
          err instanceof ApiFailure && err.status === 403
            ? 'Someone other than the last person to change it approves it, with the approver role.'
            : describeFailure(err),
      });
    }
    reload();
  };

  const edit = (a: Aid) => {
    setEditing(a);
    setF({
      key: a.key,
      roleKey: a.roleKey ?? '',
      lang: a.lang,
      kind: a.kind,
      title: a.title,
      text: a.text,
    });
    setMsg(null);
  };
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  return (
    <section aria-labelledby="ja-h">
      <h1 id="ja-h">Job aids</h1>
      <p>
        The checklists, damage matrices, standards and safety briefings field phones carry, for each
        role and language. A job aid is a draft until someone other than the last person to change
        it approves it; only approved job aids reach the phones. Changing an approved job aid takes
        it off the phones until it is approved again.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {actions && !can('job_aid.edit') ? <p>You do not have access to job aids.</p> : null}
      {can('job_aid.edit') && list === null && !error ? (
        <p role="status">Loading job aids…</p>
      ) : null}

      {can('job_aid.edit') ? (
        <form onSubmit={(e) => void save(e)} className="panel" aria-labelledby="ja-form-h">
          <h2 id="ja-form-h">{editing ? `Change “${editing.title}”` : 'Write a job aid'}</h2>
          {!editing ? (
            <>
              <Field
                label="Short name"
                hint="Lowercase letters, digits and hyphens, such as roof-check."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={f.key}
                    onChange={set('key')}
                    required
                  />
                )}
              </Field>
              <Field label="Language">
                {({ id }) => (
                  <select id={id} value={f.lang} onChange={set('lang')}>
                    {Object.entries(LANGS).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </>
          ) : null}
          <Field label="Title">
            {({ id }) => <input id={id} value={f.title} onChange={set('title')} required />}
          </Field>
          <Field label="For">
            {({ id }) => (
              <select id={id} value={f.roleKey} onChange={set('roleKey')}>
                <option value="">Every role</option>
                {ROLES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Kind">
            {({ id }) => (
              <select id={id} value={f.kind} onChange={set('kind')}>
                {KINDS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Text"
            hint='Start a line with "## " for a heading or "- " for a list item; leave a blank line between paragraphs.'
          >
            {({ id, describedBy }) => (
              <textarea
                id={id}
                aria-describedby={describedBy}
                rows={10}
                value={f.text}
                onChange={set('text')}
                required
              />
            )}
          </Field>
          <p>
            <button type="submit" className="primary">
              {editing ? 'Save the change as a draft' : 'Save the draft'}
            </button>{' '}
            {editing ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setF(EMPTY);
                }}
              >
                Cancel the change
              </button>
            ) : null}
          </p>
        </form>
      ) : null}

      {list ? (
        <DataTable
          caption="Job aids"
          rows={list}
          rowKey={(a) => a.id}
          empty="No job aids yet."
          columns={[
            { key: 't', header: 'Title', render: (a) => a.title },
            { key: 'r', header: 'For', render: (a) => roleName(a.roleKey) },
            { key: 'l', header: 'Language', render: (a) => LANGS[a.lang] ?? a.lang },
            {
              key: 's',
              header: 'Status',
              render: (a) =>
                STATUS[a.status] +
                (a.status === 'approved' && a.approvedBy
                  ? ` (by ${a.approvedBy}, ${fmt(a.approvedAt)})`
                  : ''),
            },
            {
              key: 'c',
              header: 'Last changed',
              render: (a) =>
                `${a.lastChangedByYou ? 'You' : (a.lastChangedBy ?? 'The exercise set')}, ${fmt(a.updatedAt)}`,
            },
            {
              key: 'x',
              header: 'Action',
              render: (a) =>
                a.status === 'retired' ? (
                  '—'
                ) : (
                  <>
                    <button type="button" onClick={() => edit(a)}>
                      Change {a.title}
                    </button>
                    {can('job_aid.approve') && a.status !== 'approved' && !a.lastChangedByYou ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void decide(a, 'approve')}
                        >
                          Approve {a.title}
                        </button>
                      </>
                    ) : null}
                    {can('job_aid.approve') ? (
                      <>
                        {' '}
                        <button type="button" onClick={() => void decide(a, 'retire')}>
                          Retire {a.title}
                        </button>
                      </>
                    ) : null}
                  </>
                ),
            },
          ]}
        />
      ) : null}
    </section>
  );
}

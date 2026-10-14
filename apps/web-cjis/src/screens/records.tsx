/**
 * Law-enforcement records (SEC-12, PPL-01, BRD:FR-07.01–07.06): the agency's
 * list, and one record opened from the console's link
 * (/records/<ref>?mission=M-00012&county=county). A new reference offers to
 * create the enclave record; an existing one shows classification, people in
 * law-enforcement roles, weapons, body-camera references, narratives with
 * amendments, the disposition and the timeline. Stale versions show the
 * current record (FR-00.05).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, fmt, Input, label, Status } from '../ui/primitives.tsx';

export interface RecordView {
  ref: string;
  platformMissionReference: string | null;
  platformCounty: string | null;
  origin: string | null;
  classification: string | null;
  offenseCodes: string[];
  caseNumber: string | null;
  summary: string | null;
  state: 'open' | 'closed';
  disposition: string | null;
  dispositionNote: string | null;
  dispositionBy: string | null;
  dispositionById: string | null;
  dispositionAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  version: number;
  people: {
    id: string;
    role: string;
    name: string | null;
    birthDate: string | null;
    contact: string | null;
    address: string | null;
    identifiers: string | null;
    notes: string | null;
    status: string;
    removedReason: string | null;
    version: number;
  }[];
  weapons: {
    id: string;
    kind: string;
    description: string | null;
    serialNumber: string | null;
    disposition: string;
    status: string;
    removedReason: string | null;
    version: number;
  }[];
  bodycams: {
    id: string;
    cameraLabel: string;
    officer: string | null;
    recordedFrom: string | null;
    recordedTo: string | null;
    evidenceReference: string | null;
    status: string;
    removedReason: string | null;
    version: number;
  }[];
  timeline: {
    id: string;
    kind: string;
    narrativeRole: string | null;
    body: string | null;
    amendsEventId: string | null;
    actor: string | null;
    at: string;
  }[];
}

const ORIGINS = [
  ['', 'Not recorded'],
  ['911', '911 call'],
  ['non_emergency', 'Non-emergency line'],
  ['officer_initiated', 'Officer-initiated'],
  ['walk_in', 'Walk-in'],
  ['text', 'Text'],
  ['radio', 'Radio'],
  ['other', 'Other'],
] as const;
const CLASSIFICATIONS = [
  ['', 'Not classified'],
  ...(
    [
      'welfare_check',
      'disturbance',
      'assault',
      'theft',
      'burglary',
      'looting',
      'trespass',
      'traffic',
      'missing_person',
      'death_investigation',
      'domestic',
      'weapons_offense',
      'warrant_service',
      'other',
    ] as const
  ).map((c) => [c, label(c)] as const),
] as const;
const PERSON_ROLES = [
  'suspect',
  'arrestee',
  'victim',
  'witness',
  'complainant',
  'subject',
  'reporting_party',
  'other',
].map((r) => [r, label(r)] as const);
const WEAPON_KINDS = ['firearm', 'edged', 'blunt', 'explosive', 'other', 'unknown'].map(
  (k) => [k, label(k)] as const,
);
const WEAPON_DISPOSITIONS = ['observed', 'seized', 'returned', 'unknown'].map(
  (k) => [k, label(k)] as const,
);
const DISPOSITIONS = [
  'arrest_made',
  'citation_issued',
  'report_filed',
  'no_action_taken',
  'transported',
  'referred',
  'completed',
].map((k) => [k, label(k)] as const);

export function RecordsScreen({ navigate }: { navigate: (to: string) => void }) {
  const [rows, setRows] = useState<
    {
      ref: string;
      platformMissionReference: string | null;
      classification: string | null;
      state: string;
      disposition: string | null;
      people: number;
      updatedAt: string;
    }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<typeof rows>('/records')
      .then(setRows)
      .catch((e: unknown) => setError(describeFailure(e)));
  }, []);
  return (
    <>
      <h1>Records</h1>
      <p>
        Law-enforcement records of your agency. Open one from a mission in the console, or here.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      <DataTable
        caption="Your agency's records"
        rows={rows}
        rowKey={(r) => r.ref}
        empty="No records yet."
        columns={[
          {
            key: 'mission',
            header: 'Mission',
            render: (r) => (
              <a
                href={`/records/${r.ref}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/records/${r.ref}`);
                }}
              >
                {r.platformMissionReference ?? 'Record'}
              </a>
            ),
          },
          { key: 'class', header: 'Classification', render: (r) => label(r.classification) },
          { key: 'state', header: 'State', render: (r) => label(r.state) },
          { key: 'disp', header: 'Disposition', render: (r) => label(r.disposition) },
          { key: 'people', header: 'People', render: (r) => r.people },
          { key: 'updated', header: 'Last change', render: (r) => fmt(r.updatedAt) },
        ]}
      />
    </>
  );
}

function CreateRecord({
  cjiRef,
  mission,
  county,
  onCreated,
}: {
  cjiRef: string;
  mission: string | null;
  county: string | null;
  onCreated: (r: RecordView) => void;
}) {
  const [origin, setOrigin] = useState('');
  const [classification, setClassification] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api<RecordView>('/records', {
      body: {
        ref: cjiRef,
        ...(mission && /^M-\d{5,}$/.test(mission) ? { platformMissionReference: mission } : {}),
        ...(county && /^[a-z0-9-]{1,63}$/.test(county) ? { platformCounty: county } : {}),
        ...(origin ? { origin } : {}),
        ...(classification ? { classification } : {}),
      },
    })
      .then(onCreated)
      .catch((err: unknown) => setError(describeFailure(err)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <h1>{mission ? `Mission ${mission}` : 'New record'}</h1>
      <p>
        Your agency has no enclave record for this {mission ? 'mission' : 'reference'} yet. Create
        it to record the law-enforcement details here, inside the enclave.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      <form onSubmit={submit} className="stack">
        <Input label="How it began" value={origin} onChange={setOrigin} options={ORIGINS} />
        <Input
          label="Classification"
          value={classification}
          onChange={setClassification}
          options={CLASSIFICATIONS}
        />
        <button type="submit" className="primary" disabled={busy}>
          Create the enclave record
        </button>
      </form>
    </>
  );
}

export function RecordScreen({ cjiRef, roles }: { cjiRef: string; roles: readonly string[] }) {
  const [record, setRecord] = useState<RecordView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const params = new URLSearchParams(location.search);

  const load = useCallback(() => {
    api<RecordView>(`/records/${cjiRef}`)
      .then((r) => {
        setRecord(r);
        setMissing(false);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiFailure && e.status === 404) setMissing(true);
        else setError(describeFailure(e));
      });
  }, [cjiRef]);
  useEffect(load, [load]);

  /** Every change answers the whole record; a conflict shows the current one. */
  const change = async (fn: () => Promise<RecordView | { record: RecordView }>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      setRecord('record' in out ? out.record : out);
      setNotice(done);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409 && e.envelope.details) {
        setRecord(e.envelope.details as RecordView);
        setError(`${e.envelope.message} The current record is shown; check it and try again.`);
      } else setError(describeFailure(e));
    }
  };

  if (missing)
    return (
      <CreateRecord
        cjiRef={cjiRef}
        mission={params.get('mission')}
        county={params.get('county')}
        onCreated={(r) => {
          setRecord(r);
          setMissing(false);
          setNotice('Enclave record created.');
        }}
      />
    );
  if (!record)
    return error ? <Status kind="error">{error}</Status> : <p role="status">Loading the record…</p>;

  const open = record.state === 'open';
  const supervisor = roles.includes('supervisor');
  const mayDispose = roles.includes('officer') || supervisor;
  return (
    <>
      <h1>
        {record.platformMissionReference ? `Mission ${record.platformMissionReference}` : 'Record'}
      </h1>
      <p className="meta">
        {label(record.state)} · {label(record.classification)} · version {record.version}
      </p>
      {notice ? <Status kind="success">{notice}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      <Summary
        key={record.version}
        record={record}
        disabled={!open}
        onSave={(body) =>
          change(
            () =>
              api<RecordView>(`/records/${record.ref}`, {
                method: 'PATCH',
                body,
                version: record.version,
              }),
            'Saved.',
          )
        }
      />
      <People record={record} disabled={!open} change={change} />
      <Weapons record={record} disabled={!open} change={change} />
      <Bodycams record={record} disabled={!open} change={change} />
      <Narratives record={record} change={change} />
      <section aria-labelledby="disp-h">
        <h2 id="disp-h">Disposition</h2>
        {record.disposition ? (
          <p>
            {label(record.disposition)} by {record.dispositionBy ?? '—'},{' '}
            {fmt(record.dispositionAt)}
            {record.dispositionNote ? `: ${record.dispositionNote}` : ''}.{' '}
            {record.reviewedBy
              ? `Reviewed by ${record.reviewedBy}, ${fmt(record.reviewedAt)}.`
              : 'Not reviewed yet.'}
          </p>
        ) : (
          <p>No disposition yet.</p>
        )}
        {open && mayDispose ? (
          <Disposition
            onSubmit={(disposition, note) =>
              change(
                () =>
                  api<RecordView>(`/records/${record.ref}/disposition`, {
                    body: { disposition, ...(note ? { note } : {}) },
                    version: record.version,
                  }),
                'Disposition recorded; the record is closed.',
              )
            }
          />
        ) : null}
        {!open && supervisor ? (
          <div className="actions">
            {!record.reviewedBy ? (
              <button
                type="button"
                onClick={() =>
                  change(
                    () =>
                      api<RecordView>(`/records/${record.ref}/review`, {
                        method: 'POST',
                        version: record.version,
                      }),
                    'Review recorded.',
                  )
                }
              >
                Record the review
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                change(
                  () =>
                    api<RecordView>(`/records/${record.ref}/reopen`, {
                      method: 'POST',
                      version: record.version,
                    }),
                  'Record reopened.',
                )
              }
            >
              Reopen the record
            </button>
          </div>
        ) : null}
      </section>
      <section aria-labelledby="tl-h">
        <h2 id="tl-h">Timeline</h2>
        <ol className="timeline">
          {record.timeline.map((e) => (
            <li key={e.id}>
              <strong>{label(e.kind)}</strong> · {e.actor ?? 'System'} · {fmt(e.at)}
              {e.body ? <p>{e.body}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

type Change = (
  fn: () => Promise<RecordView | { record: RecordView }>,
  done: string,
) => Promise<void>;

function Summary({
  record,
  disabled,
  onSave,
}: {
  record: RecordView;
  disabled: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [origin, setOrigin] = useState(record.origin ?? '');
  const [classification, setClassification] = useState(record.classification ?? '');
  const [codes, setCodes] = useState(record.offenseCodes.join(', '));
  const [caseNumber, setCaseNumber] = useState(record.caseNumber ?? '');
  const [summary, setSummary] = useState(record.summary ?? '');
  return (
    <section aria-labelledby="sum-h">
      <h2 id="sum-h">Classification and summary</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            origin: origin || null,
            classification: classification || null,
            offenseCodes: codes
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean),
            caseNumber: caseNumber || null,
            summary: summary || null,
          });
        }}
      >
        <fieldset disabled={disabled}>
          <legend className="visually-hidden">Classification and summary</legend>
          <Input label="How it began" value={origin} onChange={setOrigin} options={ORIGINS} />
          <Input
            label="Classification"
            value={classification}
            onChange={setClassification}
            options={CLASSIFICATIONS}
          />
          <Input
            label="Offense codes"
            hint="Separated by commas"
            value={codes}
            onChange={setCodes}
          />
          <Input label="Case number" value={caseNumber} onChange={setCaseNumber} />
          <Input label="Summary" value={summary} onChange={setSummary} multiline />
          <button type="submit">Save classification and summary</button>
        </fieldset>
      </form>
    </section>
  );
}

function RemoveButton({ what, onRemove }: { what: string; onRemove: (reason: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  if (!asking)
    return (
      <button type="button" onClick={() => setAsking(true)}>
        Remove {what}
      </button>
    );
  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length >= 3) onRemove(reason.trim());
      }}
    >
      <Input label={`Why remove ${what}?`} value={reason} onChange={setReason} required />
      <button type="submit">Remove</button>
      <button type="button" onClick={() => setAsking(false)}>
        Keep
      </button>
    </form>
  );
}

function People({
  record,
  disabled,
  change,
}: {
  record: RecordView;
  disabled: boolean;
  change: Change;
}) {
  const [role, setRole] = useState('suspect');
  const [name, setName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [contact, setContact] = useState('');
  const [address, setAddress] = useState('');
  const [identifiers, setIdentifiers] = useState('');
  const [notes, setNotes] = useState('');
  const add = (e: FormEvent) => {
    e.preventDefault();
    void change(
      () =>
        api<{ record: RecordView }>(`/records/${record.ref}/people`, {
          version: record.version,
          body: {
            role,
            name,
            ...(birthDate ? { birthDate } : {}),
            ...(contact ? { contact } : {}),
            ...(address ? { address } : {}),
            ...(identifiers ? { identifiers } : {}),
            ...(notes ? { notes } : {}),
          },
        }),
      'Person added.',
    ).then(() => {
      setName('');
      setBirthDate('');
      setContact('');
      setAddress('');
      setIdentifiers('');
      setNotes('');
    });
  };
  return (
    <section aria-labelledby="people-h">
      <h2 id="people-h">People involved</h2>
      <DataTable
        caption="People involved"
        rows={record.people}
        rowKey={(p) => p.id}
        empty="No people recorded."
        columns={[
          { key: 'role', header: 'Role', render: (p) => label(p.role) },
          { key: 'name', header: 'Name', render: (p) => p.name },
          { key: 'dob', header: 'Date of birth', render: (p) => p.birthDate ?? '—' },
          { key: 'ids', header: 'Identifiers', render: (p) => p.identifiers ?? '—' },
          {
            key: 'status',
            header: 'Status',
            render: (p) =>
              p.status === 'removed' ? `Removed: ${p.removedReason ?? ''}` : 'Active',
          },
          {
            key: 'act',
            header: 'Action',
            render: (p) =>
              p.status === 'active' && !disabled ? (
                <RemoveButton
                  what={p.name ?? 'person'}
                  onRemove={(reason) =>
                    void change(
                      () =>
                        api<RecordView>(`/records/${record.ref}/people/${p.id}/remove`, {
                          body: { reason },
                          version: p.version,
                        }),
                      'Person removed; the entry and its reason are kept.',
                    )
                  }
                />
              ) : null,
          },
        ]}
      />
      {!disabled ? (
        <form onSubmit={add} className="stack">
          <h3>Add a person</h3>
          <Input label="Role" value={role} onChange={setRole} options={PERSON_ROLES} />
          <Input label="Name" value={name} onChange={setName} required />
          <Input label="Date of birth" type="date" value={birthDate} onChange={setBirthDate} />
          <Input label="Contact" value={contact} onChange={setContact} />
          <Input label="Address" value={address} onChange={setAddress} />
          <Input
            label="Identifiers"
            hint="For example a licence number"
            value={identifiers}
            onChange={setIdentifiers}
          />
          <Input label="Notes" value={notes} onChange={setNotes} multiline />
          <button type="submit">Add the person</button>
        </form>
      ) : null}
    </section>
  );
}

function Weapons({
  record,
  disabled,
  change,
}: {
  record: RecordView;
  disabled: boolean;
  change: Change;
}) {
  const [kind, setKind] = useState('firearm');
  const [description, setDescription] = useState('');
  const [serial, setSerial] = useState('');
  const [disposition, setDisposition] = useState('observed');
  const add = (e: FormEvent) => {
    e.preventDefault();
    void change(
      () =>
        api<{ record: RecordView }>(`/records/${record.ref}/weapons`, {
          version: record.version,
          body: {
            kind,
            disposition,
            ...(description ? { description } : {}),
            ...(serial ? { serialNumber: serial } : {}),
          },
        }),
      'Weapon added.',
    ).then(() => {
      setDescription('');
      setSerial('');
    });
  };
  return (
    <section aria-labelledby="weapons-h">
      <h2 id="weapons-h">Weapons</h2>
      <DataTable
        caption="Weapons"
        rows={record.weapons}
        rowKey={(w) => w.id}
        empty="No weapons recorded."
        columns={[
          { key: 'kind', header: 'Kind', render: (w) => label(w.kind) },
          { key: 'desc', header: 'Description', render: (w) => w.description ?? '—' },
          { key: 'serial', header: 'Serial number', render: (w) => w.serialNumber ?? '—' },
          { key: 'disp', header: 'What happened to it', render: (w) => label(w.disposition) },
          {
            key: 'status',
            header: 'Status',
            render: (w) =>
              w.status === 'removed' ? `Removed: ${w.removedReason ?? ''}` : 'Active',
          },
        ]}
      />
      {!disabled ? (
        <form onSubmit={add} className="stack">
          <h3>Add a weapon</h3>
          <Input label="Kind" value={kind} onChange={setKind} options={WEAPON_KINDS} />
          <Input label="Description" value={description} onChange={setDescription} />
          <Input label="Serial number" value={serial} onChange={setSerial} />
          <Input
            label="What happened to it"
            value={disposition}
            onChange={setDisposition}
            options={WEAPON_DISPOSITIONS}
          />
          <button type="submit">Add the weapon</button>
        </form>
      ) : null}
    </section>
  );
}

function Bodycams({
  record,
  disabled,
  change,
}: {
  record: RecordView;
  disabled: boolean;
  change: Change;
}) {
  const [camera, setCamera] = useState('');
  const [evidence, setEvidence] = useState('');
  const add = (e: FormEvent) => {
    e.preventDefault();
    void change(
      () =>
        api<{ record: RecordView }>(`/records/${record.ref}/bodycams`, {
          version: record.version,
          body: { cameraLabel: camera, evidenceReference: evidence },
        }),
      'Body-camera reference added.',
    ).then(() => {
      setCamera('');
      setEvidence('');
    });
  };
  return (
    <section aria-labelledby="cams-h">
      <h2 id="cams-h">Body-camera references</h2>
      <p className="hint">References only: the video stays in the evidence system.</p>
      <DataTable
        caption="Body-camera references"
        rows={record.bodycams}
        rowKey={(b) => b.id}
        empty="No body-camera references."
        columns={[
          { key: 'cam', header: 'Camera', render: (b) => b.cameraLabel },
          { key: 'officer', header: 'Officer', render: (b) => b.officer ?? '—' },
          { key: 'from', header: 'From', render: (b) => fmt(b.recordedFrom) },
          { key: 'ev', header: 'Evidence reference', render: (b) => b.evidenceReference ?? '—' },
          {
            key: 'status',
            header: 'Status',
            render: (b) =>
              b.status === 'removed' ? `Removed: ${b.removedReason ?? ''}` : 'Active',
          },
        ]}
      />
      {!disabled ? (
        <form onSubmit={add} className="stack">
          <h3>Add a body-camera reference</h3>
          <Input label="Camera" value={camera} onChange={setCamera} required />
          <Input label="Evidence reference" value={evidence} onChange={setEvidence} required />
          <button type="submit">Add the reference</button>
        </form>
      ) : null}
    </section>
  );
}

function Narratives({ record, change }: { record: RecordView; change: Change }) {
  const [body, setBody] = useState('');
  const [amends, setAmends] = useState('');
  const narratives = record.timeline.filter(
    (e) => e.kind === 'narrative' || e.kind === 'amendment',
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void change(
      () =>
        api<{ record: RecordView }>(`/records/${record.ref}/narratives`, {
          body: { body, ...(amends ? { amendsEventId: amends } : {}) },
        }),
      amends ? 'Amendment added.' : 'Narrative added.',
    ).then(() => {
      setBody('');
      setAmends(closed ? amends : '');
    });
  };
  return (
    <section aria-labelledby="narr-h">
      <h2 id="narr-h">Narratives</h2>
      {narratives.length === 0 ? <p>No narratives yet.</p> : null}
      <ul className="narratives">
        {narratives.map((n) => (
          <li key={n.id}>
            <p className="meta">
              {n.kind === 'amendment' ? 'Amendment' : 'Narrative'} · {label(n.narrativeRole)} ·{' '}
              {n.actor ?? '—'} · {fmt(n.at)}
            </p>
            <p>{n.body}</p>
          </li>
        ))}
      </ul>
      {record.state === 'open' || narratives.length > 0 ? (
        <form onSubmit={submit} className="stack">
          <h3>Add a narrative or an amendment</h3>
          {narratives.length > 0 ? (
            <Input
              label="Amends"
              hint="Leave as a new narrative, or pick the entry this corrects"
              value={amends}
              onChange={setAmends}
              options={[
                ...(closed ? [] : ([['', 'A new narrative']] as const)),
                ...narratives.map(
                  (n) => [n.id, `${label(n.kind)} by ${n.actor ?? '—'}, ${fmt(n.at)}`] as const,
                ),
              ]}
            />
          ) : null}
          <Input label="Text" value={body} onChange={setBody} multiline required />
          <button type="submit">Add</button>
        </form>
      ) : null}
    </section>
  );
}

function Disposition({ onSubmit }: { onSubmit: (disposition: string, note: string) => void }) {
  const [disposition, setDisposition] = useState('report_filed');
  const [note, setNote] = useState('');
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(disposition, note);
      }}
    >
      <h3>Record the disposition</h3>
      <p className="hint">Recording it closes the record; a supervisor can reopen it.</p>
      <Input
        label="Disposition"
        value={disposition}
        onChange={setDisposition}
        options={DISPOSITIONS}
      />
      <Input label="Explanation" value={note} onChange={setNote} multiline />
      <button type="submit" className="primary">
        Record the disposition
      </button>
    </form>
  );
}

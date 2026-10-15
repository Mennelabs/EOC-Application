/**
 * FEMA form mappings (layer-6 task F; DCL:DEC-12, DEC-13, DEC-15, RULE-14,
 * WCAG 2.2 AA): each FEMA form the package fills, the mapping version in
 * force and its history; a version's fields (code, label, the record
 * element and slice it is filled from); and, for those who may change them,
 * a draft of the next version (copied from the one in force) whose FEMA
 * edition, labels and codes can be changed and fields added or removed,
 * then put in force with a confirmed reason. The elements offered are only
 * those the form's grain may use, none of them personal (DEC-13); the
 * server checks every field again.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

interface VersionInfo {
  id: string | null;
  version: number | null;
  mappingVersion: number;
  femaFormVersion: string;
  status: 'shipped' | 'draft' | 'active' | 'retired';
  sourceDocument: string | null;
  note: string | null;
  activatedAt: string | null;
  activationReason: string | null;
  updatedAt: string | null;
}

interface FormRow {
  form: string;
  title: string;
  grain: string;
  inForce: VersionInfo;
  versions: VersionInfo[];
}

interface MappingField {
  code: string;
  label: string;
  element: string;
  where?: Record<string, string>;
  section?: string;
  row?: string;
  column?: string;
}

interface Mapping extends VersionInfo {
  form: string;
  fields: MappingField[];
  elements: { key: string; description: string; filters: string[] }[];
}

const STATUS: Record<VersionInfo['status'], string> = {
  shipped: 'Shipped with the platform',
  draft: 'Draft',
  active: 'In force',
  retired: 'Retired',
};
const GRAIN: Record<string, string> = {
  home: 'One row per home',
  site: 'One row per public damage site',
  summary: 'Summary of counts',
};
const sliceText = (w?: Record<string, string>) =>
  w && Object.keys(w).length
    ? Object.entries(w)
        .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${v.replace(/_/g, ' ')}`)
        .join('; ')
    : '';

export function FemaMappingsScreen() {
  const [forms, setForms] = useState<FormRow[] | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [open, setOpen] = useState<{ form: string; v: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const load = useCallback(() => {
    api<FormRow[]>('/fema-mappings')
      .then((f) => {
        setForms(f);
        setError(null);
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setActions(me.actions))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const can = (a: string) => actions.includes(a);
  const row = forms?.find((f) => f.form === open?.form) ?? null;

  return (
    <section aria-labelledby="fm-h">
      <h1 id="fm-h">FEMA form mappings</h1>
      <p>
        How each FEMA form in the damage assessment package is filled from the records: every field
        names one data element and, for counts, the slice it counts. A county can follow a newer
        edition of a form by putting a new version in force; every package says which versions it
        used. No mapping can carry a name, contact detail or street address.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {forms ? (
        <DataTable
          caption="FEMA forms"
          rows={forms}
          rowKey={(f) => f.form}
          columns={[
            { key: 'title', header: 'Form', render: (f) => f.title },
            { key: 'grain', header: 'Kind', render: (f) => GRAIN[f.grain] ?? f.grain },
            {
              key: 'force',
              header: 'In force',
              render: (f) => `Version ${f.inForce.mappingVersion} (${f.inForce.femaFormVersion})`,
            },
            {
              key: 'draft',
              header: 'Draft',
              render: (f) => {
                const d = f.versions.find((v) => v.status === 'draft');
                return d ? `Version ${d.mappingVersion}` : 'None';
              },
            },
            {
              key: 'open',
              header: 'Open',
              render: (f) => (
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setMsg(null);
                    const d = f.versions.find((v) => v.status === 'draft');
                    setOpen({ form: f.form, v: (d ?? f.inForce).mappingVersion });
                  }}
                >
                  Open {f.title}
                </button>
              ),
            },
          ]}
        />
      ) : (
        <p role="status">Loading the forms…</p>
      )}
      {row && open ? (
        <FormDetail
          key={`${open.form}-${open.v}-${row.versions.map((v) => `${v.mappingVersion}${v.version}`).join()}`}
          row={row}
          v={open.v}
          onOpen={(v) => setOpen({ form: row.form, v })}
          canWrite={can('fema_mapping.write')}
          canActivate={can('fema_mapping.activate')}
          onChanged={(text, v) => {
            setMsg({ kind: 'success', text });
            if (v !== undefined) setOpen({ form: row.form, v });
            load();
          }}
          onFailed={(text) => setMsg({ kind: 'error', text })}
        />
      ) : null}
    </section>
  );
}

function FormDetail({
  row,
  v,
  onOpen,
  canWrite,
  canActivate,
  onChanged,
  onFailed,
}: {
  row: FormRow;
  v: number;
  onOpen: (v: number) => void;
  canWrite: boolean;
  canActivate: boolean;
  onChanged: (text: string, v?: number) => void;
  onFailed: (text: string) => void;
}) {
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Mapping>(`/fema-mappings/${row.form}/versions/${v}`)
      .then((m) => live && setMapping(m))
      .catch((err: unknown) => live && setError(describeFailure(err)));
    return () => {
      live = false;
    };
  }, [row.form, v]);
  const draft = row.versions.find((x) => x.status === 'draft');
  const fail = (err: unknown) =>
    onFailed(
      err instanceof ApiFailure && err.status === 409 && err.envelope.code === 'conflict'
        ? 'Someone changed this draft meanwhile. Open it again to see their version.'
        : describeFailure(err),
    );

  return (
    <section aria-labelledby="fm-form-h">
      <h2 id="fm-form-h">{row.title}</h2>
      <DataTable
        caption={`Versions of the ${row.title} mapping`}
        rows={row.versions}
        rowKey={(x) => String(x.mappingVersion)}
        columns={[
          { key: 'v', header: 'Version', render: (x) => x.mappingVersion },
          { key: 'fema', header: 'FEMA edition', render: (x) => x.femaFormVersion },
          { key: 'status', header: 'Status', render: (x) => STATUS[x.status] },
          {
            key: 'when',
            header: 'Put in force',
            render: (x) =>
              x.activatedAt ? `${fmt(x.activatedAt)}: ${x.activationReason ?? ''}` : '',
          },
          {
            key: 'open',
            header: 'Open',
            render: (x) =>
              x.mappingVersion === v ? (
                'Shown below'
              ) : (
                <button type="button" className="link" onClick={() => onOpen(x.mappingVersion)}>
                  Show version {x.mappingVersion}
                </button>
              ),
          },
        ]}
      />
      {canWrite && !draft ? (
        <NewDraft
          form={row.form}
          onDone={(m) => onChanged(`Draft version ${m} started from the version in force.`, m)}
          onFail={fail}
        />
      ) : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {!mapping && !error ? <p role="status">Loading the fields…</p> : null}
      {mapping ? (
        mapping.status === 'draft' && canWrite ? (
          <DraftEditor
            mapping={mapping}
            canActivate={canActivate}
            onSaved={() => onChanged(`Draft version ${mapping.mappingVersion} saved.`)}
            onActivated={() =>
              onChanged(`Version ${mapping.mappingVersion} is now in force for ${row.title}.`)
            }
            onFail={fail}
          />
        ) : (
          <>
            <h3>
              Version {mapping.mappingVersion}: {STATUS[mapping.status].toLowerCase()}
            </h3>
            <p className="hint">
              Follows {mapping.femaFormVersion}
              {mapping.sourceDocument ? `; source: ${mapping.sourceDocument}` : ''}.
            </p>
            <DataTable
              caption={`Fields of version ${mapping.mappingVersion}`}
              rows={mapping.fields}
              rowKey={(f) => f.code}
              columns={[
                { key: 'code', header: 'Code', render: (f) => f.code },
                { key: 'label', header: 'Label', render: (f) => f.label },
                {
                  key: 'element',
                  header: 'Filled from',
                  render: (f) =>
                    mapping.elements.find((e) => e.key === f.element)?.description ?? f.element,
                },
                { key: 'slice', header: 'Counts only', render: (f) => sliceText(f.where) },
                {
                  key: 'place',
                  header: 'Section',
                  render: (f) => [f.section, f.row, f.column].filter(Boolean).join(' · '),
                },
              ]}
            />
          </>
        )
      ) : null}
    </section>
  );
}

function NewDraft({
  form,
  onDone,
  onFail,
}: {
  form: string;
  onDone: (mappingVersion: number) => void;
  onFail: (err: unknown) => void;
}) {
  const [edition, setEdition] = useState('');
  const [error, setError] = useState<string | undefined>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!edition.trim()) {
      setError('Name the FEMA edition the new version follows.');
      return;
    }
    setError(undefined);
    try {
      const m = await api<Mapping>(`/fema-mappings/${form}/versions`, {
        body: { femaFormVersion: edition.trim() },
      });
      onDone(m.mappingVersion);
    } catch (err) {
      onFail(err);
    }
  };
  return (
    <section aria-labelledby="fm-new-h">
      <h3 id="fm-new-h">Start a new version</h3>
      <form onSubmit={(e) => void submit(e)} className="form-grid">
        <Field
          label="FEMA edition it follows"
          hint="For example the form's revision date on fema.gov."
          {...(error ? { error } : {})}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              value={edition}
              maxLength={200}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => setEdition(e.target.value)}
            />
          )}
        </Field>
        <div className="toolbar">
          <button type="submit">Start a draft from the version in force</button>
        </div>
      </form>
    </section>
  );
}

function DraftEditor({
  mapping,
  canActivate,
  onSaved,
  onActivated,
  onFail,
}: {
  mapping: Mapping;
  canActivate: boolean;
  onSaved: () => void;
  onActivated: () => void;
  onFail: (err: unknown) => void;
}) {
  const [edition, setEdition] = useState(mapping.femaFormVersion);
  const [source, setSource] = useState(mapping.sourceDocument ?? '');
  const [fields, setFields] = useState<MappingField[]>(mapping.fields);
  const [adding, setAdding] = useState({
    code: '',
    label: '',
    element: mapping.elements[0]?.key ?? '',
  });
  const [problems, setProblems] = useState<string[]>([]);
  const set = (i: number, patch: Partial<MappingField>) =>
    setFields(fields.map((f, k) => (k === i ? { ...f, ...patch } : f)));
  const check = (list: MappingField[]) => {
    const out: string[] = [];
    list.forEach((f, i) => {
      if (!f.code.trim()) out.push(`Field ${i + 1} needs a code.`);
      if (!f.label.trim()) out.push(`Field ${i + 1} needs a label.`);
    });
    const codes = list.map((f) => f.code.trim());
    codes.forEach((c, i) => {
      if (c && codes.indexOf(c) !== i) out.push(`Field ${i + 1} repeats the code ${c}.`);
    });
    return out;
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const found = check(fields);
    setProblems(found);
    if (found.length) return;
    try {
      await api(`/fema-mappings/${mapping.form}/versions/${mapping.mappingVersion}`, {
        method: 'PUT',
        version: mapping.version!,
        body: {
          femaFormVersion: edition.trim(),
          sourceDocument: source.trim() || null,
          fields: fields.map((f) => ({ ...f, code: f.code.trim(), label: f.label.trim() })),
        },
      });
      onSaved();
    } catch (err) {
      if (err instanceof ApiFailure && err.envelope.fields?.length)
        setProblems(err.envelope.fields.map((x) => `${x.name}: ${x.message}`));
      onFail(err);
    }
  };
  const activate = async () => {
    try {
      await api(`/fema-mappings/${mapping.form}/versions/${mapping.mappingVersion}/activate`, {
        method: 'POST',
        version: mapping.version!,
      });
      onActivated();
    } catch (err) {
      onFail(err);
    }
  };
  return (
    <form onSubmit={(e) => void save(e)} aria-labelledby="fm-draft-h">
      <h3 id="fm-draft-h">Draft version {mapping.mappingVersion}</h3>
      <p className="hint">
        Changes here reach no package until the draft is put in force. The server checks every field
        against what this form may use.
      </p>
      <div className="form-grid">
        <Field label="FEMA edition it follows">
          {({ id }) => (
            <input
              id={id}
              value={edition}
              maxLength={200}
              onChange={(e) => setEdition(e.target.value)}
            />
          )}
        </Field>
        <Field label="Source document (optional)">
          {({ id }) => (
            <input
              id={id}
              value={source}
              maxLength={500}
              onChange={(e) => setSource(e.target.value)}
            />
          )}
        </Field>
      </div>
      {problems.length ? (
        <div role="alert" className="status error">
          <p>Some fields need attention:</p>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="table-wrap" role="region" aria-label="Fields of the draft" tabIndex={0}>
        <table>
          <caption>Fields of the draft</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Code</th>
              <th scope="col">Label</th>
              <th scope="col">Filled from</th>
              <th scope="col">Counts only</th>
              <th scope="col">Remove</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>
                  <input
                    aria-label={`Code of field ${i + 1}`}
                    value={f.code}
                    maxLength={40}
                    onChange={(e) => set(i, { code: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Label of field ${i + 1}`}
                    value={f.label}
                    maxLength={200}
                    onChange={(e) => set(i, { label: e.target.value })}
                  />
                </td>
                <td>
                  {mapping.elements.find((x) => x.key === f.element)?.description ?? f.element}
                </td>
                <td>{sliceText(f.where)}</td>
                <td>
                  <button type="button" onClick={() => setFields(fields.filter((_, k) => k !== i))}>
                    Remove field {i + 1}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <fieldset className="form-grid">
        <legend>Add a field</legend>
        <Field label="New field code">
          {({ id }) => (
            <input
              id={id}
              value={adding.code}
              maxLength={40}
              onChange={(e) => setAdding({ ...adding, code: e.target.value })}
            />
          )}
        </Field>
        <Field label="New field label">
          {({ id }) => (
            <input
              id={id}
              value={adding.label}
              maxLength={200}
              onChange={(e) => setAdding({ ...adding, label: e.target.value })}
            />
          )}
        </Field>
        <Field label="Filled from">
          {({ id }) => (
            <select
              id={id}
              value={adding.element}
              onChange={(e) => setAdding({ ...adding, element: e.target.value })}
            >
              {mapping.elements.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.description}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="toolbar">
          <button
            type="button"
            onClick={() => {
              if (!adding.code.trim() || !adding.label.trim()) {
                setProblems(['A new field needs a code and a label.']);
                return;
              }
              setProblems([]);
              setFields([
                ...fields,
                { code: adding.code.trim(), label: adding.label.trim(), element: adding.element },
              ]);
              setAdding({ ...adding, code: '', label: '' });
            }}
          >
            Add the field
          </button>
        </div>
      </fieldset>
      <div className="toolbar">
        <button type="submit" className="primary">
          Save the draft
        </button>
        {canActivate ? (
          <button type="button" onClick={() => void activate()}>
            Put version {mapping.mappingVersion} in force
          </button>
        ) : null}
      </div>
    </form>
  );
}

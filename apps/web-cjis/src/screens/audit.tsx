/**
 * Audit review and retention (SEC-18, BRD:FR-08.04, SEC-13): security
 * officers and auditors filter the agency's own audit, verify the chain,
 * export it with a reason, and record the weekly review; security officers
 * set retention periods (with floors) and place or release legal holds.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure, download } from '../api/client.ts';
import { DataTable, fmt, Input, label, Status } from '../ui/primitives.tsx';

interface AuditRow {
  seq: number;
  occurredAt: string;
  actor: string | null;
  actorKind: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: string;
  reason: string | null;
  fields: string[];
}

const weekAgo = () => new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const startOf = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const endOf = (d: string) =>
  new Date(new Date(`${d}T00:00:00`).getTime() + 24 * 3600 * 1000).toISOString();

export function AuditScreen() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState(weekAgo());
  const [to, setTo] = useState(today());
  const [note, setNote] = useState('');
  const [reviews, setReviews] = useState<
    {
      id: string;
      periodFrom: string;
      periodTo: string;
      chainOk: boolean;
      checked: number;
      reviewer: string;
      note: string;
    }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams({ limit: '200', from: startOf(from), to: endOf(to) });
    if (action) q.set('action', action);
    if (outcome) q.set('outcome', outcome);
    Promise.all([api<AuditRow[]>(`/audit?${q.toString()}`), api<typeof reviews>('/audit/reviews')])
      .then(([r, v]) => {
        setRows(r);
        setReviews(v);
      })
      .catch((e: unknown) => setError(describeFailure(e)));
  }, [action, outcome, from, to]);
  useEffect(load, [load]);

  const verify = () => {
    setError(null);
    api<{ ok: boolean; checked: number; firstBadSeq: number | null }>('/audit/verify', {
      method: 'POST',
    })
      .then((v) =>
        v.ok
          ? setNotice(`The audit chain verifies: ${v.checked} entries, none changed.`)
          : setError(
              `The audit chain breaks at entry ${v.firstBadSeq}. Report it to your CJIS Systems Officer.`,
            ),
      )
      .catch((e: unknown) => setError(describeFailure(e)));
  };
  const review = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    api<{ chainOk: boolean; checked: number }>('/audit/reviews', {
      body: { periodFrom: startOf(from), periodTo: endOf(to), note },
    })
      .then((v) => {
        setNote('');
        setNotice(
          `Weekly review recorded (${v.checked} entries, chain ${v.chainOk ? 'verified' : 'broken'}).`,
        );
        load();
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  };

  return (
    <>
      <h1>Audit review</h1>
      <p>
        Your agency's enclave audit: every read, change, denial, export and sign-in. Nobody can
        change it.
      </p>
      {notice ? <Status kind="success">{notice}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <Input label="From" type="date" value={from} onChange={setFrom} />
        <Input label="To" type="date" value={to} onChange={setTo} />
        <Input
          label="Action starts with"
          value={action}
          onChange={setAction}
          hint="For example record. or identity."
        />
        <Input
          label="Outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            ['', 'Any'],
            ['success', 'Success'],
            ['denied', 'Denied'],
            ['failure', 'Failure'],
          ]}
        />
        <button type="submit">Show</button>
      </form>
      <div className="actions">
        <button type="button" onClick={verify}>
          Verify the chain
        </button>
        <button
          type="button"
          onClick={() =>
            download(
              `/audit/export?${new URLSearchParams({ from: startOf(from), to: endOf(to) }).toString()}`,
              `enclave-audit-${from}-to-${to}.csv`,
            ).catch((e: unknown) => setError(describeFailure(e)))
          }
        >
          Export as CSV
        </button>
      </div>
      <DataTable
        caption="Audit entries, newest first"
        rows={rows}
        rowKey={(r) => String(r.seq)}
        empty="No entries for these filters."
        columns={[
          { key: 'when', header: 'When', render: (r) => fmt(r.occurredAt) },
          { key: 'who', header: 'Who', render: (r) => r.actor ?? label(r.actorKind) },
          { key: 'action', header: 'Action', render: (r) => r.action },
          {
            key: 'target',
            header: 'Target',
            render: (r) => `${r.targetType} ${r.targetId.slice(0, 12)}`,
          },
          { key: 'outcome', header: 'Outcome', render: (r) => label(r.outcome) },
          { key: 'fields', header: 'Fields', render: (r) => r.fields.join(', ') || '—' },
          { key: 'reason', header: 'Reason', render: (r) => r.reason ?? '—' },
        ]}
      />
      <form onSubmit={review} className="stack">
        <h2>Record the weekly review</h2>
        <p className="hint">Covers the dates above; the chain is verified when you record it.</p>
        <Input
          label="What you checked and found"
          value={note}
          onChange={setNote}
          multiline
          required
        />
        <button type="submit" className="primary">
          Record the review
        </button>
      </form>
      <DataTable
        caption="Weekly reviews"
        rows={reviews}
        rowKey={(r) => r.id}
        empty="No reviews recorded yet."
        columns={[
          {
            key: 'period',
            header: 'Period',
            render: (r) => `${fmt(r.periodFrom)} to ${fmt(r.periodTo)}`,
          },
          { key: 'who', header: 'Reviewer', render: (r) => r.reviewer },
          {
            key: 'chain',
            header: 'Chain',
            render: (r) => (r.chainOk ? `Verified (${r.checked})` : 'Broken'),
          },
          { key: 'note', header: 'Note', render: (r) => r.note },
        ]}
      />
    </>
  );
}

interface Retention {
  policies: { category: string; keepDays: number; basis: string; version: number }[];
  holds: {
    id: string;
    missionReference: string | null;
    scope: string;
    reason: string;
    placedBy: string;
    placedAt: string;
    releasedAt: string | null;
    version: number;
  }[];
  deletions: { category: string; cutoff: string; deleted: number; held: number; ranAt: string }[];
}

export function RetentionScreen({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<Retention | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [holdRef, setHoldRef] = useState('');
  const [holdReason, setHoldReason] = useState('');
  const load = useCallback(() => {
    api<Retention>('/retention')
      .then(setData)
      .catch((e: unknown) => setError(describeFailure(e)));
  }, []);
  useEffect(load, [load]);
  const act = (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    fn()
      .then(() => {
        setNotice(done);
        load();
      })
      .catch((e: unknown) => setError(describeFailure(e)));
  };
  if (!data) return error ? <Status kind="error">{error}</Status> : <p role="status">Loading…</p>;
  return (
    <>
      <h1>Retention and legal holds</h1>
      <p>
        Closed records are deleted after the period below unless a legal hold covers them. Records
        are kept at least one year and the audit at least seven years.
      </p>
      {notice ? <Status kind="success">{notice}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {data.policies.map((p) => (
        <PolicyForm
          key={`${p.category}:${p.version}`}
          policy={p}
          canWrite={canWrite}
          onSave={(keepDays, basis) =>
            act(
              () =>
                api(`/retention/${p.category}`, {
                  method: 'PUT',
                  body: { keepDays, basis },
                  version: p.version,
                }),
              'Retention period saved.',
            )
          }
        />
      ))}
      <h2>Legal holds</h2>
      <DataTable
        caption="Legal holds"
        rows={data.holds}
        rowKey={(h) => h.id}
        empty="No legal holds."
        columns={[
          {
            key: 'scope',
            header: 'Covers',
            render: (h) =>
              h.scope === 'agency'
                ? 'All records of the agency'
                : `Mission ${h.missionReference ?? 'record'}`,
          },
          { key: 'reason', header: 'Reason', render: (h) => h.reason },
          { key: 'by', header: 'Placed by', render: (h) => `${h.placedBy}, ${fmt(h.placedAt)}` },
          {
            key: 'state',
            header: 'State',
            render: (h) =>
              h.releasedAt ? (
                `Released ${fmt(h.releasedAt)}`
              ) : canWrite ? (
                <button
                  type="button"
                  onClick={() =>
                    act(
                      () => api(`/holds/${h.id}/release`, { method: 'POST', version: h.version }),
                      'Hold released.',
                    )
                  }
                >
                  Release
                </button>
              ) : (
                'Active'
              ),
          },
        ]}
      />
      {canWrite ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            act(
              () =>
                api('/holds', {
                  body: { reason: holdReason, ...(holdRef ? { ref: holdRef } : {}) },
                }),
              'Legal hold placed.',
            );
            setHoldRef('');
            setHoldReason('');
          }}
        >
          <h3>Place a legal hold</h3>
          <Input
            label="Record reference"
            hint="Leave empty to hold every record of the agency"
            value={holdRef}
            onChange={setHoldRef}
          />
          <Input label="Reason" value={holdReason} onChange={setHoldReason} required />
          <button type="submit">Place the hold</button>
        </form>
      ) : null}
      <h2>Deletions</h2>
      <DataTable
        caption="Retention runs"
        rows={data.deletions}
        rowKey={(d) => d.ranAt}
        empty="Nothing has been deleted."
        columns={[
          { key: 'when', header: 'When', render: (d) => fmt(d.ranAt) },
          { key: 'cutoff', header: 'Closed before', render: (d) => fmt(d.cutoff) },
          { key: 'deleted', header: 'Deleted', render: (d) => d.deleted },
          { key: 'held', header: 'Kept under hold', render: (d) => d.held },
        ]}
      />
    </>
  );
}

function PolicyForm({
  policy,
  canWrite,
  onSave,
}: {
  policy: { category: string; keepDays: number; basis: string };
  canWrite: boolean;
  onSave: (keepDays: number, basis: string) => void;
}) {
  const [days, setDays] = useState(String(policy.keepDays));
  const [basis, setBasis] = useState(policy.basis);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(Number(days), basis);
      }}
    >
      <h2>{policy.category === 'records' ? 'Closed records' : 'Audit'}</h2>
      <fieldset disabled={!canWrite}>
        <legend className="visually-hidden">{policy.category} retention</legend>
        <Input label="Keep for (days)" type="number" value={days} onChange={setDays} required />
        <Input
          label="Basis"
          hint="The records schedule or rule"
          value={basis}
          onChange={setBasis}
          required
        />
        {canWrite ? <button type="submit">Save</button> : null}
      </fieldset>
    </form>
  );
}

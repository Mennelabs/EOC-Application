/**
 * Find a survivor's record (FL-02; WCAG 2.2 AA). When someone has no
 * reference code, the worker finds their report with them, and they show it
 * is them before anything is shown: by phone, the county texts them a code
 * that they read back; by address and name, the worker reads back only the
 * day each matching report came in and how, and the survivor says which is
 * theirs. The reference code then opens the record as any code does. Every
 * step is audited; the answers never say whether a phone is on file.
 */
import { useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

interface Found {
  reportId: string;
  referenceCode: string;
  submittedAt: string;
  channel: string;
  reviewState: string;
}
interface Candidate {
  reportId: string;
  submittedAt: string;
  channel: string;
}

const CHANNEL: Record<string, string> = {
  web: 'online form',
  sms: 'text message',
  voice: 'phone call',
  assisted: 'with a helper',
};
const how = (c: string) => CHANNEL[c] ?? c;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

type Navigate = (path: string) => void;

/** A link to a report that stays in the console. */
function ReportLink({
  id,
  navigate,
  children,
}: {
  id: string;
  navigate: Navigate;
  children: string;
}) {
  return (
    <a
      href={`/console/reports/${id}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(`/console/reports/${id}`);
      }}
    >
      {children}
    </a>
  );
}

function FoundTable({
  rows,
  caption,
  navigate,
}: {
  rows: Found[];
  caption: string;
  navigate: Navigate;
}) {
  return (
    <DataTable
      caption={caption}
      rows={rows}
      rowKey={(r) => r.reportId}
      empty="No report you can see is on that phone."
      columns={[
        {
          key: 'code',
          header: 'Reference code',
          render: (r) => (
            <ReportLink id={r.reportId} navigate={navigate}>
              {r.referenceCode}
            </ReportLink>
          ),
        },
        { key: 'at', header: 'Received', render: (r) => fmt(r.submittedAt) },
        { key: 'how', header: 'How', render: (r) => how(r.channel) },
        { key: 'state', header: 'Review', render: (r) => r.reviewState.replace(/_/g, ' ') },
      ]}
    />
  );
}

function ByPhone({ navigate }: { navigate: Navigate }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setFound(null);
    try {
      const r = await api<{ message: string }>('/survivor-lookup/phone', {
        body: { phone: phone.trim() },
      });
      setSent(true);
      setMsg({ kind: 'success', text: r.message });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    } finally {
      setBusy(false);
    }
  };
  const check = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ reports: Found[] }>('/survivor-lookup/phone/verify', {
        body: { phone: phone.trim(), code: code.trim() },
      });
      setFound(r.reports);
      setCode('');
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={(e) => void send(e)} className="form-grid">
        <Field label="Their phone number">
          {({ id }) => (
            <input
              id={id}
              type="tel"
              autoComplete="off"
              required
              minLength={7}
              maxLength={30}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          )}
        </Field>
        <div className="toolbar">
          <button type="submit" className="primary" disabled={busy}>
            Text them a code
          </button>
        </div>
      </form>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {sent ? (
        <form onSubmit={(e) => void check(e)} className="form-grid">
          <Field label="Code they read to you" hint="Six digits. It works once, for 10 minutes.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
          <div className="toolbar">
            <button type="submit" disabled={busy}>
              Check the code
            </button>
          </div>
        </form>
      ) : null}
      {found ? (
        <FoundTable rows={found} caption="Reports on that phone" navigate={navigate} />
      ) : null}
    </>
  );
}

function ByAddress({ navigate }: { navigate: Navigate }) {
  const [line1, setLine1] = useState('');
  const [postal, setPostal] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setFound(null);
    try {
      const r = await api<{ candidates: Candidate[] }>('/survivor-lookup/address', {
        body: {
          line1: line1.trim(),
          name: name.trim(),
          ...(postal.trim() ? { postal: postal.trim() } : {}),
        },
      });
      setCandidates(r.candidates);
    } catch (err) {
      setMsg(describeFailure(err));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (c: Candidate) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<Found>('/survivor-lookup/confirm', {
        body: { reportId: c.reportId, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      setFound(r);
      setCandidates(null);
    } catch (err) {
      setMsg(describeFailure(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={(e) => void search(e)} className="form-grid">
        <Field label="Street address" hint="House number and street, as they say it.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              autoComplete="off"
              required
              minLength={3}
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
            />
          )}
        </Field>
        <Field label="ZIP code (optional)">
          {({ id }) => (
            <input
              id={id}
              inputMode="numeric"
              autoComplete="off"
              pattern="\d{5}(-\d{4})?"
              value={postal}
              onChange={(e) => setPostal(e.target.value)}
            />
          )}
        </Field>
        <Field label="Their name" hint="Any part of the name they gave, such as first and last.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              autoComplete="off"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <div className="toolbar">
          <button type="submit" className="primary" disabled={busy}>
            Search
          </button>
        </div>
      </form>
      {msg ? <Status kind="error">{msg}</Status> : null}
      {candidates && candidates.length === 0 ? (
        <Status kind="info">
          No report you can see matches. Check the spelling with them, or try their phone.
        </Status>
      ) : null}
      {candidates && candidates.length > 0 ? (
        <section aria-labelledby="fs-cands">
          <h2 id="fs-cands">Read these back and ask which is theirs</h2>
          <p>
            Read only the day and how it came in. If they say one is theirs, choose it. If none is,
            do not choose any.
          </p>
          <Field
            label="What they recognised (optional)"
            hint="Kept in the audit record with your confirmation."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <ul className="plain">
            {candidates.map((c) => (
              <li key={c.reportId}>
                A report received {day(c.submittedAt)} by {how(c.channel)}{' '}
                <button type="button" disabled={busy} onClick={() => void confirm(c)}>
                  They say this one is theirs
                  <span className="visually-hidden">
                    {' '}
                    (received {day(c.submittedAt)} by {how(c.channel)})
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {found ? (
        <Status kind="success">
          Their reference code is <strong>{found.referenceCode}</strong>.{' '}
          <ReportLink id={found.reportId} navigate={navigate}>
            Open the report
          </ReportLink>
          . Give them the code so they have it next time.
        </Status>
      ) : null}
    </>
  );
}

export function FindSurvivorScreen({ navigate }: { navigate: Navigate }) {
  const [mode, setMode] = useState<'phone' | 'address'>('phone');
  return (
    <section aria-labelledby="fs-h">
      <h1 id="fs-h">Find a survivor&apos;s record</h1>
      <p>
        For someone without their reference code. They show it is them before anything is shown: a
        code texted to their phone, or a report they recognise when you read back the day it came
        in. Never read their details to them first. Every search is recorded.
      </p>
      <fieldset>
        <legend>How to find it</legend>
        <label className="choice">
          <input
            type="radio"
            name="fs-mode"
            checked={mode === 'phone'}
            onChange={() => setMode('phone')}
          />{' '}
          By phone, with a code texted to them
        </label>
        <label className="choice">
          <input
            type="radio"
            name="fs-mode"
            checked={mode === 'address'}
            onChange={() => setMode('address')}
          />{' '}
          By address and name, with their confirmation
        </label>
      </fieldset>
      {mode === 'phone' ? <ByPhone navigate={navigate} /> : <ByAddress navigate={navigate} />}
    </section>
  );
}

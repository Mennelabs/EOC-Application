/**
 * Resident re-entry passes (FL:FR-03): the EOC issues a pass for a household
 * to go back into a closed zone of an event (the zone, how many people, who
 * and which home, how long). Issuing asks for a reason. The code is shown
 * once, in text and as a code to scan, on a card to print; only its hash is
 * kept. The list shows each pass with its state in words and its last check
 * at the perimeter, and a pass can be revoked with a reason. The log of
 * checks says where, when and the result, and names no one.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import { QrImage } from '../ui/qr.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';

interface Pass {
  id: string;
  version: number;
  zone: string;
  holderName: string | null;
  address: string | null;
  people: number;
  validFrom: string;
  validTo: string;
  state: 'active' | 'revoked' | 'expired';
  revokeReason: string | null;
  checks: number;
  lastCheck: { at: string; checkpoint: string | null; result: string } | null;
}
interface Check {
  passId: string;
  zone: string;
  checkpoint: string | null;
  result: string;
  at: string;
}
interface Issued {
  id: string;
  code: string;
  zone: string;
  people: number;
  validFrom: string;
  validTo: string;
  holderName: string;
  address: string;
}

const STATE: Record<Pass['state'], string> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
};
const RESULT: Record<string, string> = {
  valid: 'Let in',
  expired: 'Refused: expired',
  revoked: 'Refused: revoked',
  not_yet_valid: 'Refused: not valid yet',
};

export function ReentryScreen() {
  const { events, error: eventsError } = useOpenEvents();
  const [eventId, setEventId] = useState<string | null>(null);
  const currentEvent = eventId ?? events?.[0]?.id ?? null;
  const [passes, setPasses] = useState<Pass[] | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [tick, setTick] = useState(0);
  const [f, setF] = useState({ zone: '', holderName: '', address: '', people: 1, validHours: 72 });
  useEffect(() => {
    if (!currentEvent) return;
    let live = true;
    Promise.all([
      api<Pass[]>(`/reentry-passes?eventId=${currentEvent}`),
      api<Check[]>(`/reentry-passes/checks?eventId=${currentEvent}`),
    ])
      .then(([p, c]) => {
        if (!live) return;
        setPasses(p);
        setChecks(c);
        setError(null);
      })
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [currentEvent, tick]);
  const issue = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentEvent) return;
    setNotice(null);
    try {
      const r = await api<Omit<Issued, 'holderName' | 'address'>>('/reentry-passes', {
        body: { eventId: currentEvent, ...f },
      });
      setIssued({ ...r, holderName: f.holderName, address: f.address });
      setNotice({
        kind: 'success',
        text: 'Pass issued. Print it now: its code is shown only once.',
      });
      setF({ zone: f.zone, holderName: '', address: '', people: 1, validHours: f.validHours });
      setTick((n) => n + 1);
    } catch (err) {
      setNotice({ kind: 'error', text: describeFailure(err) });
    }
  };
  const revoke = async (p: Pass) => {
    setNotice(null);
    try {
      await api(`/reentry-passes/${p.id}/revoke`, {
        method: 'POST',
        version: p.version,
        idempotent: false,
      });
      setNotice({ kind: 'success', text: `The pass for ${p.zone} is revoked.` });
      setTick((n) => n + 1);
    } catch (err) {
      setNotice({ kind: 'error', text: describeFailure(err) });
    }
  };
  return (
    <section aria-labelledby="reentry-h">
      <h1 id="reentry-h">Re-entry passes</h1>
      <p>
        A pass lets a household back into a closed zone for a time. The checkpoint scans it and sees
        the zone, how many people, and who and which home to match against an ID. Each scan is
        logged.
      </p>
      <Toolbar>
        {events?.length ? (
          <EventPicker events={events} value={currentEvent} onChange={setEventId} />
        ) : null}
      </Toolbar>
      {eventsError ? <Status kind="error">{eventsError}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {notice ? <Status kind={notice.kind}>{notice.text}</Status> : null}
      {issued ? (
        <section className="badge-print" aria-labelledby="pass-print-h">
          <h2 id="pass-print-h">Pass to print</h2>
          <div className="badge-card">
            <p className="badge-name">Re-entry pass: {issued.zone}</p>
            <p>{issued.holderName}</p>
            <p>{issued.address}</p>
            <p>
              {issued.people} {issued.people === 1 ? 'person' : 'people'}
            </p>
            <p>
              Valid {fmt(issued.validFrom)} to {fmt(issued.validTo)}
            </p>
            <QrImage
              text={issued.code}
              alt={`Pass code ${issued.code.split('').join(' ')}`}
              size={120}
            />
            <p>
              Code: <strong>{issued.code}</strong>
            </p>
            <p>Show this pass and an ID at the checkpoint.</p>
          </div>
          <p className="hint">The same information is printed in text beside the code.</p>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" onClick={() => setIssued(null)}>
              Done: hide the code
            </button>
          </div>
        </section>
      ) : null}
      <form className="panel" onSubmit={(e) => void issue(e)} aria-labelledby="issue-h">
        <h2 id="issue-h">Issue a pass</h2>
        <div className="form-grid">
          <Field label="Zone" hint="The closed area, as the checkpoint knows it">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={f.zone}
                onChange={(e) => setF({ ...f, zone: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Name on the pass">
            {({ id }) => (
              <input
                id={id}
                value={f.holderName}
                onChange={(e) => setF({ ...f, holderName: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Home address" hint="The checkpoint matches it against an ID">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={f.address}
                onChange={(e) => setF({ ...f, address: e.target.value })}
                required
                minLength={3}
              />
            )}
          </Field>
          <Field label="People">
            {({ id }) => (
              <input
                id={id}
                type="number"
                min={1}
                max={20}
                value={f.people}
                onChange={(e) => setF({ ...f, people: Number(e.target.value) })}
              />
            )}
          </Field>
          <Field label="Good for (hours)">
            {({ id }) => (
              <input
                id={id}
                type="number"
                min={1}
                max={336}
                value={f.validHours}
                onChange={(e) => setF({ ...f, validHours: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
        <button type="submit" className="primary" disabled={!currentEvent}>
          Issue the pass
        </button>
      </form>
      <DataTable
        caption="Passes for this event"
        rows={passes ?? []}
        rowKey={(p) => p.id}
        empty="No passes issued for this event."
        columns={[
          { key: 'zone', header: 'Zone', render: (p) => p.zone },
          { key: 'who', header: 'For', render: (p) => p.holderName ?? 'Cannot be read' },
          { key: 'home', header: 'Home', render: (p) => p.address ?? 'Cannot be read' },
          { key: 'people', header: 'People', render: (p) => p.people },
          { key: 'to', header: 'Good until', render: (p) => fmt(p.validTo) },
          {
            key: 'state',
            header: 'State',
            render: (p) =>
              `${STATE[p.state]}${p.state === 'revoked' && p.revokeReason ? `: ${p.revokeReason}` : ''}`,
          },
          {
            key: 'last',
            header: 'Last check',
            render: (p) =>
              p.lastCheck
                ? `${RESULT[p.lastCheck.result] ?? p.lastCheck.result}${p.lastCheck.checkpoint ? ` at ${p.lastCheck.checkpoint}` : ''}, ${fmt(p.lastCheck.at)}`
                : 'Not scanned yet',
          },
          {
            key: 'act',
            header: 'Action',
            render: (p) =>
              p.state === 'active' ? (
                <button type="button" onClick={() => void revoke(p)}>
                  Revoke the pass for {p.holderName ?? p.zone}
                </button>
              ) : (
                '—'
              ),
          },
        ]}
      />
      <DataTable
        caption="Checks at the perimeter, newest first"
        rows={checks}
        rowKey={(c) => `${c.passId}-${c.at}`}
        empty="No pass has been scanned yet."
        columns={[
          { key: 'at', header: 'When', render: (c) => fmt(c.at) },
          { key: 'where', header: 'Checkpoint', render: (c) => c.checkpoint ?? 'Not given' },
          { key: 'zone', header: 'Zone', render: (c) => c.zone },
          { key: 'result', header: 'Result', render: (c) => RESULT[c.result] ?? c.result },
        ]}
      />
    </section>
  );
}

/**
 * Accessible building blocks on native elements (WCAG 2.2 AA): labelled
 * fields with associated errors, a confirmation dialog on <dialog>, status
 * regions, and a data table with proper headers. React Aria arrives when a
 * widget needs it (combobox, menu); see docs/decisions.md.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Confirmation } from '../api/client.ts';
import { formatInstant } from './time.ts';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errorId} className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Status({
  kind,
  children,
}: {
  kind: 'info' | 'error' | 'success';
  children: ReactNode;
}) {
  return (
    <p className={`status ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty = 'Nothing here yet.',
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: string;
}) {
  if (rows.length === 0) return <p className="empty">{empty}</p>;
  return (
    // A wide table scrolls sideways on a phone; the region takes keyboard focus so the
    // arrow keys can scroll it, and is named after its caption (ACC-07, ACC-10, WCAG 2.1.1).
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.key}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** RULE-14: consequential actions are confirmed with a reason, in a real dialog. */
export function ConfirmDialog({
  request,
  onDone,
}: {
  request: { action: string; description: string; draft?: string | undefined } | null;
  onDone: (c: Confirmation) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (request && !d.open) {
      setReason(request.draft ?? '');
      setError(undefined);
      d.showModal();
    } else if (!request && d.open) d.close();
  }, [request]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setError('Please say why, in a few words. It goes into the audit record.');
      return;
    }
    onDone({ confirmed: true, reason: reason.trim() });
  };

  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby="confirm-title"
      onCancel={() => onDone({ confirmed: false, reason: '' })}
    >
      <form method="dialog" onSubmit={submit}>
        <h2 id="confirm-title">Please confirm</h2>
        <p>{request?.description}</p>
        <Field
          label="Reason"
          hint={
            request?.draft
              ? 'Taken from the form. Recorded in the audit log with your name and the time; change it if it is not what you checked.'
              : 'Recorded in the audit log with your name and the time.'
          }
          {...(error ? { error } : {})}
        >
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              required
            />
          )}
        </Field>
        <div className="actions">
          <button type="button" onClick={() => onDone({ confirmed: false, reason: '' })}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Confirm
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

/** BRD:FR-00.08: a time on the tenant's clock with the zone named ("Oct 16, 2026, 7:00 AM CDT"). */
export function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatInstant(new Date(iso));
}

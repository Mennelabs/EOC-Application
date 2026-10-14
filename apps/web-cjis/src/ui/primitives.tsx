/**
 * Accessible building blocks on native elements (WCAG 2.2 AA), as in the
 * console: labelled fields with associated errors and hints, status regions,
 * tables with captions and headers, and the confirmation dialog on <dialog>
 * that asks for the reason consequential actions record (RULE-14).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Confirmation } from '../api/client.ts';

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

/** A text input, text area or select with its label, the common case. */
export function Input({
  label,
  value,
  onChange,
  hint,
  type = 'text',
  required,
  multiline,
  options,
  autoComplete = 'off',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  type?: string;
  required?: boolean;
  multiline?: boolean;
  options?: readonly (readonly [string, string])[];
  autoComplete?: string;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      {({ id, describedBy }) =>
        options ? (
          <select
            id={id}
            aria-describedby={describedBy}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={required}
          >
            {options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        ) : multiline ? (
          <textarea
            id={id}
            aria-describedby={describedBy}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={4}
            required={required}
          />
        ) : (
          <input
            id={id}
            aria-describedby={describedBy}
            type={type}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={required}
            autoComplete={autoComplete}
          />
        )
      }
    </Field>
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

export function ConfirmDialog({
  request,
  onDone,
}: {
  request: { description: string } | null;
  onDone: (c: Confirmation) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (request && !d.open) {
      setReason('');
      setError(undefined);
      d.showModal();
    } else if (!request && d.open) d.close();
  }, [request]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setError('Please say why, in a few words. It goes into the enclave audit record.');
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
          hint="Recorded in the enclave audit with your name and the time."
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

export function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Readable label for a code: "arrest_made" → "Arrest made". */
export function label(code: string | null | undefined): string {
  if (!code) return '—';
  const s = code.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

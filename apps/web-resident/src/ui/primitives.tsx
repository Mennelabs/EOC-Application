/**
 * Accessible building blocks on native elements (WCAG 2.2 AA, ACC-04–12):
 * labelled fields with hints and errors, choice groups as real radio and
 * checkbox inputs with large targets, status regions, a progress line in
 * words (INT-06). No colour-only meaning, 44 px targets, visible focus.
 */
import { useId, type ReactNode } from 'react';
import { Icon } from './icons.tsx';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
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
  kind: 'info' | 'error' | 'success' | 'warn';
  children: ReactNode;
}) {
  return (
    <div className={`status ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export interface Choice {
  value: string;
  label: string;
  hint?: string | undefined;
  picture?: string | undefined;
}

/** Radio or checkbox group rendered as big tappable cards; the input is the real control. */
export function ChoiceGroup({
  legend,
  hint,
  choices,
  multiple,
  value,
  onChange,
  error,
}: {
  legend: string;
  hint?: string | undefined;
  choices: Choice[];
  multiple: boolean;
  value: string[];
  onChange: (next: string[]) => void;
  error?: string | undefined;
}) {
  const name = useId();
  const hintId = `${name}-hint`;
  const errorId = `${name}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset className="choices" aria-describedby={describedBy}>
      <legend>{legend}</legend>
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      <ul>
        {choices.map((c) => {
          const checked = value.includes(c.value);
          const id = `${name}-${c.value}`;
          return (
            <li key={c.value}>
              <input
                type={multiple ? 'checkbox' : 'radio'}
                id={id}
                name={name}
                value={c.value}
                checked={checked}
                onChange={() => {
                  if (multiple)
                    onChange(checked ? value.filter((v) => v !== c.value) : [...value, c.value]);
                  else onChange([c.value]);
                }}
              />
              <label htmlFor={id} className={c.picture ? 'with-picture' : undefined}>
                {c.picture ? <Icon name={c.picture} /> : null}
                <span className="choice-text">
                  <span className="choice-label">{c.label}</span>
                  {c.hint ? <span className="choice-hint">{c.hint}</span> : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p id={errorId} className="error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function Progress({ text }: { text: string }) {
  return (
    <p className="progress" aria-live="polite">
      {text}
    </p>
  );
}

export function Card({ children, tone }: { children: ReactNode; tone?: 'safety' | 'plain' }) {
  return <section className={`card ${tone ?? 'plain'}`}>{children}</section>;
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <div className="buttons">{children}</div>;
}

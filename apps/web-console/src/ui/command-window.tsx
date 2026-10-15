/**
 * The command window in every workspace (layer-7 task C; CON-12, CMD-01,
 * CMD-20–CMD-28, CMD-31–CMD-34, AC-C11, Section 30.2). A native <dialog>
 * opened by an always-visible button, Ctrl+K or Command+K, or "/" when the
 * cursor is not in a text field; the letter can be changed and "/" turned
 * off, and no screen-reader key is taken. Shorthand or plain words go to the
 * server, which answers with a plan; nothing changes until the person
 * confirms it. Questions are labelled form controls; progress and results are
 * announced once in a polite live region. Unsent text stays in this tab only;
 * nothing is replayed by itself after a lost connection (CMD-34).
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { Field } from './primitives.tsx';

interface CommandMeta {
  name: string;
  title: string;
  usage: string;
  phase: number;
  kind: 'lookup' | 'draft' | 'change';
  confirmation: 'none' | 'one_tap' | 'full_review' | 'second_person';
  reversal: 'undo_15_min' | 'compensating' | 'none';
  sideEffects: string;
  enabled?: boolean;
  allowed?: boolean;
}

export interface Execution {
  id: string | null;
  executionId: string;
  status:
    | 'help'
    | 'unsupported'
    | 'clarify'
    | 'not_found'
    | 'denied'
    | 'awaiting_confirmation'
    | 'executing'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'stale';
  message: string;
  usage: string | null;
  command: CommandMeta | null;
  plan: {
    description: string;
    interpretation: string | null;
    target: { kind: string; id: string; label: string } | null;
  } | null;
  planHash: string | null;
  options: { kind: string; id: string; label: string }[];
  result: {
    state: string;
    summary: string | null;
    records: { kind: string; id: string; label?: string }[];
  } | null;
  error: { status: number; code: string; message: string } | null;
  undoUntil: string | null;
  reversalOf: string | null;
  createdAt: string | null;
  commands: (CommandMeta & { enabled: boolean; allowed: boolean })[];
  aliases: { name: string; expansion: string; scope: 'personal' | 'organization' }[];
}

interface Alias {
  id: string;
  version: number;
  scope: 'personal' | 'organization';
  name: string;
  expansion: string;
  mine: boolean;
}

const DRAFT_KEY = 'cg.command.draft';
const PREFS_KEY = 'cg.command.prefs';

interface Prefs {
  /** The letter used with Ctrl or Command. */
  letter: string;
  /** Whether "/" outside a text field opens the window. */
  slash: boolean;
  /** A shared device keeps no command history (CMD-36, Section 30.2). */
  shared: boolean;
}

interface HistoryItem {
  role: 'person' | 'window';
  text: string;
  executionId: string | null;
  createdAt: string;
}

/** Per-person conveniences only; the window works the same without them. */
function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    return {
      letter: typeof p.letter === 'string' && /^[a-z]$/.test(p.letter) ? p.letter : 'k',
      slash: p.slash !== false,
      shared: p.shared === true,
    };
  } catch {
    return { letter: 'k', slash: true, shared: false };
  }
}
function writePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the choice lasts for this page */
  }
}
function readDraft(): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}
function writeDraft(v: string) {
  try {
    if (v) sessionStorage.setItem(DRAFT_KEY, v);
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
}

const typing = (el: Element | null) =>
  !!el &&
  (el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el as HTMLElement).isContentEditable);

/** Where a verified record opens in the console. */
const recordHref = (r: { kind: string; id: string }): string | null => {
  switch (r.kind) {
    case 'mission':
      return `/console/missions/${r.id}`;
    case 'official_report':
      return `/console/official-reports/${r.id}`;
    case 'need':
      return '/console/needs';
    case 'reminder':
      return '/console/reminders';
    default:
      return null;
  }
};

const until = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const reversalText = (c: CommandMeta) =>
  c.reversal === 'undo_15_min'
    ? 'You can undo this for 15 minutes after it runs.'
    : c.reversal === 'compensating'
      ? 'This is not undone here: a mistake is corrected by a new entry, and both stay in the history.'
      : '';

/** What a "which one?" answer sets: the event, the person or the record. */
type Choice = { targetId?: string; eventId?: string; personId?: string };
const choiceOf = (o: { kind: string; id: string }): Choice =>
  o.kind === 'event'
    ? { eventId: o.id }
    : o.kind === 'personnel'
      ? { personId: o.id }
      : { targetId: o.id };

export function CommandWindow({ navigate }: { navigate: (to: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const [text, setText] = useState(readDraft);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<Execution | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [announce, setAnnounce] = useState('');
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [aliases, setAliases] = useState<Alias[] | null>(null);
  const [aliasName, setAliasName] = useState('');
  const [aliasLine, setAliasLine] = useState('');
  const [aliasScope, setAliasScope] = useState<'personal' | 'organization'>('personal');
  const [aliasProblem, setAliasProblem] = useState<string | null>(null);
  const titleId = useId();
  const shortcutLabel = `${navigator.platform.startsWith('Mac') ? 'Command' : 'Ctrl'}+${prefs.letter.toUpperCase()}`;

  const open = useCallback(() => {
    const d = dialog.current;
    if (!d || d.open) return;
    opener.current = document.activeElement as HTMLElement | null;
    d.showModal();
    input.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog.current?.open) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === prefs.letter) {
        e.preventDefault();
        open();
      } else if (
        prefs.slash &&
        e.key === '/' &&
        !mod &&
        !e.altKey &&
        !typing(document.activeElement)
      ) {
        e.preventDefault();
        open();
        setText((t) => t || '/');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs, open]);

  const close = () => dialog.current?.close();
  const onClose = () => {
    opener.current?.focus();
    opener.current = null;
  };

  const settle = (e: Execution) => {
    setCurrent(e);
    setChoice('');
    setAnnounce(
      e.status === 'awaiting_confirmation'
        ? `Plan ready: ${e.plan?.description ?? ''} Check it, then confirm or cancel.`
        : e.message,
    );
  };

  const fail = (err: unknown) => {
    // CMD-34: a lost connection is said plainly; nothing is retried by itself.
    const msg =
      err instanceof ApiFailure
        ? describeFailure(err)
        : 'Not sent: the connection dropped. Nothing changed. Try again when you are connected.';
    setProblem(msg);
    setAnnounce(msg);
  };

  // Choices made while answering "which one?" for this line: a mission, then a person, add up.
  const chosen = useRef<Choice>({});
  const prepare = async (extra: Choice | null = null) => {
    const line = text.trim();
    if (!line) return;
    chosen.current = extra ? { ...chosen.current, ...extra } : {};
    setBusy(true);
    setProblem(null);
    setAnnounce('Working…');
    try {
      const e = await api<Execution>('/commands', {
        body: {
          executionId: crypto.randomUUID(),
          input: line,
          remember: !prefs.shared,
          ...chosen.current,
        },
      });
      settle(e);
      if (e.status !== 'clarify') writeDraft('');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void prepare();
  };

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setProblem(null);
    setAnnounce('Working…');
    try {
      settle(await api<Execution>(path, { body: body ?? {} }));
    } catch (err) {
      if (err instanceof ApiFailure && err.envelope.code === 'plan_stale') {
        const msg = `${err.envelope.message}`;
        setCurrent((c) => (c ? { ...c, status: 'stale', message: msg } : c));
        setAnnounce(msg);
      } else fail(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmPlan = () =>
    current?.id
      ? act(`/commands/${current.id}/confirm`, { planHash: current.planHash })
      : undefined;
  const cancelPlan = () => (current?.id ? act(`/commands/${current.id}/cancel`) : undefined);
  const undo = () =>
    current?.id
      ? act(`/commands/${current.id}/undo`, { executionId: crypto.randomUUID() })
      : undefined;

  const loadHistory = async () => {
    if (prefs.shared) return;
    try {
      setHistory(await api<HistoryItem[]>('/me/command-history?limit=50'));
    } catch (err) {
      fail(err);
    }
  };

  /** CMD-36: clearing the conversation never touches the audit record of what ran. */
  const clearHistory = async () => {
    setBusy(true);
    try {
      const r = await api<{ cleared: number }>('/me/command-history', { method: 'DELETE' });
      setHistory([]);
      setAnnounce(
        `History cleared (${r.cleared} messages). The record of what ran is kept for the audit.`,
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const loadAliases = async () => {
    try {
      setAliases(await api<Alias[]>('/command-aliases'));
    } catch (err) {
      fail(err);
    }
  };

  /** CMD-04: the server checks the name and the expansion; an organization alias asks for a reason. */
  const addAlias = async (ev: FormEvent) => {
    ev.preventDefault();
    setAliasProblem(null);
    try {
      await api('/command-aliases', {
        body: {
          scope: aliasScope,
          name: aliasName.trim().toLowerCase(),
          expansion: aliasLine.trim(),
        },
      });
      setAliasName('');
      setAliasLine('');
      setAnnounce(`Alias /${aliasName.trim().toLowerCase()} saved.`);
      await loadAliases();
    } catch (err) {
      const msg = describeFailure(err);
      setAliasProblem(msg);
      setAnnounce(msg);
    }
  };

  const removeAlias = async (a: Alias) => {
    try {
      await api(`/command-aliases/${a.id}`, { method: 'DELETE', version: a.version });
      setAnnounce(`Alias /${a.name} removed.`);
      await loadAliases();
    } catch (err) {
      fail(err);
    }
  };

  const resultHeading = current
    ? {
        help: 'What you can do here',
        unsupported: 'Not available here',
        clarify: 'One question first',
        not_found: 'Nothing found',
        denied: 'Not allowed for your role',
        awaiting_confirmation: 'Check the plan',
        executing: 'Running',
        succeeded: current.reversalOf
          ? 'Undone'
          : current.result?.state === 'drafted'
            ? 'Drafted'
            : current.result?.state === 'found'
              ? 'Found'
              : 'Saved',
        failed: 'Not done',
        canceled: 'Cancelled',
        stale: 'Prepare it again',
      }[current.status]
    : null;

  return (
    <>
      <button
        type="button"
        className="command-open"
        onClick={open}
        aria-keyshortcuts={`${navigator.platform.startsWith('Mac') ? 'Meta' : 'Control'}+${prefs.letter.toUpperCase()}`}
      >
        Command window <span className="kbd">({shortcutLabel})</span>
      </button>
      <dialog ref={dialog} className="command" aria-labelledby={titleId} onClose={onClose}>
        <div className="command-head">
          <h2 id={titleId}>Command window</h2>
          <button type="button" className="link" onClick={close}>
            Close
          </button>
        </div>
        <form onSubmit={submit}>
          <Field
            label="Command"
            hint="Shorthand starts with / (try /help), or ask in plain words. Nothing changes until you confirm a plan."
            {...(problem ? { error: problem } : {})}
          >
            {({ id, describedBy, invalid }) => (
              <input
                ref={input}
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={text}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setText(e.target.value);
                  writeDraft(e.target.value);
                }}
              />
            )}
          </Field>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Working…' : 'Go'}
            </button>
          </div>
        </form>

        <p className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announce}
        </p>

        {current ? (
          <section className="command-result" aria-labelledby={`${titleId}-r`}>
            <h3 id={`${titleId}-r`}>{resultHeading}</h3>
            {current.status !== 'awaiting_confirmation' ? <p>{current.message}</p> : null}
            {current.usage && ['clarify', 'unsupported', 'not_found'].includes(current.status) ? (
              <p>
                Shorthand: <code>{current.usage}</code>
              </p>
            ) : null}

            {current.status === 'help' ? (
              <ul className="command-help">
                {current.commands
                  .filter((c) => c.enabled && c.allowed)
                  .map((c) => (
                    <li key={c.name}>
                      <code>{c.usage}</code> — {c.title}
                      {c.confirmation === 'none' ? '' : ' (you confirm a plan first)'}
                    </li>
                  ))}
                {current.aliases.map((a) => (
                  <li key={`${a.scope}-${a.name}`}>
                    <code>/{a.name}</code> — alias for <code>{a.expansion}</code>
                    {a.scope === 'organization' ? ' (set for everyone here)' : ' (yours)'}
                  </li>
                ))}
              </ul>
            ) : null}

            {current.status === 'clarify' && current.options.length > 0 ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const o = current.options.find((x) => x.id === choice);
                  if (!o) return;
                  void prepare(choiceOf(o));
                }}
              >
                <fieldset>
                  <legend>Which one?</legend>
                  {current.options.map((o) => (
                    <label key={o.id} className="choice">
                      <input
                        type="radio"
                        name="command-choice"
                        value={o.id}
                        checked={choice === o.id}
                        onChange={() => setChoice(o.id)}
                      />{' '}
                      {o.label}
                    </label>
                  ))}
                </fieldset>
                <div className="actions">
                  <button type="submit" className="primary" disabled={busy || !choice}>
                    Continue
                  </button>
                </div>
              </form>
            ) : null}

            {current.status === 'awaiting_confirmation' && current.plan && current.command ? (
              <>
                <dl className="meta">
                  <dt>What will happen</dt>
                  <dd>{current.plan.description}</dd>
                  {current.plan.interpretation ? (
                    <>
                      <dt>Read as</dt>
                      <dd>
                        <code>{current.plan.interpretation}</code>
                      </dd>
                    </>
                  ) : null}
                  <dt>Effect</dt>
                  <dd>{current.command.sideEffects}</dd>
                  {reversalText(current.command) ? (
                    <>
                      <dt>If it is wrong</dt>
                      <dd>{reversalText(current.command)}</dd>
                    </>
                  ) : null}
                </dl>
                <div className="actions">
                  <button type="button" onClick={() => void cancelPlan()} disabled={busy}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void confirmPlan()}
                    disabled={busy}
                  >
                    Confirm
                  </button>
                </div>
              </>
            ) : null}

            {current.status === 'stale' ? (
              <div className="actions">
                <button type="button" className="primary" onClick={() => void prepare()}>
                  Prepare again
                </button>
              </div>
            ) : null}

            {current.status === 'succeeded' && current.result?.records.length ? (
              <ul className="command-records">
                {current.result.records
                  .map((r) => ({ r, href: recordHref(r) }))
                  .filter((x) => x.href)
                  .slice(0, 10)
                  .map(({ r, href }) => (
                    <li key={`${r.kind}-${r.id}`}>
                      <a
                        href={href!}
                        onClick={(e) => {
                          e.preventDefault();
                          close();
                          navigate(href!);
                        }}
                      >
                        Open {r.label || r.kind.replace('_', ' ')}
                      </a>
                    </li>
                  ))}
              </ul>
            ) : null}

            {current.status === 'succeeded' && current.undoUntil ? (
              <div className="actions">
                <button type="button" onClick={() => void undo()} disabled={busy}>
                  Undo (until {until(current.undoUntil)})
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        <details
          className="command-settings"
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) void loadAliases();
          }}
        >
          <summary>Aliases</summary>
          <p>
            A short name for a line you type often, such as /brief for /sitrep 6. Your own aliases
            can only look things up or draft; the command they stand for is shown before anything
            runs.
          </p>
          {aliases && aliases.length > 0 ? (
            <ul className="command-history">
              {aliases.map((a) => (
                <li key={a.id}>
                  <code>/{a.name}</code> → <code>{a.expansion}</code>
                  {a.scope === 'organization' ? ' (everyone here)' : ''}{' '}
                  {a.mine || a.scope === 'organization' ? (
                    <button type="button" className="link" onClick={() => void removeAlias(a)}>
                      Remove /{a.name}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : aliases ? (
            <p>No aliases yet.</p>
          ) : null}
          <form onSubmit={(e) => void addAlias(e)}>
            <Field label="Alias name" hint="Letters, digits, - or _; for example brief.">
              {({ id, describedBy }) => (
                <input
                  id={id}
                  aria-describedby={describedBy}
                  value={aliasName}
                  autoComplete="off"
                  onChange={(e) => setAliasName(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Stands for"
              hint="One line of shorthand, for example /sitrep 6."
              {...(aliasProblem ? { error: aliasProblem } : {})}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={aliasLine}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setAliasLine(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="For"
              hint="Organization aliases are for administrators and need a reason."
            >
              {({ id, describedBy }) => (
                <select
                  id={id}
                  aria-describedby={describedBy}
                  value={aliasScope}
                  onChange={(e) => setAliasScope(e.target.value as 'personal' | 'organization')}
                >
                  <option value="personal">Just me</option>
                  <option value="organization">Everyone in the organization</option>
                </select>
              )}
            </Field>
            <div className="actions">
              <button type="submit" disabled={!aliasName.trim() || !aliasLine.trim()}>
                Save alias
              </button>
            </div>
          </form>
        </details>

        <details
          className="command-settings"
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) void loadHistory();
          }}
        >
          <summary>Your recent commands</summary>
          {prefs.shared ? (
            <p>History is off on this device because it is marked as shared.</p>
          ) : history === null ? (
            <p>Loading…</p>
          ) : history.length === 0 ? (
            <p>Nothing kept. Commands you give here are kept for 30 days, for you only.</p>
          ) : (
            <>
              <ol className="command-history">
                {history.map((h, i) => (
                  <li key={`${h.createdAt}-${i}`}>
                    <span className="who">{h.role === 'person' ? 'You' : 'Window'}:</span> {h.text}
                  </li>
                ))}
              </ol>
              <div className="actions">
                <button type="button" onClick={() => void clearHistory()} disabled={busy}>
                  Clear my history
                </button>
              </div>
            </>
          )}
        </details>

        <details className="command-settings">
          <summary>Shortcut settings</summary>
          <Field
            label="Letter used with Ctrl or Command"
            hint="Changes the shortcut on this device."
          >
            {({ id, describedBy }) => (
              <select
                id={id}
                aria-describedby={describedBy}
                value={prefs.letter}
                onChange={(e) => {
                  const p = { ...prefs, letter: e.target.value };
                  setPrefs(p);
                  writePrefs(p);
                }}
              >
                {'abcdefghijklmnopqrstuvwxyz'.split('').map((l) => (
                  <option key={l} value={l}>
                    {l.toUpperCase()}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="choice">
            <input
              type="checkbox"
              checked={prefs.slash}
              onChange={(e) => {
                const p = { ...prefs, slash: e.target.checked };
                setPrefs(p);
                writePrefs(p);
              }}
            />{' '}
            Open with / when I am not typing in a field
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={prefs.shared}
              onChange={(e) => {
                const p = { ...prefs, shared: e.target.checked };
                setPrefs(p);
                writePrefs(p);
                if (p.shared) setHistory(null);
              }}
            />{' '}
            This is a shared device: keep no command history
          </label>
        </details>
      </dialog>
    </>
  );
}

/**
 * What the command window knows about the screen behind it (CMD-06, CMD-29,
 * AC-C09). A screen showing one record offers it as context; the window
 * shows it, the person can set it aside, and it is used only when a command
 * says "this". A screen with a form the person has typed into but not saved
 * registers an open draft; a command that would change the same record asks
 * first instead of running over it. Both live in this tab's memory only.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

export type ScreenKind = 'mission' | 'need';

export interface ScreenRecord {
  kind: ScreenKind;
  id: string;
  /** What the window shows, such as the mission number. */
  label: string;
}

export interface OpenDraft {
  kind: ScreenKind;
  id: string;
  /** Which form, in words: "the closing note". */
  form: string;
  /** Puts the cursor back in the form. */
  focus(): void;
  /** Throws the unsaved changes away. */
  discard(): void;
}

let record: ScreenRecord | null = null;
const drafts = new Map<symbol, OpenDraft>();
let draftList: OpenDraft[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** A screen offers the record it shows; null when it shows none. */
export function useScreenRecord(r: ScreenRecord | null) {
  const kind = r?.kind;
  const id = r?.id;
  const label = r?.label;
  useEffect(() => {
    if (!kind || !id) return;
    const mine: ScreenRecord = { kind, id, label: label ?? '' };
    record = mine;
    emit();
    return () => {
      if (record === mine) {
        record = null;
        emit();
      }
    };
  }, [kind, id, label]);
}

/** The record the screen offers now. */
export const useCurrentScreenRecord = () =>
  useSyncExternalStore(
    subscribe,
    () => record,
    () => null,
  );

/** A form registers itself while it holds unsaved changes. */
export function useOpenDraft(
  target: { kind: ScreenKind; id: string } | null,
  dirty: boolean,
  form: string,
  handlers: { focus(): void; discard(): void },
) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  const kind = target?.kind;
  const id = target?.id;
  useEffect(() => {
    if (!dirty || !kind || !id) return;
    const key = Symbol(form);
    drafts.set(key, {
      kind,
      id,
      form,
      focus: () => latest.current.focus(),
      discard: () => latest.current.discard(),
    });
    draftList = [...drafts.values()];
    emit();
    return () => {
      drafts.delete(key);
      draftList = [...drafts.values()];
      emit();
    };
  }, [dirty, kind, id, form]);
}

/** Every open draft now (a stable array between changes). */
export const useOpenDrafts = () =>
  useSyncExternalStore(
    subscribe,
    () => draftList,
    () => draftList,
  );

const CHANGED = 'cg:record-changed';

/** The window says a record changed, so a screen showing it reads it again. */
export function announceChanged(kind: string, id: string) {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { kind, id } }));
}

export function useRecordChanged(kind: ScreenKind, id: string | null, onChange: () => void) {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    if (!id) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ kind: string; id: string }>).detail;
      if (d.kind === kind && d.id === id) latest.current();
    };
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, [kind, id]);
}

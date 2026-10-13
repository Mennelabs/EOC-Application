/**
 * Conflict handling (BRD:FR-00.05, AC-00B, FLD-13, NFR-07): a command built
 * on an older version of a record came back 409 with the record as it is
 * now. Append-only facts never conflict (the server records each by id).
 * For an update: if the fields the person changed are not the fields that
 * moved on the server, the command is rebased onto the current version and
 * re-sent; if the same field moved both ways, a person decides, with both
 * values shown and the local input kept (never overwritten, FLD-13).
 */
import { APPEND_ONLY_KINDS } from './outbox.ts';

export type Resolution =
  | { kind: 'rebase'; version: number; body: Record<string, unknown> }
  | {
      kind: 'needs_person';
      version: number;
      fields: { name: string; mine: unknown; theirs: unknown; base: unknown }[];
    }
  | { kind: 'already_done' }
  | { kind: 'append_only' };

/**
 * `base` is the record as the phone had it when the command was built,
 * `current` the server's record now, `mine` the command body.
 * `appliedCheck` tells whether the current record already reflects the
 * command (for state changes: the state is already what we asked for).
 */
export function reconcile(input: {
  kind: string;
  base: Record<string, unknown> | null;
  current: Record<string, unknown>;
  mine: Record<string, unknown>;
  appliedCheck?: (current: Record<string, unknown>) => boolean;
}): Resolution {
  if (APPEND_ONLY_KINDS.has(input.kind)) return { kind: 'append_only' };
  const version = Number(input.current['version'] ?? 0);
  if (input.appliedCheck?.(input.current)) return { kind: 'already_done' };
  const disputed: { name: string; mine: unknown; theirs: unknown; base: unknown }[] = [];
  for (const [name, mineValue] of Object.entries(input.mine)) {
    if (name === 'version') continue;
    const baseValue = input.base?.[name];
    const theirs = input.current[name];
    const theirsMoved = input.base !== null && !same(baseValue, theirs);
    if (theirsMoved && !same(theirs, mineValue))
      disputed.push({ name, mine: mineValue, theirs, base: baseValue });
  }
  if (disputed.length) return { kind: 'needs_person', version, fields: disputed };
  return { kind: 'rebase', version, body: { ...input.mine } };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

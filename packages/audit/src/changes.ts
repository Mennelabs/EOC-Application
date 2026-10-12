/**
 * Builds the `changes` payload of an audit event (BRD:FR-00.03 "meaningful
 * changes", RULE-07). Values of sensitive or stricter fields are never stored
 * in the audit log; a short hash lets a reviewer prove a value changed and
 * match it against a known value without the log itself leaking it (SEC-11).
 */
import { createHash } from 'node:crypto';

export type FieldClassification = 'public' | 'internal' | 'sensitive' | 'restricted' | 'cji';

export interface FieldChange {
  name: string;
  from?: unknown;
  to?: unknown;
  /** True when the values were replaced by hashes. */
  redacted?: true;
}

export interface AuditChanges {
  fields: FieldChange[];
}

export type Classifier = (field: string) => FieldClassification;

export function hashValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex')
    .slice(0, 16);
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Fields that change on every write and carry no meaning for a reviewer. */
const NOISE = new Set(['updated_at', 'updated_by', 'version']);

export function diffForAudit(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  classify: Classifier,
): AuditChanges {
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const fields: FieldChange[] = [];
  for (const name of [...names].sort()) {
    if (NOISE.has(name)) continue;
    const from = before?.[name];
    const to = after?.[name];
    if (same(from, to)) continue;
    const cls = classify(name);
    if (cls === 'public' || cls === 'internal') {
      const change: FieldChange = { name };
      if (from !== undefined) change.from = from;
      if (to !== undefined) change.to = to;
      fields.push(change);
    } else {
      const change: FieldChange = { name, redacted: true };
      if (from !== undefined) change.from = hashValue(from);
      if (to !== undefined) change.to = hashValue(to);
      fields.push(change);
    }
  }
  return { fields };
}

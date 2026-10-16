/**
 * SCL-10 "Never meter or cap resident reports — intake stays open during any
 * surge regardless of plan", held in the code itself: the only code that
 * reads a contract is the Subscription view (and the operator command that
 * writes one). Intake, SMS, phone, the queue and the worker's jobs never
 * look at it, so no plan, term or tier can slow or stop a report. And no
 * county role reaches `license.write`, even through a wildcard: contracts
 * are the vendor's record.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actionMatches, roleTemplates } from '@cg/authz';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Where a contract may be named: its view, its writer, and the database's own definition. */
const ALLOWED = new Set([
  'services/api/src/routes/license.ts',
  'services/worker/scripts/license.ts',
  'packages/db/src/schema.ts',
  'packages/db/src/dictionary.ts',
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('SCL-10: resident reports are never metered or capped', () => {
  it('no code but the Subscription view and the operator command reads a contract', () => {
    const roots = ['services', 'packages', 'apps'].flatMap((top) =>
      readdirSync(join(ROOT, top))
        .map((d) => join(ROOT, top, d))
        .filter((d) => statSync(d).isDirectory()),
    );
    const offenders = roots
      .flatMap((r) => sources(r))
      .map((p) => relative(ROOT, p))
      .filter((p) => !ALLOWED.has(p) && !p.startsWith('packages/db/src/migrations/'))
      .filter((p) => /cg\.license\b|license_coverage/.test(readFileSync(join(ROOT, p), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no shipped role can write a contract, not even through a wildcard', () => {
    const writers = roleTemplates.filter((t) =>
      t.grants.some((g) => actionMatches(g.action, 'license.write')),
    );
    expect(writers.map((t) => t.key)).toEqual([]);
    // The tenant administrator's '*' still reads it (the Subscription screen).
    const admin = roleTemplates.find((t) => t.key === 'tenant_admin')!;
    expect(admin.grants.some((g) => actionMatches(g.action, 'license.read'))).toBe(true);
  });
});

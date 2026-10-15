/**
 * A write is answered only after its transaction commits (BRD:FR-00.05/00.06,
 * GATE-05). A route that calls `reply.send` inside `request.tx(...)` lets the
 * client see success before the commit, and act on a row that is not yet
 * visible (or never will be, if the commit fails). That raced in the enclave's
 * account and record routes; this guard keeps both APIs free of it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const TX_OPENER = /\.tx\(|transaction\(\)\.execute\(|withAgency\(|withTenant\(/;
const HANDLER = /async \(request(?:, reply)?\) =>/;
const SEND = /reply\s*(?:\.\s*(?:code|status|header)\([^)]*\)\s*)*\.\s*send\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Sends that sit inside a transaction callback, found by walking back over open braces. */
function sendsInsideTransactions(file: string): string[] {
  // A chain the formatter wrapped (`reply` / `.code(201)` / `.send(…)`) is read as one line.
  const lines = readFileSync(file, 'utf8')
    .replace(/\n\s*(?=\.)/g, ' ')
    .split('\n');
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (!SEND.test(line)) return;
    let depth = 0;
    for (let k = index - 1; k >= 0; k--) {
      const l = lines[k]!;
      depth += (l.match(/\}/g)?.length ?? 0) - (l.match(/\{/g)?.length ?? 0);
      if (depth >= 0) continue;
      if (TX_OPENER.test(l)) {
        found.push(`${relative(root, file)}:${index + 1}`);
        return;
      }
      if (HANDLER.test(l)) return;
      depth = 0;
    }
  });
  return found;
}

describe('replies leave after the commit (FR-00.05/00.06)', () => {
  for (const service of ['services/api/src', 'services/cjis-api/src']) {
    it(`${service}: no route sends its reply from inside a transaction`, () => {
      expect(sources(join(root, service)).flatMap(sendsInsideTransactions)).toEqual([]);
    });
  }

  it('the guard finds a send inside a transaction, also when the chain is wrapped', () => {
    const sample = join(import.meta.dirname, 'fixtures', 'send-inside-tx.ts.txt');
    expect(sendsInsideTransactions(sample)).toHaveLength(1);
    const wrapped = join(import.meta.dirname, 'fixtures', 'send-inside-tx-wrapped.ts.txt');
    expect(sendsInsideTransactions(wrapped)).toHaveLength(1);
  });
});

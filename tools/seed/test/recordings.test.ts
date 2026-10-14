/**
 * The recorded reference responses in packages/refdata/recordings are what
 * the generator produces from the seed's geography (ADR-0039, SCL-12): run
 * `pnpm --filter @cg/seed recordings` after changing either. Every response
 * is synthetic: the fictional county 29999 and EXERCISE labels only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRecordings, RECORDINGS_DIR } from '../src/recordings.ts';

describe('recorded reference responses', () => {
  const built = buildRecordings();

  it('match the files in packages/refdata/recordings', () => {
    const onDisk = readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.json'));
    expect(onDisk.sort()).toEqual(Object.keys(built).sort());
    for (const [file, body] of Object.entries(built))
      expect(readFileSync(join(RECORDINGS_DIR, file), 'utf8'), file).toBe(body);
  });

  it('name only the fictional county and mark what a person reads as an exercise', () => {
    const all = Object.values(built).join('\n');
    expect(all).not.toMatch(/"(?:fipsCountyCode|COUNTY|county)":\s*"(?!999|000)\d{3}"/);
    const titled = [
      ...all.matchAll(/"(?:declarationTitle|headline|facility_name|provider_name)":"([^"]+)"/g),
    ].map((m) => m[1]!);
    expect(titled.length).toBeGreaterThan(0);
    for (const t of titled) expect(t).toMatch(/EXERCISE/);
  });
});

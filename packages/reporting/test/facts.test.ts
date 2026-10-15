/**
 * Official report facts without a database (layer-6 task E; F15.02, CON-06,
 * RULE-10, AC-15B): the drafted summary says "unknown" for what is unknown,
 * the comparison names every change, and equal content hashes the same
 * whatever its key order.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  compareFacts,
  contentHash,
  DEFINITIONS,
  draftSummary,
  type Fact,
} from '../src/facts.ts';

const fact = (key: Fact['key'], rows: [string, number | null][]): Fact => ({
  key,
  title: key,
  rows: rows.map(([k, value]) => ({ key: k, label: k, value })),
  note: null,
  definition: DEFINITIONS[key],
  records: [],
});

const facts = (units: number, injured: number | null): Fact[] => [
  fact('damage', [
    ['affected', 1],
    ['minor', 2],
    ['major', 3],
    ['destroyed', units - 6],
    ['units', units],
    ['selfReported', 4],
    ['inaccessible', 2],
  ]),
  fact('reports', [
    ['inPeriod', 12],
    ['awaiting', 5],
  ]),
  fact('outages', [
    ['open', 2],
    ['over72', 1],
  ]),
  fact('casualties', [
    ['injured', injured],
    ['missing', null],
    ['deceased', 0],
  ]),
  fact('shelters', [
    ['open', 1],
    ['occupancy', null],
  ]),
];

describe('official report facts', () => {
  it('drafts the summary from the facts, in the period time zone, unknown never zero (AC-15B)', () => {
    const text = draftSummary(facts(10, null), new Date('2026-10-14T23:00:00Z'), 'America/Chicago');
    expect(text).toContain('As of October 14, 2026 at 6:00 PM');
    expect(text).toContain('10 housing units have verified damage: 4 destroyed, 3 major');
    expect(text).toContain('unknown injured, unknown missing, 0 deceased');
    expect(text).toContain('1 shelters are open with unknown people');
  });

  it('names every change since the last briefing, including a count becoming known (CON-06)', () => {
    const changes = compareFacts(facts(10, null), facts(14, 3));
    expect(changes.map((c) => [c.fact, c.key, c.before, c.after])).toEqual([
      ['damage', 'destroyed', 4, 8],
      ['damage', 'units', 10, 14],
      ['casualties', 'injured', null, 3],
    ]);
    expect(compareFacts(facts(10, 1), facts(10, 1))).toEqual([]);
  });

  it('hashes equal content the same whatever the key order (RULE-10)', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

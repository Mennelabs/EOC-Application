import { describe, expect, it } from 'vitest';
import { count, elapsedLabel, humanize, initials, relativeTime } from '../src/format.ts';

const NOW = Date.parse('2026-10-15T16:00:00Z');

describe('format helpers', () => {
  it('writes elapsed time the way the EOC does', () => {
    expect(elapsedLabel('2026-10-14T01:00:00Z', NOW)).toBe('T+1d 15h');
    expect(elapsedLabel('2026-10-15T12:30:00Z', NOW)).toBe('T+3h');
    expect(elapsedLabel('2026-10-15T16:30:00Z', NOW)).toBe('T+0h');
    expect(elapsedLabel(null, NOW)).toBe('');
    expect(elapsedLabel('not a date', NOW)).toBe('');
  });

  it('writes relative times in plain words', () => {
    expect(relativeTime('2026-10-15T15:59:40Z', NOW)).toBe('just now');
    expect(relativeTime('2026-10-15T15:52:00Z', NOW)).toBe('8 min ago');
    expect(relativeTime('2026-10-15T13:00:00Z', NOW)).toBe('3 h ago');
    expect(relativeTime('2026-10-13T16:00:00Z', NOW)).toBe('2 d ago');
    expect(relativeTime('2026-09-01T16:00:00Z', NOW)).toMatch(/2026|9\/1|1\/9/);
  });

  it('takes initials from names and email addresses', () => {
    expect(initials('Dana Reyes')).toBe('DR');
    expect(initials('dana.director@example.org')).toBe('DD');
    expect(initials('Priya')).toBe('P');
    expect(initials('')).toBe('?');
  });

  it('turns keys into words and keeps the acronyms', () => {
    expect(humanize('planning_gis_lead')).toBe('Planning GIS lead');
    expect(humanize('county_em_director')).toBe('County EM director');
    expect(humanize('under_review')).toBe('Under review');
    expect(humanize('afn_coordinator')).toBe('AFN coordinator');
    expect(humanize('')).toBe('');
  });

  it('formats counts with separators and a dash for nothing', () => {
    expect(count(1612)).toBe((1612).toLocaleString());
    expect(count(null)).toBe('—');
  });
});

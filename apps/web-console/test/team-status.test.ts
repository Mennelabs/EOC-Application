/** BRD:FR-03.04, WCAG 1.4.1: a team's status is never shown by colour alone. */
import { describe, expect, it } from 'vitest';
import { STATUS_MARK, STATUS_TEXT, statusMark } from '../src/screens/team-status.ts';

describe('team status marks', () => {
  it('every status has words, a shape and a letter', () => {
    for (const status of Object.keys(STATUS_TEXT)) {
      const m = STATUS_MARK[status];
      expect(m, status).toBeDefined();
      expect(m!.mark.trim(), status).not.toBe('');
      expect(STATUS_TEXT[status]!.trim(), status).not.toBe('');
    }
  });

  it('no two statuses share both a shape and a letter, and no letter is reused', () => {
    const marks = Object.values(STATUS_MARK);
    expect(new Set(marks.map((m) => m.mark)).size).toBe(marks.length);
    expect(new Set(marks.map((m) => `${m.shape}:${m.mark}`)).size).toBe(marks.length);
  });

  it('statuses that share a colour differ by shape or letter', () => {
    const byTone = new Map<string, string[]>();
    for (const m of Object.values(STATUS_MARK))
      byTone.set(m.tone, [...(byTone.get(m.tone) ?? []), `${m.shape}:${m.mark}`]);
    for (const [, ms] of byTone) expect(new Set(ms).size).toBe(ms.length);
  });

  it('an unknown status reads as a question mark, not a colour', () => {
    expect(statusMark('something_new').mark).toBe('?');
    expect(statusMark(null).mark).toBe('?');
  });
});

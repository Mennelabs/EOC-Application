/**
 * The command window's deadline and percentile helpers (CMD-38, Section
 * 30.2): work that answers in time is returned; work that does not is handed
 * back still running, never dropped; the 95th percentile is the nearest rank.
 */
import { describe, expect, it } from 'vitest';
import { DEADLINE_MS, TARGETS, p95, within } from '../src/commands/timing.ts';

describe('command response targets', () => {
  it('CMD-38: the Section 30.2 targets and the 15 s deadline', () => {
    expect(TARGETS).toEqual({ shorthandMs: 1000, interpretMs: 2500, executeMs: 2000 });
    expect(DEADLINE_MS).toBe(15_000);
  });

  it('CMD-38: work in time is returned; late work is handed back and still finishes', async () => {
    expect(await within(Promise.resolve(7), 50)).toEqual({ done: true, value: 7 });
    let finish: (v: number) => void = () => undefined;
    const slow = new Promise<number>((ok) => {
      finish = ok;
    });
    const r = await within(slow, 5);
    expect(r.done).toBe(false);
    if (!r.done) {
      finish(9);
      expect(await r.later).toBe(9);
    }
  });

  it('CMD-38: a failure in time is a failure, not a timeout', async () => {
    await expect(within(Promise.reject(new Error('refused')), 50)).rejects.toThrow('refused');
  });

  it('CMD-38: the 95th percentile by nearest rank', () => {
    expect(p95([])).toBeNull();
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
  });
});

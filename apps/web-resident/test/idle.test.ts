/**
 * AC-A03, WCAG 2.2.1: the kiosk's confirmation clears for the next person
 * only after two minutes without a touch, with a warning 20 seconds before
 * that the person can answer to get more time. Any touch starts it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleTimer, KIOSK_CONFIRMATION } from '../src/intake/idle.ts';

describe('the kiosk confirmation timer (AC-A03)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('warns 20 s before the end, and "I need more time" starts it again', () => {
    const warned = vi.fn();
    const expired = vi.fn();
    const t = new IdleTimer({ ...KIOSK_CONFIRMATION, onWarn: warned, onExpire: expired });
    t.touch();
    vi.advanceTimersByTime(99_000);
    expect(warned).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    // More time: the full two minutes again.
    t.touch();
    vi.advanceTimersByTime(119_000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('any touch while reading starts it again; Done stops it', () => {
    const expired = vi.fn();
    const t = new IdleTimer({ ...KIOSK_CONFIRMATION, onWarn: () => {}, onExpire: expired });
    t.touch();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(60_000);
      t.touch();
    }
    expect(expired).not.toHaveBeenCalled();
    t.stop();
    vi.advanceTimersByTime(600_000);
    expect(expired).not.toHaveBeenCalled();
  });

  it('never warns less than 20 s ahead (WCAG 2.2.1)', () => {
    expect(
      () => new IdleTimer({ ms: 30_000, warnMs: 10_000, onWarn: () => {}, onExpire: () => {} }),
    ).toThrow();
  });
});

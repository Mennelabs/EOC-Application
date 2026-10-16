/**
 * An inactivity timer that warns before it runs out and can be extended
 * (WCAG 2.2.1 Timing Adjustable, AC-A03, ACC-41). The kiosk's confirmation
 * uses it: the screen stays while the person reads or copies their reference
 * number, and clears for the next person only after a stretch with no touch
 * or key, with a warning they can answer with "I need more time".
 */
export interface IdleOptions {
  /** How long without activity before it runs out. */
  ms: number;
  /** How long before the end the warning shows (at least 20 s, WCAG 2.2.1). */
  warnMs: number;
  onWarn: () => void;
  onExpire: () => void;
}

export class IdleTimer {
  private warnTimer: ReturnType<typeof setTimeout> | undefined;
  private endTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly opts: IdleOptions;

  constructor(opts: IdleOptions) {
    if (opts.warnMs < 20_000 || opts.warnMs >= opts.ms)
      throw new Error('the warning comes at least 20 s before the end');
    this.opts = opts;
  }

  /** Starts, or starts again after any activity or "I need more time". */
  touch(): void {
    if (this.stopped) return;
    this.clear();
    this.warnTimer = setTimeout(() => this.opts.onWarn(), this.opts.ms - this.opts.warnMs);
    this.endTimer = setTimeout(() => {
      this.stopped = true;
      this.opts.onExpire();
    }, this.opts.ms);
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    if (this.warnTimer) clearTimeout(this.warnTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
  }
}

/** The kiosk confirmation: two minutes without a touch, warned 20 seconds before. */
export const KIOSK_CONFIRMATION = { ms: 120_000, warnMs: 20_000 } as const;

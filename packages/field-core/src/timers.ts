/**
 * Check-in timer (DSP-07, FLD-16): the team confirms "We're OK" every
 * interval (default 60 minutes, the team's own setting); the phone reminds
 * the lead before it is due and shows overdue after it; the board's own
 * timer (worker) is the record of a miss, the phone only reminds. Pure
 * functions over a state object so the app can persist it.
 */

export interface TimerState {
  intervalMinutes: number;
  /** When the last confirmation was recorded (ISO), or the check-in time. */
  lastConfirmedAt: string;
  /** Reminder lead time before due (minutes). */
  remindBeforeMinutes: number;
}

export type TimerPhase = 'ok' | 'due_soon' | 'due' | 'overdue';

export function startTimer(now: Date, intervalMinutes = 60, remindBeforeMinutes = 10): TimerState {
  return { intervalMinutes, lastConfirmedAt: now.toISOString(), remindBeforeMinutes };
}

export function dueAt(t: TimerState): Date {
  return new Date(new Date(t.lastConfirmedAt).getTime() + t.intervalMinutes * 60_000);
}

export function remainingMs(t: TimerState, now: Date): number {
  return dueAt(t).getTime() - now.getTime();
}

export function timerPhase(t: TimerState, now: Date): TimerPhase {
  const left = remainingMs(t, now);
  if (left < -60_000) return 'overdue';
  if (left <= 0) return 'due';
  if (left <= t.remindBeforeMinutes * 60_000) return 'due_soon';
  return 'ok';
}

/** "We're OK": the confirmation fact goes through the outbox; the timer restarts from now. */
export function confirmTimer(t: TimerState, now: Date): TimerState {
  return { ...t, lastConfirmedAt: now.toISOString() };
}

/** The next moment the app should wake to remind: the reminder lead, then due, then every 5 minutes while overdue. */
export function nextReminderAt(t: TimerState, now: Date): Date {
  const due = dueAt(t).getTime();
  const remind = due - t.remindBeforeMinutes * 60_000;
  const n = now.getTime();
  if (n < remind) return new Date(remind);
  if (n < due) return new Date(due);
  const over = Math.floor((n - due) / 300_000) + 1;
  return new Date(due + over * 300_000);
}

/** The label the home screen shows: "Due in 42 min", "Due now", "Overdue 7 min". */
export function timerLabel(t: TimerState, now: Date, lang: 'en' | 'es' = 'en'): string {
  const left = remainingMs(t, now);
  const min = Math.ceil(Math.abs(left) / 60_000);
  const phase = timerPhase(t, now);
  if (lang === 'es') {
    if (phase === 'overdue') return `Atrasado ${min} min`;
    if (phase === 'due') return 'Vence ahora';
    return `Vence en ${min} min`;
  }
  if (phase === 'overdue') return `Overdue ${min} min`;
  if (phase === 'due') return 'Due now';
  return `Due in ${min} min`;
}

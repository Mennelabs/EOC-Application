/**
 * The command window's response targets (CMD-38, Section 30.2 as approved
 * 2026-10-15): shorthand prepared in under 1 s, plain words interpreted in
 * under 2.5 s, and a confirmed execution in under 2 s, each at the 95th
 * percentile and measured separately. Nothing waits more than 15 s without
 * an honest answer: the interpretation is given up as timed out, and an
 * execution still running is reported as running, not as done or failed.
 */
export const TARGETS = { shorthandMs: 1000, interpretMs: 2500, executeMs: 2000 } as const;
export const DEADLINE_MS = 15_000;

/** Resolves with the value if it comes in time; otherwise hands back the promise still running. */
export async function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false; later: Promise<T> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms);
  });
  try {
    const first = await Promise.race([work.then((value) => ({ value })), late]);
    return first === 'late' ? { done: false, later: work } : { done: true, value: first.value };
  } finally {
    clearTimeout(timer);
  }
}

/** The 95th percentile by the nearest-rank method; null with no values. */
export function p95(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
}

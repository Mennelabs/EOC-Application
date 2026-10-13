/**
 * Plain words for a step that needs the server (FL:FR-14, FR-19, FR-26,
 * FR-03): no signal, not allowed, or the server's own message.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, OfflineError } from './api';
import type { MessageKey } from './i18n';

export function problem(
  err: unknown,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (err instanceof OfflineError) return t('records.needsSignal');
  if (err instanceof ApiError && err.status === 403 && err.code !== 'pickup_code_mismatch')
    return t('records.notAllowed');
  if (err instanceof ApiError) return err.message;
  return t('common.error', { reason: String(err) });
}

/**
 * A list read from the server for a screen that needs signal: loads when
 * the key changes, again on reload(), and says plainly when it could not.
 * A key of null means "not yet" (no site chosen).
 */
export function useOnline<T>(
  key: string | null,
  load: () => Promise<T>,
): { data: T | null; error: unknown; reload: () => void } {
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: unknown }>({
    data: null,
    error: null,
  });
  useEffect(() => {
    if (key === null) return;
    let live = true;
    loader
      .current()
      .then((data) => {
        if (live) setState({ data, error: null });
      })
      .catch((error: unknown) => {
        if (live) setState({ data: null, error });
      });
    return () => {
      live = false;
    };
  }, [key, tick]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

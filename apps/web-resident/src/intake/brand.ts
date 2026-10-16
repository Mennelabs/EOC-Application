/**
 * The county's branding as the intake page gives it (ADM-01): its name for
 * the header in each language, its website, the header colour (white text
 * reaches 4.5:1, checked by the server) and its own help line. The screens
 * that load the intake page put it here; the page frame reads it. Without it
 * the frame uses the runtime configuration, so nothing waits on it (SCL-06).
 */
import { useSyncExternalStore } from 'react';
import type { IntakeInfo } from '../api/public.ts';

export interface Brand {
  name: string;
  publicName?: { en?: string; es?: string };
  website?: string;
  headerColor?: string;
  helpPhone?: string | null;
}

let current: Brand | null = null;
const listeners = new Set<() => void>();

export const brandStore = {
  get: (): Brand | null => current,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  set(next: Brand | null): void {
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    for (const fn of listeners) fn();
  },
};

export function brandFrom(info: IntakeInfo): Brand {
  const b = info.tenant.branding;
  return {
    name: info.tenant.name,
    ...(b.publicName ? { publicName: b.publicName } : {}),
    // Only an https address is ever linked (the server checks it too).
    ...(b.website && /^https:\/\//.test(b.website) ? { website: b.website } : {}),
    ...(b.headerColor && /^#[0-9a-f]{6}$/i.test(b.headerColor)
      ? { headerColor: b.headerColor }
      : {}),
    helpPhone: info.helpPhone,
  };
}

export const useBrand = () => useSyncExternalStore(brandStore.subscribe, brandStore.get);

/** Display preferences on the phone (see prefs.ts): small, not personal, kept in the Keystore with the rest. */
import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import type { Prefs } from './prefs';
import { defaultSettings } from './theme';

export type { Prefs } from './prefs';

const KEY = 'cgf.prefs';

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return { locale: null, settings: defaultSettings };
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { locale: p.locale ?? null, settings: { ...defaultSettings, ...(p.settings ?? {}) } };
  } catch {
    return { locale: null, settings: defaultSettings };
  }
}

export async function savePrefs(p: Prefs): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(p));
}

export function deviceLanguage(): string | null {
  return getLocales()[0]?.languageTag ?? null;
}

/**
 * Display preferences kept outside the encrypted vault so the sign-in and
 * unlock screens already honour them (FLD-15, EQ-06): language, contrast,
 * target size, one-handed layout, battery saver. Nothing personal.
 */
import type { Locale } from './i18n';
import { defaultSettings, type Settings } from './theme';

const KEY = 'cgf.prefs';

export interface Prefs {
  locale: Locale | null;
  settings: Settings;
}

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { locale: null, settings: defaultSettings };
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { locale: p.locale ?? null, settings: { ...defaultSettings, ...(p.settings ?? {}) } };
  } catch {
    return { locale: null, settings: defaultSettings };
  }
}

export async function savePrefs(p: Prefs): Promise<void> {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: the choice lasts for this visit */
  }
}

export function deviceLanguage(): string | null {
  return typeof navigator !== 'undefined' ? navigator.language : null;
}

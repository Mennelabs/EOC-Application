/**
 * Theme, density and mode preferences (ADR-0045; docs/design/users-and-needs.md §1.5, §1.6).
 *
 * - theme: 'auto' follows the device (prefers-color-scheme); 'light' or 'dark'
 *   fixes it. Light is the default because dark-on-light reads better for every
 *   age; dark stays a choice for night rooms and some low-vision readers.
 * - density: 'comfortable' or 'compact' (table rows and spacing; targets stay 44 px).
 * - mode: 'briefing' is the wall-display mode (CON-11): large type, no personal details.
 *
 * Preferences live in localStorage on the device: they are the device's, not the
 * person's, so a shared EOC workstation keeps its wall settings.
 */
export type ThemePreference = 'auto' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';
export type Mode = 'normal' | 'briefing';
export interface Preferences {
  theme: ThemePreference;
  density: Density;
}

export const PREFERENCES_KEY = 'cg.ui.preferences';
export const DEFAULT_PREFERENCES: Preferences = { theme: 'auto', density: 'comfortable' };

/** The theme in effect for a preference and the device's own setting. */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemDark ? 'dark' : 'light';
}

/** Reads preferences; anything unreadable falls back to the defaults (never throws). */
export function parsePreferences(raw: string | null | undefined): Preferences {
  if (!raw) return { ...DEFAULT_PREFERENCES };
  try {
    const v = JSON.parse(raw) as Partial<Preferences>;
    return {
      theme: v.theme === 'light' || v.theme === 'dark' || v.theme === 'auto' ? v.theme : 'auto',
      density: v.density === 'compact' ? 'compact' : 'comfortable',
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readPreferences(storage: StorageLike | undefined = safeStorage()): Preferences {
  try {
    return parsePreferences(storage?.getItem(PREFERENCES_KEY));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writePreferences(
  prefs: Preferences,
  storage: StorageLike | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  } catch {
    // A private window or a full store: the choice lasts for this page only.
  }
}

function safeStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Puts the preferences on the document so the stylesheet can act on them. */
export function applyPreferences(
  prefs: Preferences,
  root: HTMLElement | null = rootElement(),
): void {
  if (!root) return;
  if (prefs.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', prefs.theme);
  if (prefs.density === 'comfortable') root.removeAttribute('data-density');
  else root.setAttribute('data-density', prefs.density);
}

export function applyMode(mode: Mode, root: HTMLElement | null = rootElement()): void {
  if (!root) return;
  if (mode === 'normal') root.removeAttribute('data-mode');
  else root.setAttribute('data-mode', mode);
}

function rootElement(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/** Applies the stored preferences before the first paint; call it from the app's entry file. */
export function initPreferences(): Preferences {
  const prefs = readPreferences();
  applyPreferences(prefs);
  return prefs;
}

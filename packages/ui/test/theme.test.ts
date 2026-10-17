import { describe, expect, it } from 'vitest';
import {
  applyMode,
  applyPreferences,
  parsePreferences,
  readPreferences,
  resolveTheme,
  writePreferences,
  PREFERENCES_KEY,
} from '../src/theme.ts';

class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}
class FakeRoot {
  attrs = new Map<string, string>();
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
}

describe('theme preferences', () => {
  it('follows the device unless a theme is chosen', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('reads defaults from nothing, garbage or unknown values', () => {
    expect(parsePreferences(null)).toEqual({ theme: 'auto', density: 'comfortable' });
    expect(parsePreferences('{')).toEqual({ theme: 'auto', density: 'comfortable' });
    expect(parsePreferences('{"theme":"sepia","density":"tiny"}')).toEqual({
      theme: 'auto',
      density: 'comfortable',
    });
  });

  it('round-trips through storage and never throws when storage fails', () => {
    const s = new FakeStorage();
    writePreferences({ theme: 'dark', density: 'compact' }, s);
    expect(s.getItem(PREFERENCES_KEY)).toContain('"dark"');
    expect(readPreferences(s)).toEqual({ theme: 'dark', density: 'compact' });
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(() =>
      writePreferences({ theme: 'light', density: 'comfortable' }, broken),
    ).not.toThrow();
    expect(readPreferences(broken)).toEqual({ theme: 'auto', density: 'comfortable' });
  });

  it('puts only non-default choices on the document', () => {
    const root = new FakeRoot();
    applyPreferences({ theme: 'auto', density: 'comfortable' }, root as unknown as HTMLElement);
    expect([...root.attrs.keys()]).toEqual([]);
    applyPreferences({ theme: 'dark', density: 'compact' }, root as unknown as HTMLElement);
    expect(root.attrs.get('data-theme')).toBe('dark');
    expect(root.attrs.get('data-density')).toBe('compact');
    applyMode('briefing', root as unknown as HTMLElement);
    expect(root.attrs.get('data-mode')).toBe('briefing');
    applyMode('normal', root as unknown as HTMLElement);
    expect(root.attrs.has('data-mode')).toBe(false);
  });
});

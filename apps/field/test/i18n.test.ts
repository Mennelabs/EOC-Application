/**
 * Field app strings (EQ-06/07, ADM-03, CON-10): every key exists in English
 * and Spanish with the same placeholders, nothing shouts, the product name
 * never appears, and the 911 line is there in both languages.
 */
import { describe, expect, it } from 'vitest';
import { allKeys, catalogFor, translate } from '../src/i18n.ts';
import { duration, words } from '../src/format.ts';
import { label, vocabularyGroups } from '../src/vocab.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('field app strings', () => {
  it('Spanish has every English key, with the same placeholders', () => {
    const en = catalogFor('en');
    const es = catalogFor('es');
    for (const k of allKeys()) {
      expect(es[k], k).toBeTruthy();
      expect(placeholders(es[k]), k).toEqual(placeholders(en[k]));
    }
  });
  it('no exclamation marks, no product name, no alert-style wording; 911 in both languages', () => {
    for (const l of ['en', 'es'] as const) {
      const all = Object.values(catalogFor(l)).join('\n');
      expect(all).not.toMatch(/!|¡/);
      expect(all).not.toMatch(/common ground/i);
      expect(all).not.toMatch(/emergency alert/i);
      expect(translate(l, 'emergency.call911')).toMatch(/911/);
    }
  });
  it('fills placeholders and formats durations', () => {
    expect(translate('es', 'home.records', { count: 3 })).toBe('Registros en este teléfono: 3.');
    expect(duration('2026-10-13T10:00:00Z', new Date('2026-10-13T12:14:00Z'))).toBe('2 h 14 min');
    expect(duration('2026-10-13T12:00:00Z', new Date('2026-10-13T12:09:30Z'))).toBe('9 min');
    expect(words('downed_line')).toBe('downed line');
  });
  it('every code word has English and Spanish', () => {
    for (const [group, entries] of Object.entries(vocabularyGroups()))
      for (const [code, v] of Object.entries(entries)) {
        expect(v.en, `${group}.${code}`).toBeTruthy();
        expect(v.es, `${group}.${code}`).toBeTruthy();
      }
    expect(label('es', 'hazardKinds', 'downed_line')).toBe('cable eléctrico caído');
    expect(label('es', 'hazardKinds', 'something_new')).toBe('something new');
  });
});

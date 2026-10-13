/**
 * Field app strings (EQ-06/07, ADM-03, CON-10): every key exists in English
 * and Spanish with the same placeholders, nothing shouts, the product name
 * never appears, and the 911 line is there in both languages.
 */
import { describe, expect, it } from 'vitest';
import { allKeys, catalogFor, translate } from '../src/i18n.ts';
import { duration, htmlToLines, words } from '../src/format.ts';
import { DEGREES, STRUCTURES, describe as describeDegree, picture } from '../src/assessment.ts';
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
      // ADM-03: the product name is configuration; the CI check sets PRODUCT_NAME.
      const product = (process.env['PRODUCT_NAME'] ?? 'Test Product').toLowerCase();
      expect(all.toLowerCase()).not.toContain(product);
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

describe('assessment pictures and job aids (FLD-08, FL-15)', () => {
  it('every home type and degree has a description in both languages, and the pictures get worse with the degree', () => {
    for (const s of STRUCTURES)
      for (const d of DEGREES) {
        expect(describeDegree('en', s, d), `${s}/${d}`).toBeTruthy();
        expect(describeDegree('es', s, d), `${s}/${d}`).toBeTruthy();
      }
    const order = ['no_damage', 'affected', 'minor', 'major', 'destroyed'] as const;
    for (const s of ['single_family', 'manufactured'] as const)
      for (let i = 1; i < order.length; i += 1) {
        expect(picture(s, order[i]!).water).toBeGreaterThan(picture(s, order[i - 1]!).water);
        expect(picture(s, order[i]!).roofLoss).toBeGreaterThan(picture(s, order[i - 1]!).roofLoss);
      }
    expect(describeDegree('en', 'manufactured', 'minor')).toMatch(/floor system/);
  });
  it('job aid markup becomes plain lines; scripts and tags never survive', () => {
    const lines = htmlToLines(
      '<h3>Safety</h3><ul><li>Check in &amp; stay with your team.</li><li>Downed lines are live.</li></ul><script>alert(1)</script><p onclick="x()">Call 911.</p>',
    );
    expect(lines).toEqual([
      'Safety',
      '• Check in & stay with your team.',
      '• Downed lines are live.',
      'Call 911.',
    ]);
  });
});

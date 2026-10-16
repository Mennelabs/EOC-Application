/** ADM-01, NFR-09, WCAG 1.4.3: a county's branding is known fields only, readable, and its languages are ones with reviewed pages. */
import { describe, expect, it } from 'vitest';
import {
  brandingIn,
  contrastRatio,
  localeProblem,
  publicBranding,
  publicNameIn,
} from '../src/branding.ts';

describe('county branding (ADM-01)', () => {
  it('WCAG 1.4.3: the header colour must carry white text at 4.5:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#0b4f6c', '#ffffff')).toBeGreaterThan(4.5);
    expect(brandingIn.safeParse({ headerColor: '#0b4f6c' }).success).toBe(true);
    // A yellow and a mid grey are too faint for white text.
    for (const faint of ['#ffcc00', '#888888'])
      expect(brandingIn.safeParse({ headerColor: faint }).success, faint).toBe(false);
    expect(brandingIn.safeParse({ headerColor: 'navy' }).success).toBe(false);
  });

  it('only known fields, an https website and short names are accepted', () => {
    expect(
      brandingIn.safeParse({
        publicName: {
          en: 'Westwind County Office of Emergency Management',
          es: 'Oficina de Emergencias',
        },
        website: 'https://westwind.example.gov',
      }).success,
    ).toBe(true);
    expect(brandingIn.safeParse({ website: 'http://westwind.example.gov' }).success).toBe(false);
    expect(brandingIn.safeParse({ website: 'javascript:alert(1)' }).success).toBe(false);
    expect(brandingIn.safeParse({ logoScript: '<script>' }).success).toBe(false);
    expect(brandingIn.safeParse({ publicName: { fr: 'Comté' } }).success).toBe(false);
    expect(brandingIn.safeParse({ publicName: { en: 'x'.repeat(121) } }).success).toBe(false);
  });

  it('the public pages get the known fields that still pass, nothing else stored', () => {
    expect(
      publicBranding({
        publicName: { en: 'Westwind OEM' },
        website: 'http://old.example.gov',
        headerColor: '#FFCC00',
        internalNote: 'not for residents',
      }),
    ).toEqual({ publicName: { en: 'Westwind OEM' } });
    expect(publicBranding({ headerColor: '#0B4F6C', website: 'https://w.example.gov' })).toEqual({
      headerColor: '#0b4f6c',
      website: 'https://w.example.gov',
    });
    expect(publicBranding(null)).toEqual({});
    expect(publicNameIn({ publicName: { en: 'Westwind OEM' } }, 'en')).toBe('Westwind OEM');
    expect(publicNameIn({ publicName: { en: 'Westwind OEM' } }, 'es')).toBeNull();
  });

  it('NFR-09, EQ-07: residents always get English and Spanish; only languages with reviewed pages', () => {
    expect(localeProblem(['en', 'es'], 'county')).toBeNull();
    expect(localeProblem(['en'], 'county')).toMatch(/English and Spanish are always offered/);
    expect(localeProblem(['en', 'es', 'vi'], 'city')).toMatch(/not offered yet: vi/);
    expect(localeProblem(['en'], 'partner_org')).toBeNull();
    expect(localeProblem(['es'], 'partner_org')).toMatch(/English is always offered/);
  });
});

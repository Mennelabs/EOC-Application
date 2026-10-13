/** Pure pieces of the public intake API: reference codes (INT-22), resident tokens (SEC-09), rate windows (SEC-17). */
import { describe, expect, it } from 'vitest';
import { WindowCounter, hashSubject } from '../src/public/abuse.ts';
import { CODE_PATTERN, normaliseCode, randomCode } from '../src/public/reference-codes.ts';
import { signResidentToken, verifyResidentToken } from '../src/public/resident-token.ts';

describe('reference codes (INT-22)', () => {
  it('generates four letters and four digits without I, L, O, 0 or 1', () => {
    for (let i = 0; i < 500; i++) {
      const code = randomCode();
      expect(code).toMatch(CODE_PATTERN);
      expect(code).not.toMatch(/[ILO01]/);
    }
  });

  it('accepts what people type: lower case, no hyphen, spaces, O for 0 and 1 for I', () => {
    expect(normaliseCode('kxmr4827')).toBe('KXMR-4827');
    expect(normaliseCode('KXMR 4827')).toBe('KXMR-4827');
    // Digits never contain 0 or 1, so an O or an I typed in the digit half cannot form a valid code.
    expect(normaliseCode('KXMR-48O7')).toBeNull();
    expect(normaliseCode('KXMR-48I7')).toBeNull();
    expect(normaliseCode('ABCD-2345')).toBe('ABCD-2345');
    expect(normaliseCode('ABC-2345')).toBeNull();
    expect(normaliseCode('')).toBeNull();
  });
});

describe('resident tokens (SEC-09, RULE-17)', () => {
  const secret = 's'.repeat(40);
  const claims = { tenantId: 't-1', reportId: 'r-1', exp: Math.floor(Date.now() / 1000) + 60 };

  it('round-trips and names exactly one report', () => {
    const token = signResidentToken(secret, claims);
    expect(verifyResidentToken(secret, token)).toEqual(claims);
  });

  it('rejects tampering, another secret and expiry', () => {
    const token = signResidentToken(secret, claims);
    const [body, mac] = token.split('.');
    expect(verifyResidentToken(secret, `${body}x.${mac}`)).toBeNull();
    expect(verifyResidentToken('other'.repeat(8), token)).toBeNull();
    expect(verifyResidentToken(secret, token, (claims.exp + 1) * 1000)).toBeNull();
    expect(verifyResidentToken(secret, 'garbage')).toBeNull();
  });
});

describe('rate windows (SEC-17)', () => {
  it('counts hits inside the window and forgets old ones', () => {
    const c = new WindowCounter(1000);
    expect(c.hit('a', 0)).toBe(1);
    expect(c.hit('a', 500)).toBe(2);
    expect(c.hit('a', 1600)).toBe(1);
    expect(c.hit('b', 1600)).toBe(1);
  });

  it('hashes subjects by kind so an IP and content never collide', () => {
    expect(hashSubject('ip', 'x').equals(hashSubject('content', 'x'))).toBe(false);
    expect(hashSubject('ip', 'x').equals(hashSubject('ip', 'x'))).toBe(true);
  });
});

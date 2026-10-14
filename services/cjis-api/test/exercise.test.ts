/**
 * The exercise link (layer 5, SEC-12): the platform seed and the enclave's
 * exercise data name the same fixed reference, the two systems never talk,
 * and the reference has the shape of a real one (43 base64url characters).
 */
import { describe, expect, it } from 'vitest';
import { EXERCISE_CJI_REF as enclaveRef, EXERCISE_ACCOUNTS } from '../src/provision/exercise.ts';
import { EXERCISE_CJI_REF as platformRef } from '../../../tools/seed/src/load.ts';

describe('exercise link between the platform seed and the enclave (SCL-12)', () => {
  it('both sides know the same opaque reference', () => {
    expect(enclaveRef).toBe(platformRef);
    expect(enclaveRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('every exercise account is invented: example.org subdomains only', () => {
    for (const a of EXERCISE_ACCOUNTS) expect(a.email).toMatch(/@[a-z]+\.example\.org$/);
  });
});

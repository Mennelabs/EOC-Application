/**
 * The enclave realm's configured CJIS values (layer-5 plan §4, ADR-0036):
 * lockout after 5 failures in 15 minutes for 10 minutes (AC-7), 30-minute
 * session idle (AC-11/12), passwords of 15+ characters with history (IA-5),
 * no self-registration and no reset by email, sign-in events recorded (AU-2).
 */
import { describe, expect, it } from 'vitest';
import {
  AUDITED_EVENT_TYPES,
  enclaveRealmSettings,
  enclaveRealmTemplate,
} from '../src/idp/keycloak.ts';

const spec = {
  realm: 'cjis',
  displayName: 'CJIS enclave',
  publicUrl: 'https://localhost:8443',
  adminClientSecret: '0123456789abcdef',
  devAccounts: false,
};

describe('enclave realm settings (SEC-12)', () => {
  const s = enclaveRealmSettings(spec);

  it('locks after five failures within fifteen minutes, for ten minutes (AC-7)', () => {
    expect(s.bruteForceProtected).toBe(true);
    expect(s.permanentLockout).toBe(false);
    expect(s.failureFactor).toBe(5);
    expect(s.maxDeltaTimeSeconds).toBe(900);
    expect(s.waitIncrementSeconds).toBe(600);
    expect(s.maxFailureWaitSeconds).toBe(600);
  });

  it('ends a session after thirty minutes without activity (AC-11, AC-12)', () => {
    expect(s.ssoSessionIdleTimeout).toBe(1800);
    expect(s.clientSessionIdleTimeout).toBe(1800);
    expect(s.accessTokenLifespan).toBeLessThanOrEqual(300);
  });

  it('requires long passwords that are not the username or email and not reused (IA-5)', () => {
    expect(s.passwordPolicy).toContain('length(15)');
    expect(s.passwordPolicy).toContain('notUsername');
    expect(s.passwordPolicy).toContain('notEmail');
    expect(s.passwordPolicy).toContain('passwordHistory(10)');
  });

  it('has no self-registration, no remember-me and no reset by email', () => {
    expect(s.registrationAllowed).toBe(false);
    expect(s.resetPasswordAllowed).toBe(false);
    expect(s.rememberMe).toBe(false);
  });

  it('requires user verification on passkeys (SEC-07)', () => {
    expect(s.webAuthnPolicyUserVerificationRequirement).toBe('required');
  });

  it('records sign-in, failure, lockout and credential events (AU-2)', () => {
    expect(s.eventsEnabled).toBe(true);
    for (const t of ['LOGIN', 'LOGIN_ERROR', 'LOGOUT', 'USER_DISABLED_BY_TEMPORARY_LOCKOUT']) {
      expect(AUDITED_EVENT_TYPES).toContain(t);
    }
    expect(s.enabledEventTypes).toEqual([...AUDITED_EVENT_TYPES]);
  });

  it('names the realm in the template', () => {
    expect(enclaveRealmTemplate(spec).realm).toBe('cjis');
  });
});

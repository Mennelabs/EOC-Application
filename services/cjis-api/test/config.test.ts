/**
 * Enclave configuration (SEC-12, SCL-12): production mode needs a declared
 * authorized environment and a passed state CJIS audit; the second-factor
 * methods default to the passkey only.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, cjisProvisionSchema, cjisSchema, loadConfig } from '@cg/config';

const base = {
  PRODUCT_NAME: 'Test Product',
  CJIS_DATABASE_URL: 'postgres://cjis_app:x@cjis-db:5432/cjis',
  CJIS_OPENBAO_ADDR: 'http://cjis-keys:8200',
  CJIS_IDP_INTERNAL_BASE: 'http://cjis-idp:8080/auth',
  CJIS_IDP_PUBLIC_BASE: 'https://localhost:8443/auth',
};

describe('enclave configuration (SCL-12)', () => {
  it('starts in synthetic mode without declarations', () => {
    const c = loadConfig(cjisSchema, base);
    expect(c.DATA_CLASSIFICATION_MODE).toBe('synthetic');
    expect(c.CJIS_SECOND_FACTORS).toEqual(['hwk']);
    expect(c.CJIS_API_AUDIENCE).toBe('cjis-api');
  });

  it('refuses production mode without an authorized environment and a passed audit', () => {
    expect(() =>
      loadConfig(cjisSchema, { ...base, DATA_CLASSIFICATION_MODE: 'production' }),
    ).toThrow(/CJIS_AUTHORIZED_ENVIRONMENT, CJIS_STATE_AUDIT_PASSED_ON/);
    expect(() =>
      loadConfig(cjisSchema, {
        ...base,
        DATA_CLASSIFICATION_MODE: 'production',
        CJIS_AUTHORIZED_ENVIRONMENT: 'example-gov-cloud',
      }),
    ).toThrow(ConfigError);
  });

  it('accepts production mode once both are declared', () => {
    const c = loadConfig(cjisSchema, {
      ...base,
      DATA_CLASSIFICATION_MODE: 'production',
      CJIS_AUTHORIZED_ENVIRONMENT: 'example-gov-cloud',
      CJIS_STATE_AUDIT_PASSED_ON: '2027-03-01',
    });
    expect(c.DATA_CLASSIFICATION_MODE).toBe('production');
  });

  it('parses the accepted second factors from a list', () => {
    const c = loadConfig(cjisSchema, { ...base, CJIS_SECOND_FACTORS: 'hwk, otp' });
    expect(c.CJIS_SECOND_FACTORS).toEqual(['hwk', 'otp']);
  });

  it('provisioning refuses production mode without the declarations too', () => {
    expect(() =>
      loadConfig(cjisProvisionSchema, {
        PRODUCT_NAME: 'Test Product',
        DATA_CLASSIFICATION_MODE: 'production',
        CJIS_DATABASE_URL: base.CJIS_DATABASE_URL,
        CJIS_IDP_INTERNAL_BASE: base.CJIS_IDP_INTERNAL_BASE,
        CJIS_KC_ADMIN_USER: 'admin',
        CJIS_KC_ADMIN_PASSWORD: 'admin-password',
        CJIS_IDP_ADMIN_CLIENT_SECRET: '0123456789abcdef',
        CJIS_PUBLIC_URL: 'https://localhost:8443',
      }),
    ).toThrow(ConfigError);
  });
});

/**
 * Worker configuration for reference data (ADR-0039, SCL-12): recorded
 * synthetic responses by default, a host list narrowed from configuration,
 * and never the synthetic recordings in production mode.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, workerSchema } from '../src/index.ts';

const env = {
  PRODUCT_NAME: 'Test Product',
  DATABASE_URL: 'postgres://u:p@db:5432/cg',
  AMQP_URL: 'amqp://u:p@queue:5672',
  S3_ENDPOINT: 'http://objects:9000',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret-secret',
  S3_BUCKET: 'bucket',
  OPENBAO_ADDR: 'http://keys:8200',
  OPENBAO_TOKEN_FILE: '/run/token',
  IDP_INTERNAL_BASE: 'http://idp:8080/auth',
  IDP_PUBLIC_BASE: 'https://localhost/auth',
  IDP_HEALTH_URL: 'http://idp:9000/health',
  SMTP_URL: 'smtp://mail:25',
  RESIDENT_TOKEN_SECRET: 'x'.repeat(32),
  KC_ADMIN_USER: 'admin',
  KC_ADMIN_PASSWORD: 'admin-password',
  GATEWAY_PUBLIC_URL: 'https://localhost',
};

describe('worker reference-data settings', () => {
  it('replays recorded responses by default and reads a narrowed host list', () => {
    const c = loadConfig(workerSchema, {
      ...env,
      REFDATA_ALLOWED_HOSTS: ' www.fema.gov, API.census.gov ,',
    });
    expect(c.REFDATA_MODE).toBe('recorded');
    expect(c.REFDATA_ALLOWED_HOSTS).toEqual(['www.fema.gov', 'api.census.gov']);
    expect(
      loadConfig(workerSchema, { ...env, REFDATA_ALLOWED_HOSTS: '' }).REFDATA_ALLOWED_HOSTS,
    ).toBe(undefined);
  });

  it('refuses the synthetic recordings in production mode (SCL-12)', () => {
    expect(() =>
      loadConfig(workerSchema, { ...env, DATA_CLASSIFICATION_MODE: 'production' }),
    ).toThrow(ConfigError);
    expect(
      loadConfig(workerSchema, {
        ...env,
        DATA_CLASSIFICATION_MODE: 'production',
        REFDATA_MODE: 'live',
      }).REFDATA_MODE,
    ).toBe('live');
  });

  it('FLD-13: exercise map packages are off by default and refused in production', () => {
    const c = loadConfig(workerSchema, env);
    expect(c.MAP_EXERCISE).toBe(false);
    expect(c.MAP_TILES_PATH).toBe('/srv/tiles/region.pmtiles');
    expect(loadConfig(workerSchema, { ...env, MAP_EXERCISE: 'true' }).MAP_EXERCISE).toBe(true);
    expect(() =>
      loadConfig(workerSchema, {
        ...env,
        DATA_CLASSIFICATION_MODE: 'production',
        REFDATA_MODE: 'live',
        MAP_EXERCISE: 'true',
      }),
    ).toThrow(ConfigError);
  });

  it('SEC-14: object storage outside a US region is refused at start', () => {
    expect(loadConfig(workerSchema, env).S3_REGION).toBe('us-east-1');
    for (const region of ['us-gov-west-1', 'usgovvirginia', 'US-WEST-2'])
      expect(loadConfig(workerSchema, { ...env, S3_REGION: region }).S3_REGION).toBe(region);
    for (const region of ['eu-west-1', 'ca-central-1', 'ap-southeast-2'])
      expect(() => loadConfig(workerSchema, { ...env, S3_REGION: region })).toThrow(ConfigError);
  });
});

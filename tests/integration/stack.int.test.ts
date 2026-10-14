/**
 * Integration checks against the running compose stack (`docker compose up`).
 * They prove the scaffold's security posture, not features:
 * - every service reports ready by dependency name (SCL-06 inputs);
 * - the CJIS enclave is unreachable from the platform network (SEC-12);
 * - the application database role has no DDL and cannot reach other
 *   databases (ADR-0005, least privilege);
 * - the gateway sets the transport security headers (SEC-10).
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { migrations } from '../../packages/db/src/migrations/index.ts';
import {
  CJIS,
  CJIS_OTP_SECRET,
  CJIS_URL,
  claims,
  enclaveGrant,
  enclaveToken,
  totp,
} from '../support/cjis.ts';

const BASE = process.env['STACK_URL'] ?? 'https://localhost';
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // Caddy local CA in development only.

function compose(...args: string[]): string {
  const files = (process.env['COMPOSE_FILES'] ?? 'compose.yaml')
    .split(',')
    .flatMap((f) => ['-f', f]);
  try {
    return execFileSync('docker', ['compose', ...files, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('readiness', () => {
  it('api reports every dependency ready', async () => {
    const body = JSON.parse(
      compose('exec', '-T', 'api', 'wget', '-qO-', 'http://127.0.0.1:8080/health/ready'),
    ) as {
      status: string;
      checks: { name: string; ok: boolean }[];
    };
    expect(body.status).toBe('ready');
    expect(body.checks.map((c) => c.name).sort()).toEqual([
      'db',
      'idp',
      'keys',
      'mail',
      'objects',
      'queue',
    ]);
  });

  it('cjis-api reports its own database and keys ready', () => {
    const body = JSON.parse(
      compose('exec', '-T', 'cjis-api', 'wget', '-qO-', 'http://127.0.0.1:8080/health/ready'),
    ) as {
      status: string;
    };
    expect(body.status).toBe('ready');
  });
});

describe('CJIS enclave isolation (SEC-12, ADR-0021)', () => {
  it('platform api cannot open the enclave database port', () => {
    const out = compose(
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      'nc -zw2 cjis-db 5432 && echo REACHABLE || echo BLOCKED',
    );
    expect(out).toContain('BLOCKED');
  });

  it('enclave api cannot open the platform database port', () => {
    const out = compose(
      'exec',
      '-T',
      'cjis-api',
      'sh',
      '-c',
      'nc -zw2 db 5432 && echo REACHABLE || echo BLOCKED',
    );
    expect(out).toContain('BLOCKED');
  });

  // Layer 5 (SEC-12, ADR-0021): every enclave service is off the platform network, and the
  // enclave reaches nothing of the platform's.
  it.each([
    ['cjis-idp', 8080],
    ['cjis-api', 8080],
    ['cjis-keys', 8200],
    ['cjis-gateway', 443],
    ['cjis-web', 8080],
  ])('platform api cannot open %s:%i', (host, port) => {
    const out = compose(
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      `nc -zw2 ${host} ${port} && echo REACHABLE || echo BLOCKED`,
    );
    expect(out).toContain('BLOCKED');
  });

  it.each([
    ['idp', 8080],
    ['queue', 5672],
    ['keys', 8200],
    ['objects', 9000],
    ['api', 8080],
  ])('enclave api cannot open platform %s:%i', (host, port) => {
    const out = compose(
      'exec',
      '-T',
      'cjis-api',
      'sh',
      '-c',
      `nc -zw2 ${host} ${port} && echo REACHABLE || echo BLOCKED`,
    );
    expect(out).toContain('BLOCKED');
  });

  it('only the enclave gateway publishes a port, on the loopback address', () => {
    const rows = compose('ps', '--format', '{{.Service}}|{{.Ports}}')
      .split('\n')
      .filter((l) => l.startsWith('cjis-'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [service, ports = ''] = row.split('|');
      if (service === 'cjis-gateway') expect(ports).toMatch(/127\.0\.0\.1:\d+->443/);
      else expect(ports).not.toContain('->');
    }
  });

  it('enclave api answers 403 to anything but health (default deny, ADM-05)', () => {
    const out = compose(
      'exec',
      '-T',
      'cjis-api',
      'sh',
      '-c',
      'wget -S -qO- http://127.0.0.1:8080/missions 2>&1 || true',
    );
    expect(out).toContain('403');
  });
});

describe('CJIS enclave gateway and identity (SEC-12, ADR-0036)', () => {
  it('the enclave realm is served on the enclave origin, never the platform gateway', async () => {
    const res = await fetch(`${CJIS_URL}/auth/realms/cjis/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { issuer: string }).issuer).toBe(`${CJIS_URL}/auth/realms/cjis`);
    expect(
      (await fetch(`${BASE}/auth/realms/cjis/.well-known/openid-configuration`)).status,
    ).not.toBe(200);
  });

  it('hides the identity administration and the master realm', async () => {
    expect((await fetch(`${CJIS_URL}/auth/admin/`)).status).toBe(404);
    expect((await fetch(`${CJIS_URL}/auth/realms/master/`)).status).toBe(404);
  });

  it('serves the enclave app with a strict content security policy', async () => {
    const res = await fetch(`${CJIS_URL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
  });

  it('refuses a password without the second factor', async () => {
    const t = await enclaveGrant(CJIS.records);
    expect(t.access_token).toBeUndefined();
    expect(t.error).toBe('invalid_grant');
  });

  it('a token names the second factor and the enclave API as its audience', async () => {
    const c = claims(await enclaveToken(CJIS.officer));
    expect(c['iss']).toBe(`${CJIS_URL}/auth/realms/cjis`);
    expect(c['amr']).toEqual(expect.arrayContaining(['pwd', 'otp']));
    expect([c['aud']].flat()).toContain('cjis-api');
  });

  it('five wrong passwords lock the account (AC-7)', async () => {
    for (let i = 0; i < 5; i++) {
      await enclaveGrant(CJIS.lockoutDrill, { password: 'not-the-password-0000', totp: '000000' });
    }
    // Locked: even the right password and code are refused for ten minutes.
    const t = await enclaveGrant(CJIS.lockoutDrill, { totp: totp(CJIS_OTP_SECRET) });
    expect(t.access_token).toBeUndefined();
  });
});

describe('database least privilege (ADR-0005)', () => {
  const psql = (db: string, sqlText: string) =>
    compose(
      'exec',
      '-T',
      'db',
      'sh',
      '-c',
      `PGPASSWORD="$CG_APP_PASSWORD" psql -h 127.0.0.1 -U cg_app -d ${db} -c '${sqlText}'`,
    );

  it('cg_app cannot create tables in the cg schema', () => {
    expect(psql('cg', 'create table cg.probe(i int)')).toContain('permission denied for schema cg');
  });

  it('cg_app cannot connect to the keycloak database', () => {
    expect(psql('keycloak', 'select 1')).toContain('CONNECT privilege');
  });

  it("cg_app cannot read the migration ledger (public schema is the migrator's)", () => {
    expect(psql('cg', 'select count(*) from kysely_migration')).toContain('permission denied');
  });

  it('migrations are applied (checked as the database superuser)', () => {
    const out = compose(
      'exec',
      '-T',
      'db',
      'sh',
      '-c',
      `PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d cg -tAc 'select count(*) from kysely_migration'`,
    );
    expect(out.trim()).toBe(String(Object.keys(migrations).length));
  });
});

describe('gateway (SEC-10)', () => {
  it('sets HSTS and nosniff', async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('serves public metadata without secrets (BRD:FR-18.02)', async () => {
    const meta = (await (await fetch(`${BASE}/api/meta`)).json()) as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(['dataMode', 'productName', 'version']);
    expect(meta['dataMode']).toBe('synthetic');
  });
});

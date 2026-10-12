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

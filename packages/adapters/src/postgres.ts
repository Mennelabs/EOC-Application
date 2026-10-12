import pg from 'pg';
import type { Probe } from './health.ts';

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, application_name: 'common-ground' });
}

export function postgresProbe(name: string, pool: pg.Pool): Probe {
  return {
    name,
    async check() {
      await pool.query('select 1');
    },
  };
}

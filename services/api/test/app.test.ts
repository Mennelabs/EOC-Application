import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const base = {
  productName: 'Test Product',
  version: '0.0.0',
  dataMode: 'synthetic' as const,
  logLevel: 'silent',
};

describe('api health and metadata', () => {
  it('liveness does not depend on dependencies', async () => {
    const app = buildApp({
      ...base,
      probes: [{ name: 'db', check: () => Promise.reject(new Error('down')) }],
    });
    const res = await app.inject({ url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('readiness returns 503 and names the failed dependency', async () => {
    const app = buildApp({
      ...base,
      probes: [
        { name: 'db', check: async () => undefined },
        { name: 'queue', check: () => Promise.reject(new Error('down')) },
      ],
    });
    const res = await app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual([
      expect.objectContaining({ name: 'db', ok: true }),
      expect.objectContaining({ name: 'queue', ok: false }),
    ]);
  });

  it('ADM-03: product name comes from configuration', async () => {
    const app = buildApp({ ...base, productName: 'Renamed Product', probes: [] });
    const res = await app.inject({ url: '/api/meta' });
    expect(res.json().productName).toBe('Renamed Product');
  });
});

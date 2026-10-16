/** Request logs never carry a credential (CLAUDE.md rule 9; SCL-09 GIS clients send token=). */
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { redactPaths, redactUrl, serializers } from '../src/logging.ts';

describe('log redaction', () => {
  it('removes credential parameters from logged URLs', () => {
    expect(
      redactUrl('/api/gis/x/pda/FeatureServer/0/query?where=1%3D1&token=cgk_abc_def&f=json'),
    ).toBe('/api/gis/x/pda/FeatureServer/0/query?where=1%3D1&token=[redacted]&f=json');
    expect(redactUrl('/a?TOKEN=x')).toBe('/a?TOKEN=[redacted]');
    expect(redactUrl('/a?api_key=x&key=y')).toBe('/a?api_key=[redacted]&key=[redacted]');
    expect(redactUrl('/a?monkey=1')).toBe('/a?monkey=1');
    // REC-01: an owner's re-check link token, in the API path or the page's query.
    expect(redactUrl('/api/public/facilities/westwind/update/abcDEF_123-xyz?lang=en')).toBe(
      '/api/public/facilities/westwind/update/[redacted]?lang=en',
    );
    expect(redactUrl('/westwind/help?view=offer&update=abc')).toBe(
      '/westwind/help?view=offer&update=[redacted]',
    );
  });

  it('the request serializer uses it, and the API key header is redacted', () => {
    const out = serializers.req({
      method: 'GET',
      url: '/q?token=secret-value',
      hostname: 'h',
      ip: '1.2.3.4',
      socket: { remotePort: 5 },
    } as unknown as FastifyRequest);
    expect(JSON.stringify(out)).not.toContain('secret-value');
    expect(redactPaths).toContain('req.headers["x-api-key"]');
  });
});

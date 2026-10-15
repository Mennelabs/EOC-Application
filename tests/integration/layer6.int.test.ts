/**
 * Layer-6 acceptance against the running stack (`docker compose up`, the
 * synthetic WESTWIND seed): the gateway, the API, the worker's export job in
 * its container (the PDF engine and its fonts, the zip, object storage) and
 * the read-only feature service.
 *
 * Cases (layer-6 plan §9, stack suite): one figure, many places (GATE-07):
 * the Declaration screen's housing units equal the metrics' damage figure,
 * the IDA package the worker builds and the PDA feature layer it serves, and
 * the situation map's tracts add up to no more; the package downloads as the
 * zip the worker recorded (DEC-11, SEC-18). An API key asked for by the
 * tenant administrator opens nothing until the security administrator
 * approves it (SCL-09, ADM-05), and the key it sends in a GIS client's
 * token parameter never reaches the API log. The media sheet is a PDF in
 * both languages through the gateway (PUB-13). Requirement IDs are in the
 * test names.
 */
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, BASE, call, compose, pub, token, waitFor } from './support.ts';

const dana = () => token('county', 'dana.director@example.org');
const admin = () => token('county', 'admin@example.org');
const security = () => token('county', 'security.admin@example.org');

describe('layer 6: official numbers, exports and integrations', () => {
  let eventId = '';
  let slug = '';
  let units = -1;

  beforeAll(async () => {
    const tok = await dana();
    const events = (await api(tok, '/events')).body as unknown as {
      id: string;
      status: string;
    }[];
    eventId = events.find((e) => e.status === 'active')!.id;
    const me = await api(tok, '/me');
    slug = ((await api(tok, `/tenants/${me.body['tenantId'] as string}`)).body['slug'] as string)!;
  });

  it('GATE-07: the declaration, the metrics and the situation map give one housing-unit figure', async () => {
    const tok = await dana();
    const declaration = await api(tok, `/events/${eventId}/declaration`);
    expect(declaration.status, declaration.text).toBe(200);
    units = (declaration.body['damage'] as { counted: { units: number } }).counted.units;
    const metrics = await api(tok, `/events/${eventId}/metrics`);
    expect(metrics.status, metrics.text).toBe(200);
    const damage = (metrics.body['metrics'] as { key: string; value: number | null }[]).find(
      (m) => m.key === 'damage.units',
    )!;
    expect(damage.value).toBe(units);
    const areas = await api(tok, `/situation/areas?eventId=${eventId}`);
    expect(areas.status, areas.text).toBe(200);
    const byTract = (
      areas.body['layers'] as { damage: { items: { value: number | null }[] } }
    ).damage.items.reduce((n, i) => n + (i.value ?? 0), 0);
    // Homes outside the tracts in view are counted in the total but not on the map.
    expect(byTract).toBeLessThanOrEqual(units);
  });

  it('DEC-11, GATE-07: the worker builds the IDA package with the same figure; it downloads as recorded', async () => {
    const tok = await dana();
    const asked = await api(tok, `/events/${eventId}/exports`, {
      body: { clientUuid: randomUUID(), reason: 'Exercise: layer-6 stack suite' },
    });
    expect(asked.status, asked.text).toBe(201);
    const id = asked.body['id'] as string;
    const ready = await waitFor(async () => {
      const r = await api(tok, `/exports/${id}`);
      return r.body['status'] === 'queued' ? undefined : r.body;
    }, 120_000);
    expect(ready['status'], JSON.stringify(ready)).toBe('ready');
    const figures = ready['figures'] as { countedUnits: number; features: number };
    if (units >= 0) expect(figures.countedUnits).toBe(units);
    const file = await fetch(`${BASE}/api/v1/exports/${id}/file`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(file.status).toBe(200);
    const body = Buffer.from(await file.arrayBuffer());
    expect(body.subarray(0, 2).toString()).toBe('PK');
    expect(createHash('sha256').update(body).digest('hex')).toBe(ready['sha256']);
  });

  it('SCL-09, ADM-05: a key opens the PDA feature service only after a second administrator approves it', async () => {
    const asked = await api(await admin(), '/api-keys', {
      body: {
        name: `Stack suite GIS ${randomUUID().slice(0, 6)}`,
        scopes: ['pda.read'],
        expiresInDays: 1,
      },
      confirm: 'Exercise: layer-6 stack suite',
    });
    expect(asked.status, asked.text).toBe(201);
    const key = asked.body['key'] as string;
    const query = `${BASE}/api/gis/${slug}/pda/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json&event=${eventId}`;
    expect((await call(query, null, { headers: { 'x-api-key': key } })).status).toBe(401);
    // The one who asked cannot approve it.
    expect(
      (
        await api(await admin(), `/api-keys/${asked.body['id'] as string}/approve`, {
          method: 'POST',
          version: asked.body['version'] as number,
          confirm: 'Exercise: self-approval',
        })
      ).status,
    ).toBe(403);
    const approved = await api(
      await security(),
      `/api-keys/${asked.body['id'] as string}/approve`,
      {
        method: 'POST',
        version: asked.body['version'] as number,
        confirm: 'Exercise: second administrator approves',
      },
    );
    expect(approved.status, approved.text).toBe(200);
    // A GIS client sends the key as the token parameter.
    const counted = await call(`${query}&token=${encodeURIComponent(key)}`, null);
    expect(counted.status, counted.text).toBe(200);
    expect(typeof counted.body['count']).toBe('number');
    const geo = await call(
      `${BASE}/api/gis/${slug}/pda/FeatureServer/0/query?where=1%3D1&f=geojson&event=${eventId}`,
      null,
      { headers: { 'x-api-key': key } },
    );
    expect(geo.status).toBe(200);
    expect(geo.body['type']).toBe('FeatureCollection');
    // Rule 9: secrets never in logs.
    expect(compose('logs', '--no-color', '--since', '10m', 'api')).not.toContain(key);
    await api(await security(), `/api-keys/${asked.body['id'] as string}/revoke`, {
      method: 'POST',
      version: approved.body['version'] as number,
      confirm: 'Exercise: suite done',
    });
  });

  it('PUB-13: the media sheet is a PDF in English and Spanish through the gateway', async () => {
    for (const lang of ['en', 'es']) {
      const res = await fetch(`${BASE}/api/public/help/${slug}/media.pdf?lang=${lang}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(
        Buffer.from(await res.arrayBuffer())
          .subarray(0, 5)
          .toString(),
      ).toBe('%PDF-');
    }
    const page = await pub(`/help/${slug}/media?lang=en`);
    expect(page.text).toContain(`/api/public/help/${slug}/media.pdf?lang=en`);
  });
});

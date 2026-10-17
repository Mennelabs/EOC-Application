/**
 * Routing and travel times (CON-14, ADR-0046): the OSRM client reads a
 * route's distance, time and line; a router that is off, slow, errs or
 * finds no road yields the straight-line estimate, said so. No stack.
 */
import { describe, expect, it } from 'vitest';
import { osrmRoute, straightLineKm } from '../src/routes/routing.ts';

const from = { lat: 38.79, lon: -90.9 };
const to = { lat: 38.8, lon: -90.88 };
const ok = (body: unknown, status = 200) =>
  (async () =>
    ({
      ok: status < 400,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;

describe('routing (CON-14)', () => {
  it('reads OSRM: distance in km, time in minutes, the line, and asks for one simplified route', async () => {
    let seen = '';
    const fetchFn = (async (url: string | URL | Request) => {
      seen = String(url);
      return {
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [
            {
              distance: 2345.6,
              duration: 318,
              geometry: {
                type: 'LineString',
                coordinates: [
                  [-90.9, 38.79],
                  [-90.89, 38.795],
                  [-90.88, 38.8],
                ],
              },
            },
          ],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await osrmRoute(fetchFn, 'http://routing:5000/', from, to);
    expect(r).toEqual({
      distanceKm: 2.35,
      durationMinutes: 5.3,
      geometry: { type: 'LineString', coordinates: expect.any(Array) },
      source: 'osrm',
    });
    expect(seen).toBe(
      'http://routing:5000/route/v1/driving/-90.9,38.79;-90.88,38.8?overview=simplified&geometries=geojson&alternatives=false&steps=false',
    );
  });

  it('no road, an error, a bad answer or a timeout is null, so the straight line is used and named', async () => {
    expect(await osrmRoute(ok({ code: 'NoRoute', routes: [] }), 'http://r', from, to)).toBeNull();
    expect(await osrmRoute(ok({}, 500), 'http://r', from, to)).toBeNull();
    expect(
      await osrmRoute(ok({ code: 'Ok', routes: [{ distance: 'x' }] }), 'http://r', from, to),
    ).toBeNull();
    const slow = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    expect(await osrmRoute(slow, 'http://r', from, to, 20)).toBeNull();
    const km = straightLineKm(from, to);
    expect(km).toBeGreaterThan(1.9);
    expect(km).toBeLessThan(2.3);
  });
});

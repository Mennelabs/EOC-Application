/**
 * Reference data core (layer-6 task A; ADR-0039, SCL-12, RULE-02): dataset
 * checks, the egress allowlist and URL redaction, retries, recorded responses
 * and file import. No network: fetch is a stand-in.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRow,
  createEgressHttp,
  createRecordedHttp,
  EgressRefused,
  importFields,
  matchRecording,
  NoRecording,
  parseCsv,
  parseImport,
  redactUrl,
  SourceUnavailable,
} from '../src/index.ts';

const square = {
  type: 'Polygon',
  coordinates: [
    [
      [-90.5, 38.5],
      [-90.4, 38.5],
      [-90.4, 38.6],
      [-90.5, 38.6],
      [-90.5, 38.5],
    ],
  ],
};

describe('dataset rows (ADR-0039, RULE-02)', () => {
  it('accepts a tract and keeps unknown values as null', () => {
    const r = checkRow('tract', {
      geoid: '29999000100',
      stateFips: '29',
      countyFips: '29999',
      geometry: square,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row).toMatchObject({ name: null, landM2: null });
  });

  it('names the field, never the value, when a row is wrong', () => {
    const r = checkRow('tract_profile', { geoid: 'not-a-geoid', povertyPct: 140 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.field).sort()).toEqual(['geoid', 'povertyPct']);
      expect(JSON.stringify(r.issues)).not.toContain('not-a-geoid');
    }
  });

  it('refuses a structure without a point and an outage without its time', () => {
    expect(checkRow('structure', { sourceId: 'x', geometry: square }).ok).toBe(false);
    expect(checkRow('power_outage', { countyFips: '29999', customersOut: 10 }).ok).toBe(false);
  });
});

describe('egress (ADR-0039: only allowed hosts, keys never shown)', () => {
  const ok = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it('refuses a host that is not on the allowlist, and plain http', async () => {
    const http = createEgressHttp({
      allowedHosts: ['api.census.gov'],
      fetchImpl: ok({}),
      userAgent: 't',
    });
    await expect(http.getJson('https://evil.example.com/x')).rejects.toBeInstanceOf(EgressRefused);
    await expect(http.getJson('http://api.census.gov/data')).rejects.toBeInstanceOf(EgressRefused);
    await expect(http.getJson('https://api.census.gov/data')).resolves.toEqual({});
  });

  it('redacts keys in URLs', () => {
    expect(redactUrl('https://api.census.gov/data?get=NAME&key=SECRET123')).toBe(
      'https://api.census.gov/data?get=NAME&key=REDACTED',
    );
  });

  it('retries a 503 and gives up on a 404 at once, without the key in the error', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls < 3
        ? new Response('busy', { status: 503 })
        : new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const http = createEgressHttp({
      allowedHosts: ['api.census.gov'],
      fetchImpl: flaky,
      userAgent: 't',
      sleep: async () => undefined,
    });
    await expect(http.getJson('https://api.census.gov/data')).resolves.toEqual([]);
    expect(calls).toBe(3);

    let missing = 0;
    const gone = (async () => {
      missing++;
      return new Response('no', { status: 404 });
    }) as unknown as typeof fetch;
    const http2 = createEgressHttp({
      allowedHosts: ['api.census.gov'],
      fetchImpl: gone,
      userAgent: 't',
      sleep: async () => undefined,
    });
    const err = await http2
      .getJson('https://api.census.gov/data?key=SECRET123')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailable);
    expect(missing).toBe(1);
    expect(String((err as Error).message)).not.toContain('SECRET123');
  });
});

describe('recorded responses (SCL-12: CI never calls the federal services)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refdata-rec-'));
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify([
      {
        host: 'api.census.gov',
        path: '/data/2024/acs/acs5',
        query: { for: 'tract:*' },
        file: 'acs.json',
      },
    ]),
  );
  writeFileSync(join(dir, 'acs.json'), '[["NAME"],["Tract 1"]]');

  it('matches by host, path and the named query parameters, ignoring the rest', async () => {
    const http = createRecordedHttp(dir);
    await expect(
      http.getJson('https://api.census.gov/data/2024/acs/acs5?for=tract:*&in=state:29&key=X'),
    ).resolves.toEqual([['NAME'], ['Tract 1']]);
    expect(matchRecording([], 'https://x.gov/a')).toBeNull();
  });

  it('fails loudly instead of reaching the network', async () => {
    const http = createRecordedHttp(dir);
    await expect(http.getJson('https://api.census.gov/data/other')).rejects.toBeInstanceOf(
      NoRecording,
    );
  });
});

describe('file import (ADR-0039: every dataset can be imported)', () => {
  it('parses RFC 4180 CSV with quotes, doubled quotes, newlines and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n"multi\nline",2\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['multi\nline', '2'],
    ]);
  });

  it('maps CSV columns, coerces numbers and booleans, and builds points from latitude and longitude', () => {
    const csv =
      'ID,Type,Name,Lat,Lon,Beds\nH1,hospital,Westwind General,38.55,-90.45,"1,200"\nS1,school,Oak School,38.56,-90.44,\n';
    const r = parseImport('facility', 'csv', csv, {
      sourceId: 'ID',
      kind: 'Type',
      name: 'Name',
      latitude: 'Lat',
      longitude: 'Lon',
      beds: 'Beds',
    });
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      beds: 1200,
      geometry: { type: 'Point', coordinates: [-90.45, 38.55] },
    });
    expect(r.rows[1]!['beds']).toBeUndefined();
  });

  it('reports errors by row and field and applies nothing when any row is wrong', () => {
    const csv = 'ID,Type,Name\nH1,hospital,General\nH2,castle,Keep\n';
    const r = parseImport('facility', 'csv', csv, { sourceId: 'ID', kind: 'Type', name: 'Name' });
    expect(r.rows).toEqual([]);
    expect(r.errors).toEqual([expect.objectContaining({ row: 2, field: 'kind' })]);
    expect(JSON.stringify(r.errors)).not.toContain('castle');
  });

  it('refuses unknown target fields, missing columns, and areas from CSV', () => {
    expect(parseImport('facility', 'csv', 'a\n1\n', { color: 'a' }).errors[0]!.field).toBe('color');
    expect(parseImport('facility', 'csv', 'a\n1\n', { name: 'b' }).errors[0]!.message).toContain(
      'column not in the file',
    );
    expect(parseImport('tract', 'csv', 'g\n29999000100\n', { geoid: 'g' }).errors[0]!.field).toBe(
      'geometry',
    );
  });

  it('lists the fields a column can map to, with latitude and longitude for points only', () => {
    const facility = importFields('facility');
    expect(facility.find((f) => f.name === 'kind')).toEqual({
      name: 'kind',
      kind: 'text',
      required: true,
    });
    expect(facility.find((f) => f.name === 'beds')).toMatchObject({
      kind: 'number',
      required: false,
    });
    expect(facility.find((f) => f.name === 'latitude')).toMatchObject({ required: false });
    expect(importFields('structure').find((f) => f.name === 'latitude')).toMatchObject({
      required: true,
    });
    expect(importFields('tract').map((f) => f.name)).not.toContain('latitude');
    expect(importFields('tract').map((f) => f.name)).not.toContain('geometry');
  });

  it('knows the kind of each field, nullable numbers and maps of numbers included', () => {
    const kinds = (d: Parameters<typeof importFields>[0]) =>
      Object.fromEntries(importFields(d).map((f) => [f.name, f.kind]));
    expect(kinds('risk')).toEqual({
      geoid: 'text',
      nriRiskScore: 'number',
      nriRiskRating: 'text',
      sviOverall: 'number',
      sviThemes: 'object',
    });
    expect(kinds('tract_profile')).toMatchObject({
      population: 'number',
      povertyPct: 'number',
      languages: 'object',
      moe: 'object',
    });
    expect(kinds('declaration')).toMatchObject({ programs: 'list', declaredOn: 'text' });
    expect(kinds('flood_zone')).toMatchObject({
      specialHazard: 'boolean',
      baseFloodElevation: 'number',
    });
    // Every field said to take a number accepts one, and every text field a text.
    for (const d of [
      'tract',
      'tract_profile',
      'structure',
      'flood_zone',
      'facility',
      'declaration',
      'nfip_summary',
      'risk',
      'alert',
      'power_outage',
    ] as const)
      for (const f of importFields(d))
        if (f.kind === 'number' && !['latitude', 'longitude'].includes(f.name)) {
          expect(
            parseImport(d, 'csv', `${f.name}\n0.5\n`, { [f.name]: f.name }).errors.some(
              (e) => e.field === f.name && /received string/.test(e.message),
            ),
            `${d}.${f.name}`,
          ).toBe(false);
        }
  });

  it('maps GeoJSON properties and keeps the feature geometry', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { GEOID: '29999000100', STATE: '29', COUNTY: '29999', NAME: 'Tract 1' },
          geometry: square,
        },
      ],
    };
    const r = parseImport('tract', 'geojson', JSON.stringify(fc), {
      geoid: 'GEOID',
      stateFips: 'STATE',
      countyFips: 'COUNTY',
      name: 'NAME',
    });
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ geoid: '29999000100', geometry: square });
    expect(parseImport('tract', 'geojson', '{"type":"Feature"}', {}).errors[0]!.message).toContain(
      'FeatureCollection',
    );
  });
});

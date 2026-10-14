/**
 * Connectors against the recorded synthetic WESTWIND responses (ADR-0039,
 * SCL-12): each asks only for geography, maps the source's terms onto the
 * dataset, and never leaves its own hosts.
 */
import { describe, expect, it } from 'vitest';
import {
  checkRow,
  connectorFor,
  connectorHosts,
  connectors,
  createEgressHttp,
  createRecordedHttp,
  declarationRow,
  EgressRefused,
  recordingsDir,
  type ConnectorContext,
  type RawRow,
} from '../src/index.ts';

const westwind: ConnectorContext['scope'] = { stateFips: '29', countyFips: ['29999'] };

async function collect(rows: AsyncIterable<RawRow> | Iterable<RawRow>): Promise<RawRow[]> {
  const out: RawRow[] = [];
  for await (const r of rows) out.push(r);
  return out;
}

describe('connector registry', () => {
  it('names a default connector per dataset, honours a choice, and knows "import"', () => {
    expect(connectorFor('declaration')).toMatchObject({ id: 'openfema.declarations' });
    expect(connectorFor('declaration', 'import')).toBe('import');
    expect(connectorFor('facility', 'openfema.declarations')).toBeUndefined();
  });

  it('lists only https government hosts for egress', () => {
    expect(connectorHosts().every((h) => /\.gov$/.test(h))).toBe(true);
    for (const c of connectors) expect(c.hosts.length).toBeGreaterThan(0);
  });
});

describe('OpenFEMA declarations', () => {
  const c = connectorFor('declaration');
  if (!c || c === 'import') throw new Error('no declaration connector');

  it('reads the recorded WESTWIND declarations, statewide ones included', async () => {
    const result = await c.fetch({
      http: createRecordedHttp(recordingsDir),
      scope: westwind,
      secrets: {},
      now: () => new Date('2026-10-14T12:00:00Z'),
    });
    const rows = await collect(result.rows);
    expect(rows.map((r) => r['disasterNumber'])).toEqual([9903, 9902, 9901]);
    expect(rows[0]).toMatchObject({
      declarationType: 'DR',
      declaredOn: '2024-06-21',
      incidentBegin: '2024-05-19',
      programs: ['IH', 'PA', 'HM'],
      countyFips: '29999',
    });
    expect(rows[1]).toMatchObject({ designatedArea: 'Statewide', countyFips: null });
    for (const r of rows) expect(checkRow('declaration', r).ok).toBe(true);
    expect(result.sourceUrl).toContain('www.fema.gov');
  });

  it('asks only for the state and county codes', async () => {
    const asked: string[] = [];
    const http = createEgressHttp({
      allowedHosts: c.hosts,
      userAgent: 't',
      fetchImpl: (async (url: string) => {
        asked.push(url);
        return new Response('{"DisasterDeclarationsSummaries":[]}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    const r = await c.fetch({ http, scope: westwind, secrets: {}, now: () => new Date() });
    await collect(r.rows);
    expect(asked).toHaveLength(1);
    const filter = new URL(asked[0]!).searchParams.get('$filter');
    expect(filter).toBe(
      "fipsStateCode eq '29' and (fipsCountyCode eq '000' or fipsCountyCode eq '999')",
    );
  });

  it('is refused when the deployment allowlist leaves its host out', async () => {
    const http = createEgressHttp({ allowedHosts: ['api.census.gov'], userAgent: 't' });
    const r = await c.fetch({ http, scope: westwind, secrets: {}, now: () => new Date() });
    await expect(collect(r.rows)).rejects.toBeInstanceOf(EgressRefused);
  });

  it('maps a summary without programs or dates to nulls, never zeros (RULE-02)', () => {
    expect(declarationRow({ disasterNumber: 9999, declarationType: 'FM' })).toMatchObject({
      programs: [],
      declaredOn: null,
      incidentEnd: null,
      countyFips: null,
    });
  });
});

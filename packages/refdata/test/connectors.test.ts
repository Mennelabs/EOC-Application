/**
 * Connectors against the recorded synthetic WESTWIND responses (ADR-0039,
 * SCL-12): each asks only for geography, maps the source's terms onto the
 * dataset, and never leaves its own hosts.
 */
import { describe, expect, it } from 'vitest';
import {
  acsProfileRow,
  checkRow,
  connectorFor,
  countyNameKey,
  connectorHosts,
  connectors,
  createEgressHttp,
  createRecordedHttp,
  declarationRow,
  EgressRefused,
  homeTypeOf,
  recordingsDir,
  summarizePolicies,
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
    expect(connectorFor('tract')).toMatchObject({ id: 'census.tigerweb.tracts' });
    // Released as files or not yet verified: import only.
    expect(connectorFor('risk')).toBeUndefined();
    expect(connectorFor('power_outage')).toBeUndefined();
    expect(connectorFor('declaration', 'import')).toBe('import');
    expect(connectorFor('facility', 'openfema.declarations')).toBeUndefined();
  });

  it('lists only U.S. government hosts (.gov, and USACE on .mil) for egress', () => {
    expect(connectorHosts().every((h) => /\.(gov|mil)$/.test(h))).toBe(true);
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

describe('every connector against its recorded WESTWIND response (SCL-12)', () => {
  const scope: ConnectorContext['scope'] = {
    stateFips: '29',
    countyFips: ['29999'],
    countyNames: ['WESTWIND'],
    bbox: [-90.95, 38.76, -90.75, 38.84],
  };
  const pull = async (dataset: Parameters<typeof connectorFor>[0]) => {
    const c = connectorFor(dataset);
    if (!c || c === 'import') throw new Error(`no connector for ${dataset}`);
    const r = await c.fetch({
      http: createRecordedHttp(recordingsDir),
      scope,
      secrets: { censusApiKey: 'SECRET-KEY' },
      now: () => new Date('2026-10-14T12:00:00Z'),
    });
    const rows = await collect(r.rows);
    for (const row of rows) {
      const checked = checkRow(dataset, row);
      if (!checked.ok) throw new Error(`${dataset}: ${JSON.stringify(checked.issues)}`);
    }
    return { rows, sourceUrl: r.sourceUrl, vintage: r.vintage };
  };

  it('tracts: five, with their codes and outlines', async () => {
    const { rows } = await pull('tract');
    expect(rows.map((r) => r['geoid'])).toEqual([
      '29999000100',
      '29999000200',
      '29999000300',
      '29999000400',
      '29999000500',
    ]);
    expect(rows[0]).toMatchObject({ stateFips: '29', countyFips: '29999', name: 'Census Tract 1' });
  });

  it('tract profiles: shares computed from the tables, a suppressed median null, never the key in the source URL', async () => {
    const { rows, sourceUrl, vintage } = await pull('tract_profile');
    expect(rows).toHaveLength(5);
    const t2 = rows.find((r) => r['geoid'] === '29999000200')!;
    expect(t2['povertyPct']).toBeCloseTo(31, 0);
    expect(t2['age65Pct']).toBeCloseTo(9, 0);
    expect(t2['disabilityPct']).toBeCloseTo(12, 0);
    expect(t2['languages']).toMatchObject({ spanish: expect.any(Number) });
    expect(rows.find((r) => r['geoid'] === '29999000300')!['medianHouseholdIncome']).toBeNull();
    expect(sourceUrl).not.toContain('SECRET-KEY');
    expect(vintage).toBe('ACS 2020-2024 5-year');
  });

  it('structures: one per seed building, typed for FEMA home types, in their tracts', async () => {
    const { rows } = await pull('structure');
    const types = new Map<string, number>();
    for (const r of rows)
      types.set(String(r['homeType']), (types.get(String(r['homeType'])) ?? 0) + 1);
    expect(types.get('manufactured')).toBe(190);
    expect(types.get('multi_family')).toBe(13);
    expect(types.get('public')).toBe(3);
    expect(rows.every((r) => /^29999000[1-5]00$/.test(String(r['tractGeoid'])))).toBe(true);
  });

  it('flood zones: the special flood hazard area flagged, a missing elevation null', async () => {
    const { rows } = await pull('flood_zone');
    expect(rows.filter((r) => r['specialHazard'])).toHaveLength(2);
    expect(rows.find((r) => r['zone'] === 'AE')).toMatchObject({ baseFloodElevation: 452 });
    expect(rows.find((r) => r['zone'] === 'A')).toMatchObject({ baseFloodElevation: null });
  });

  it('flood zones wait for the county outline', async () => {
    const c = connectorFor('flood_zone');
    if (!c || c === 'import') throw new Error('no flood zone connector');
    expect(c.requires).toEqual(['bbox']);
    await expect(
      c.fetch({
        http: createRecordedHttp(recordingsDir),
        scope: { stateFips: '29', countyFips: ['29999'] },
        secrets: {},
        now: () => new Date(),
      }),
    ).rejects.toThrow(/outline/);
  });

  it('facilities: hospitals and nursing homes by county name; coordinates only where CMS has them', async () => {
    const { rows } = await pull('facility');
    expect(rows.map((r) => r['kind'])).toEqual(['hospital', 'nursing_home', 'nursing_home']);
    expect(rows[1]).toMatchObject({ beds: 96, geometry: { type: 'Point' } });
    expect(rows[2]).toMatchObject({ geometry: null });
  });

  it('flood insurance: counts and coverage per county and tract, no policy records', async () => {
    const { rows } = await pull('nfip_summary');
    const county = rows.find((r) => r['areaKind'] === 'county')!;
    expect(county).toMatchObject({ areaId: '29999', policies: 69, asOf: '2026-10-14' });
    expect(county['residentialPolicies']).toBe(66);
    expect(rows.filter((r) => r['areaKind'] === 'tract')).toHaveLength(5);
    expect(Object.keys(county).sort()).toEqual(
      ['areaId', 'areaKind', 'asOf', 'coverageUsd', 'policies', 'residentialPolicies'].sort(),
    );
  });

  it('weather alerts: the county zone, an alert without a polygon kept', async () => {
    const { rows, sourceUrl } = await pull('alert');
    expect(new URL(sourceUrl).searchParams.get('zone')).toBe('MOC999');
    expect(rows.map((r) => r['event'])).toEqual(['Tornado Warning', 'Flood Watch']);
    expect(rows[1]).toMatchObject({ geometry: null });
  });
});

describe('sources that filter by name or answer in tables', () => {
  it('turns a county tenant name into the key CMS uses', () => {
    expect(countyNameKey('Westwind County')).toBe('WESTWIND');
    expect(countyNameKey('St. Louis city')).toBe('ST. LOUIS CITY');
    expect(countyNameKey('Orleans Parish')).toBe('ORLEANS');
  });

  it('maps occupancy classes to FEMA home types; units only where certain (RULE-02)', () => {
    expect(homeTypeOf('RES1-1SNB')).toEqual({ homeType: 'single_family', units: 1 });
    expect(homeTypeOf('RES2')).toEqual({ homeType: 'manufactured', units: 1 });
    expect(homeTypeOf('RES3C')).toEqual({ homeType: 'multi_family', units: null });
    expect(homeTypeOf('EDU1')).toEqual({ homeType: 'public', units: null });
  });

  it('reads Census sentinels as unknown, not as numbers', () => {
    const header = ['B01003_001E', 'B19013_001E', 'state', 'county', 'tract'];
    const row = acsProfileRow(header, ['1200', '-666666666', '29', '999', '000100']);
    expect(row).toMatchObject({
      geoid: '29999000100',
      population: 1200,
      medianHouseholdIncome: null,
    });
    expect(row['povertyPct']).toBeNull();
  });

  it('sums flood insurance by area', () => {
    const rows = summarizePolicies(
      [
        {
          countyCode: '29999',
          censusTract: '29999000100',
          policyCount: 1,
          occupancyType: 11,
          totalBuildingInsuranceCoverage: 100,
        },
        {
          countyCode: '29999',
          censusTract: '29999000100',
          policyCount: 2,
          occupancyType: 18,
          totalContentsInsuranceCoverage: 50,
        },
      ],
      '2026-10-14',
    );
    expect(rows).toEqual([
      {
        areaKind: 'county',
        areaId: '29999',
        policies: 3,
        residentialPolicies: 1,
        coverageUsd: 150,
        asOf: '2026-10-14',
      },
      {
        areaKind: 'tract',
        areaId: '29999000100',
        policies: 3,
        residentialPolicies: 1,
        coverageUsd: 150,
        asOf: '2026-10-14',
      },
    ]);
  });
});

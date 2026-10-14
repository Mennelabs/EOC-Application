/**
 * OpenFEMA disaster declarations (ADR-0039; DCL:DEC-09 narrative on earlier
 * declarations): every declaration that designated one of the tenant's
 * counties or the whole state, newest first. Free, no key, U.S. government work. The request
 * carries only the state and county FIPS codes.
 * https://www.fema.gov/openfema-data-page/disaster-declarations-summaries-v2
 */
import type { Connector } from '../connector.ts';
import type { RawRow } from '../datasets.ts';

const HOST = 'www.fema.gov';
const PAGE = 1000;

interface Summary {
  disasterNumber?: number;
  declarationType?: string;
  declarationTitle?: string;
  incidentType?: string;
  declarationDate?: string;
  incidentBeginDate?: string | null;
  incidentEndDate?: string | null;
  ihProgramDeclared?: boolean;
  iaProgramDeclared?: boolean;
  paProgramDeclared?: boolean;
  hmProgramDeclared?: boolean;
  designatedArea?: string;
  fipsStateCode?: string;
  fipsCountyCode?: string;
}

const day = (v: string | null | undefined): string | null => (v ? v.slice(0, 10) : null);

export function declarationRow(s: Summary): RawRow {
  const programs = [
    s.ihProgramDeclared ? 'IH' : null,
    s.iaProgramDeclared ? 'IA' : null,
    s.paProgramDeclared ? 'PA' : null,
    s.hmProgramDeclared ? 'HM' : null,
  ].filter((p): p is string => p !== null);
  return {
    disasterNumber: s.disasterNumber,
    declarationType: s.declarationType,
    title: s.declarationTitle ?? null,
    incidentType: s.incidentType ?? null,
    declaredOn: day(s.declarationDate),
    incidentBegin: day(s.incidentBeginDate),
    incidentEnd: day(s.incidentEndDate),
    programs,
    designatedArea: s.designatedArea ?? null,
    countyFips:
      s.fipsStateCode && s.fipsCountyCode && s.fipsCountyCode !== '000'
        ? `${s.fipsStateCode}${s.fipsCountyCode}`
        : null,
  };
}

export const openFemaDeclarations: Connector = {
  id: 'openfema.declarations',
  dataset: 'declaration',
  title: 'FEMA disaster declarations (OpenFEMA)',
  licence: 'U.S. government work; OpenFEMA terms of use',
  hosts: [HOST],
  refreshMs: 24 * 3600_000,
  async fetch({ http, scope }) {
    // Statewide designations carry county code 000.
    const counties = ['000', ...scope.countyFips.map((c) => c.slice(2))]
      .map((c) => `fipsCountyCode eq '${c}'`)
      .join(' or ');
    const filter = `fipsStateCode eq '${scope.stateFips}' and (${counties})`;
    const url = (skip: number) => {
      const u = new URL(`https://${HOST}/api/open/v2/DisasterDeclarationsSummaries`);
      u.searchParams.set('$filter', filter);
      u.searchParams.set('$orderby', 'declarationDate desc');
      u.searchParams.set('$top', String(PAGE));
      u.searchParams.set('$skip', String(skip));
      return u.toString();
    };
    async function* rows(): AsyncIterable<RawRow> {
      for (let skip = 0; ; skip += PAGE) {
        const body = (await http.getJson(url(skip))) as {
          DisasterDeclarationsSummaries?: Summary[];
        };
        const page = body.DisasterDeclarationsSummaries ?? [];
        for (const s of page) yield declarationRow(s);
        if (page.length < PAGE) return;
      }
    }
    return { vintage: null, sourceUrl: url(0), rows: rows() };
  },
};

/**
 * OpenFEMA NFIP policies in force (ADR-0039; flood-insurance context for the
 * declaration narrative and the insured share): summed per county and per
 * tract from FEMA's de-identified policy records. Only counts and coverage
 * are kept; no policy record is stored. Free, no key.
 * https://www.fema.gov/openfema-data-page/fima-nfip-redacted-policies-v2
 */
const POLICY_PAGE = 10_000;
/** NFIP occupancy types that are homes (single family, 2–4 units, 5+, manufactured, condo units). */
const RESIDENTIAL = new Set([1, 2, 3, 11, 12, 13, 14, 15, 16]);

interface Policy {
  countyCode?: string;
  censusTract?: string;
  policyCount?: number;
  occupancyType?: number;
  totalBuildingInsuranceCoverage?: number;
  totalContentsInsuranceCoverage?: number;
}

export function summarizePolicies(policies: Iterable<Policy>, asOf: string): RawRow[] {
  const areas = new Map<
    string,
    { kind: 'county' | 'tract'; id: string; n: number; res: number; cov: number }
  >();
  const add = (kind: 'county' | 'tract', id: string, p: Policy) => {
    const key = `${kind}:${id}`;
    const a = areas.get(key) ?? { kind, id, n: 0, res: 0, cov: 0 };
    const count = typeof p.policyCount === 'number' && p.policyCount > 0 ? p.policyCount : 1;
    a.n += count;
    if (typeof p.occupancyType === 'number' && RESIDENTIAL.has(p.occupancyType)) a.res += count;
    a.cov += (p.totalBuildingInsuranceCoverage ?? 0) + (p.totalContentsInsuranceCoverage ?? 0);
    areas.set(key, a);
  };
  for (const p of policies) {
    if (p.countyCode && /^[0-9]{5}$/.test(p.countyCode)) add('county', p.countyCode, p);
    if (p.censusTract && /^[0-9]{11}$/.test(p.censusTract)) add('tract', p.censusTract, p);
  }
  return [...areas.values()]
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'county' ? -1 : 1))
    .map((a) => ({
      areaKind: a.kind,
      areaId: a.id,
      policies: a.n,
      residentialPolicies: a.res,
      coverageUsd: Math.round(a.cov),
      asOf,
    }));
}

export const openFemaNfip: Connector = {
  id: 'openfema.nfip_policies',
  dataset: 'nfip_summary',
  title: 'Flood insurance policies in force (OpenFEMA NFIP)',
  licence: 'U.S. government work; OpenFEMA terms of use',
  hosts: [HOST],
  refreshMs: 30 * 24 * 3600_000,
  async fetch({ http, scope, now }) {
    const today = now().toISOString().slice(0, 10);
    const counties = scope.countyFips.map((c) => `countyCode eq '${c}'`).join(' or ');
    const url = (skip: number) => {
      const u = new URL(`https://${HOST}/api/open/v2/FimaNfipPolicies`);
      u.searchParams.set('$filter', `(${counties}) and policyTerminationDate ge '${today}'`);
      u.searchParams.set(
        '$select',
        'countyCode,censusTract,policyCount,occupancyType,totalBuildingInsuranceCoverage,totalContentsInsuranceCoverage',
      );
      u.searchParams.set('$top', String(POLICY_PAGE));
      u.searchParams.set('$skip', String(skip));
      return u.toString();
    };
    const policies: Policy[] = [];
    for (let skip = 0; ; skip += POLICY_PAGE) {
      const body = (await http.getJson(url(skip))) as { FimaNfipPolicies?: Policy[] };
      const page = body.FimaNfipPolicies ?? [];
      policies.push(...page);
      if (page.length < POLICY_PAGE) break;
    }
    return {
      vintage: `in force on ${today}`,
      sourceUrl: url(0),
      rows: summarizePolicies(policies, today),
    };
  },
};

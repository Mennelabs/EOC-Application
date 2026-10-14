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

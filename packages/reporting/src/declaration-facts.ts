/**
 * The facts a draft of Boxes 8 and 9 of FEMA Form 010-0-13 may state
 * (layer-7 task G; DCL:DEC-14, DEC-17, AI-04). Taken from the declaration
 * view the county already sees, counts and Census aggregates only, never a
 * person (low-income figures as Census aggregates, CLAUDE.md). Unknown stays
 * null, so a draft says it is not known yet rather than giving a number.
 *
 * - Box 8, the damage description: incident type and period, verified homes
 *   by degree, renters and uninsured among the major and destroyed, what is
 *   not verified yet, open outages and those past 72 hours, official
 *   casualty counts, the area's population profile, Public Assistance sites
 *   and their estimated cost.
 * - Box 9, the resources committed: volunteer hours and the people who gave
 *   them, organizations, donated equipment, partner figures the county rolls
 *   up, Public Assistance sites and cost.
 */
import type { DeclarationData } from './declaration.ts';

export interface BoxFact {
  id: string;
  label: string;
  value: string | number | null;
}

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function boxFacts(box: 8 | 9, d: DeclarationData): BoxFact[] {
  const decl = d.declaration;
  const facts: BoxFact[] = [];
  const add = (id: string, label: string, value: string | number | null | undefined) =>
    facts.push({ id, label, value: value ?? null });
  if (box === 8) {
    add('incident.type', 'Incident type', decl?.incidentType);
    add('incident.start', 'Incident period began', decl?.incidentStart);
    add('incident.end', 'Incident period ended', decl?.incidentEnd);
    const c = d.damage.counted;
    add('damage.units', 'Housing units with verified damage', c.units);
    const DEGREE_LABEL = {
      destroyed: 'Units destroyed',
      major: 'Units with major damage',
      minor: 'Units with minor damage',
      affected: 'Units affected',
    } as const;
    for (const k of ['destroyed', 'major', 'minor', 'affected'] as const)
      add(`damage.${k}`, DEGREE_LABEL[k], c.byDegree[k]);
    const heavy = c.cells.filter((x) => x.degree === 'major' || x.degree === 'destroyed');
    const sum = (f: (x: (typeof heavy)[number]) => boolean) =>
      heavy.filter(f).reduce((n, x) => n + x.units, 0);
    add(
      'damage.heavyRenters',
      'Major or destroyed units that are rented',
      sum((x) => x.tenure === 'renter'),
    );
    add(
      'damage.heavyUninsured',
      'Major or destroyed units with no insurance for this damage',
      sum((x) => x.insurance === 'uninsured'),
    );
    add(
      'damage.selfReported',
      'Homes reported by residents and not yet verified',
      d.damage.shownSeparately.selfReported,
    );
    add(
      'damage.inaccessible',
      'Homes that could not be reached',
      d.damage.shownSeparately.inaccessible.total,
    );
    add('outages.open', 'Outages of critical facilities or services still open', d.outages.open);
    add('outages.over72', 'Outages longer than 72 hours', d.outages.over72Hours);
    for (const k of ['injured', 'missing', 'deceased'] as const)
      add(`casualties.${k}`, `Official count of people ${k}`, d.casualties[k]?.count ?? null);
    const p = d.profile?.total;
    add('profile.population', 'Population of the affected area (Census)', p?.population);
    add('profile.households', 'Households in the affected area (Census)', p?.households);
    add(
      'profile.povertyPct',
      'Share of people below the poverty line in the affected area, percent (Census)',
      p?.povertyPct,
    );
    add(
      'profile.age65Pct',
      'Share of people aged 65 or over in the affected area, percent (Census)',
      p?.age65Pct,
    );
    add(
      'profile.disabilityPct',
      'Share of people with a disability in the affected area, percent (Census)',
      p?.disabilityPct,
    );
  } else {
    add('donated.volunteerHours', 'Volunteer hours donated', d.donated.volunteerHours);
    add(
      'donated.people',
      'People who volunteered',
      d.donated.byOrganization.reduce((n, o) => n + o.people, 0),
    );
    add(
      'donated.organizations',
      'Organizations whose volunteers gave hours',
      d.donated.byOrganization.length,
    );
    add('donated.equipment', 'Pieces of donated equipment on duty', d.donated.equipment.length);
    const t = d.partners.totals;
    add('partners.needsMet', 'Requests for help met by partner organizations', t.needsMet);
    add('partners.meals', 'Meals served by partner organizations', t.meals);
    add('partners.waterCases', 'Cases of water handed out by partner organizations', t.waterCases);
    add('partners.tarps', 'Tarps handed out by partner organizations', t.tarps);
    add('partners.shelteredPeople', 'People sheltered by partner organizations', t.shelteredPeople);
    add('partners.teams', 'Partner teams checked in', t.teams);
  }
  const pa = d.publicAssistance;
  add('pa.sites', 'Public damage sites recorded', pa.sites);
  add('pa.totalCost', 'Estimated public damage cost', pa.sites ? money(pa.totalCost) : null);
  return facts;
}

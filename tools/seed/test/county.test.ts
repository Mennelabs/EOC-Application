import { describe, expect, it } from 'vitest';
import { buildCounty, teams, tenants } from '../src/county.ts';

describe('synthetic county (SCL-12)', () => {
  const county = buildCounty(2026, 500);

  it('is deterministic for a given seed', () => {
    expect(JSON.stringify(buildCounty(2026, 500))).toBe(JSON.stringify(county));
  });

  it('marks every record as synthetic', () => {
    const records = [
      ...county.tenants,
      ...county.areas,
      ...county.facilities,
      ...county.personnel,
      ...county.reports,
      ...county.parcels.features.map((f) => f.properties),
    ];
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(r.synthetic).toBe(true);
  });

  it('uses only fictional phone numbers and reserved email domains', () => {
    const phones = [
      ...county.personnel.map((p) => p.phone),
      ...county.reports.flatMap((r) => (r.contactPhone ? [r.contactPhone] : [])),
    ];
    for (const p of phones) expect(p).toMatch(/^\+1\d{3}55501\d{2}$/);
    for (const p of county.personnel) expect(p.email.endsWith('@example.org')).toBe(true);
  });

  it('keeps the WESTWIND tenant hierarchy (SCL-01)', () => {
    const byKey = new Map(county.tenants.map((t) => [t.key, t]));
    expect(byKey.get('county')?.parent).toBe('region');
    expect(byKey.get('region')?.parent).toBe('state');
    expect(
      county.tenants.filter((t) => t.kind === 'partner_org').every((t) => t.parent === 'county'),
    ).toBe(true);
  });

  it('roughly follows the WESTWIND channel mix', () => {
    const web = county.reports.filter((r) => r.channel === 'web').length / county.reports.length;
    expect(web).toBeGreaterThan(0.5);
    expect(web).toBeLessThan(0.72);
  });

  it('field roster: every team names a tenant, keys and names are unique, credentials are recorded per member (DSP-02, PER-01)', () => {
    const tenantKeys = new Set(tenants.map((t) => t.key));
    expect(new Set(teams.map((t) => t.key)).size).toBe(teams.length);
    const names = teams.flatMap((t) => t.members.map((m) => m.name));
    expect(new Set(names).size).toBe(names.length);
    for (const team of teams) {
      expect(tenantKeys.has(team.tenant), team.key).toBe(true);
      expect(team.members.filter((m) => m.role === 'lead')).toHaveLength(1);
      for (const m of team.members) {
        expect(m.credentials.length, m.key).toBeGreaterThan(0);
        expect(m.hoursLimit).toBeGreaterThan(0);
      }
    }
    expect(teams.find((t) => t.key === 'chainsaw-b')?.tenant).toBe('cleanup');
    expect(teams.find((t) => t.key === 'canteen-2')?.tenant).toBe('canteen');
    expect(teams.find((t) => t.key === 'guard-tc-1')?.kind).toBe('unit');
  });

  it('field roster is the same on every run (its own seed)', () => {
    expect(JSON.stringify(teams)).toBe(JSON.stringify(teams));
    expect(teams.length).toBeGreaterThanOrEqual(12);
  });
});

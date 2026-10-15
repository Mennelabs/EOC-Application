import { describe, expect, it } from 'vitest';
import { actions, actionMatches } from '../src/actions.ts';
import { validateGrants } from '../src/grants.ts';
import { previewRole } from '../src/preview.ts';
import { CATEGORY_TEMPLATES, roleTemplates } from '../src/templates.ts';

describe('shipped role templates (ADM-04)', () => {
  it('every template validates as county-editable grants', () => {
    for (const t of roleTemplates) {
      const v = validateGrants(t.grants);
      expect(v.errors, t.key).toEqual([]);
    }
  });

  it('every grant pattern matches at least one catalog action', () => {
    for (const t of roleTemplates) {
      for (const g of t.grants) {
        const hits = Object.keys(actions).filter((k) => actionMatches(g.action, k));
        expect(hits.length, `${t.key}: ${g.action}`).toBeGreaterThan(0);
      }
    }
  });

  it('template keys are unique and every protected-category template exists', () => {
    const keys = roleTemplates.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const list of Object.values(CATEGORY_TEMPLATES)) {
      for (const key of list ?? []) expect(keys).toContain(key);
    }
  });

  it('preview: tenant_admin can do everything in layer 1 except see protected fields', () => {
    const admin = roleTemplates.find((t) => t.key === 'tenant_admin')!;
    const p = previewRole(admin.grants, admin.key);
    // Live positions are for dispatch and safety roles only, the CJIS enclave link for the
    // liaison, official casualty counts, issuing official reports and joint-assessment
    // validation for roles that name them: no wildcard reaches them (DSP-08, SEC-12,
    // DCL:DEC-08, RULE-10, FL:FR-10).
    expect(p.deniedActions.sort()).toEqual([
      'casualty.record',
      'joint_assessment.validate',
      'mission.cji.link',
      'mission.cji.open',
      'official_report.issue',
      'position.read',
    ]);
    expect(p.visibleCategories).not.toContain('health');
    expect(p.hiddenCategories.map((h) => h.category)).toEqual(
      expect.arrayContaining(['health', 'counseling', 'legal', 'cji']),
    );
  });

  it('RULE-10, A7: only the EM director issues official reports; reporting staff draft them', () => {
    const holders = (action: string) =>
      roleTemplates.filter((t) => t.grants.some((g) => g.action === action)).map((t) => t.key);
    expect(holders('official_report.issue')).toEqual(['county_em_director']);
    expect(holders('official_report.draft').sort()).toEqual([
      'county_em_director',
      'reporting_planning',
    ]);
  });

  it('FL:FR-10, DEC-13: who validates the joint sample, and who sees a county through an agreement', () => {
    const holders = (action: string) =>
      roleTemplates
        .filter((t) => t.grants.some((g) => g.action === action))
        .map((t) => t.key)
        .sort();
    expect(holders('joint_assessment.validate')).toEqual([
      'damage_assessment_coordinator',
      'fema_validator',
    ]);
    expect(holders('shared_declaration.read')).toEqual(['state_liaison']);
    const validator = roleTemplates.find((t) => t.key === 'fema_validator')!;
    expect(validator.maxAssignmentDays).toBe(30);
    // The validator sees the sample, never reports, photos or residents.
    expect(validator.grants.map((g) => g.action).sort()).toEqual([
      'event.read',
      'joint_assessment.read',
      'joint_assessment.validate',
      'me.read',
      'tenant.read',
    ]);
  });

  it('SEC-12: only the law-enforcement liaison links missions to the CJIS enclave', () => {
    const holders = roleTemplates
      .filter((t) => t.grants.some((g) => g.action === 'mission.cji.link'))
      .map((t) => t.key);
    expect(holders).toEqual(['law_enforcement_liaison']);
    const liaison = roleTemplates.find((t) => t.key === 'law_enforcement_liaison')!;
    const p = previewRole(liaison.grants, liaison.key);
    expect(p.allowedActions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['mission.cji.link', 'mission.cji.open', 'mission.read']),
    );
    expect(p.visibleCategories).not.toContain('cji');
  });

  it('preview: shelter nurse sees health, PIO sees nothing restricted', () => {
    const nurse = roleTemplates.find((t) => t.key === 'shelter_nurse')!;
    expect(previewRole(nurse.grants, nurse.key).visibleCategories).toEqual(
      expect.arrayContaining(['basic', 'contact', 'health', 'access_needs']),
    );
    const pio = roleTemplates.find((t) => t.key === 'public_information_officer')!;
    const p = previewRole(pio.grants, pio.key);
    expect(p.visibleCategories).toEqual(['basic']);
    expect(p.allowedActions.map((a) => a.action)).not.toContain('personnel.read');
  });

  it('preview and runtime agree: an allowed preview action is allowed at runtime with the same grants', () => {
    const t = roleTemplates.find((x) => x.key === 'security_admin')!;
    const p = previewRole(t.grants, t.key);
    expect(p.allowedActions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['audit.read', 'break_glass.start']),
    );
    expect(p.deniedActions).toContain('event.create');
  });

  it('layer 4 roster: positions are for dispatch and safety roles only; volunteers record, never read (DSP-08)', () => {
    const can = (key: string, action: string) =>
      previewRole(roleTemplates.find((t) => t.key === key)!.grants, key).allowedActions.some(
        (a) => a.action === action,
      );
    for (const key of ['field_coordinator', 'agency_dispatcher', 'safety_officer', 'net_control']) {
      expect(can(key, 'position.read'), key).toBe(true);
    }
    for (const key of [
      'field_volunteer',
      'team_lead',
      'damage_assessor',
      'canvasser',
      'cleanup_crew_lead',
      'shelter_worker',
      'public_information_officer',
      'tenant_admin',
    ]) {
      expect(can(key, 'position.read'), key).toBe(false);
    }
    for (const key of ['field_volunteer', 'team_lead', 'damage_assessor', 'shelter_worker']) {
      expect(can(key, 'position.record'), key).toBe(true);
      expect(can(key, 'check_in.create'), key).toBe(true);
    }
    // Credentials are recorded by coordinators and agency dispatchers, never by the person (PER-01, FR-05.04).
    expect(can('personnel_coordinator', 'credential.record')).toBe(true);
    expect(can('agency_dispatcher', 'credential.record')).toBe(true);
    expect(can('field_volunteer', 'credential.record')).toBe(false);
    expect(can('team_lead', 'credential.record')).toBe(false);
    // Net control logs for teams but never reads a resident record (DSP-10).
    expect(can('net_control', 'check_in.manage')).toBe(true);
    expect(can('net_control', 'report.read')).toBe(false);
    expect(can('net_control', 'shared.read')).toBe(false);
  });
});

describe('field roles see only their own work (FLD-14)', () => {
  it('frontline roles read and act on held missions and assignments only; dispatch, safety and net control see all', async () => {
    const { roleTemplates } = await import('../src/templates.ts');
    const grantFor = (key: string, action: string) =>
      roleTemplates.find((t) => t.key === key)!.grants.filter((g) => g.action === action);
    for (const key of [
      'field_volunteer',
      'team_lead',
      'damage_assessor',
      'canvasser',
      'search_rescue',
    ]) {
      for (const action of ['assignment.read', 'assignment.acknowledge', 'assignment.status']) {
        const gs = grantFor(key, action);
        expect(gs.length, `${key} ${action}`).toBeGreaterThan(0);
        expect(
          gs.every((g) => g.records === 'own'),
          `${key} ${action}`,
        ).toBe(true);
      }
      expect(
        grantFor(key, 'mission.read').every((g) => g.records === 'own'),
        key,
      ).toBe(true);
    }
    for (const key of ['dispatcher_call_taker', 'safety_officer', 'net_control']) {
      expect(
        grantFor(key, 'assignment.read').every((g) => (g.records ?? 'all') === 'all'),
        key,
      ).toBe(true);
    }
  });
});

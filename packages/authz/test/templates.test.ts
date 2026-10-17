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
    // liaison, official casualty counts, issuing official reports, joint-assessment
    // validation, a partner's own posting and qualifying discovered places for roles that name
    // them: no wildcard reaches them (DSP-08, SEC-12, DCL:DEC-08, RULE-10, FL:FR-10, partner
    // posting 2026-10-15, REC-13) and the conversation scribe, which only frontline roles use
    // with a survivor's consent (FL-04). Batches from the command window are for those who
    // coordinate needs (CMD-30); public-records releases are for those who answer the requests
    // (SEC-13); finding a survivor's report without their code is for frontline readers (FL-02),
    // and documents survivors share are for those who meet them and those who verify (FL-09);
    // a health notice is approved by public health or the county's public voices (FL:FR-06).
    // A county's subscription is the vendor's record: no county role writes it (SCL-10).
    // Field guidance is approved by the roles that answer for it, never the last editor (FL-15).
    expect(p.deniedActions.sort()).toEqual([
      'casualty.record',
      'command.bulk',
      'discovery.review',
      'document.capture',
      'document.read',
      'facility.approve',
      'health_notice.approve',
      'job_aid.approve',
      'joint_assessment.validate',
      'license.write',
      'mission.cji.link',
      'mission.cji.open',
      'official_report.issue',
      'position.read',
      'public_records.export',
      'resource_request.approve',
      'scribe.read',
      'scribe.use',
      'site.post',
      'site.post_publish',
      'survivor.find',
      'translation.use',
    ]);
    expect(p.visibleCategories).not.toContain('health');
    expect(p.hiddenCategories.map((h) => h.category)).toEqual(
      expect.arrayContaining(['health', 'counseling', 'legal', 'cji']),
    );
  });

  it('FL-04, FL-05, FL:FR-16: frontline roles use the scribe; counselors, chaplains and nurses never do', () => {
    const holders = (action: string) =>
      roleTemplates.filter((t) => t.grants.some((g) => g.action === action)).map((t) => t.key);
    expect(holders('scribe.use')).not.toContain('crisis_counselor');
    expect(holders('scribe.use')).not.toContain('shelter_nurse');
    expect(holders('scribe.use')).toEqual(
      expect.arrayContaining(['shelter_worker', 'case_manager', 'field_volunteer', 'canvasser']),
    );
    expect(holders('scribe.read')).toEqual(['case_manager']);
    // FL-14: the same frontline roles may use machine translation; never the nurse (medical).
    expect(holders('translation.use').sort()).toEqual(holders('scribe.use').sort());
    for (const key of holders('translation.use'))
      expect(holders('interpreter.request')).toContain(key);
  });

  it('REC-13: county EM and planning review discovered places; county EM and the administrator name sources', () => {
    const holders = (action: string) =>
      roleTemplates.filter((t) => t.grants.some((g) => g.action === action)).map((t) => t.key);
    expect(holders('discovery.review').sort()).toEqual(['county_em_director', 'planning_gis_lead']);
    expect(holders('discovery.manage').sort()).toEqual(['county_em_director', 'tenant_admin']);
  });

  it('CON-13: the EM director alone approves resource requests; logistics places them', () => {
    const holders = (action: string) =>
      roleTemplates
        .filter((t) => t.grants.some((g) => g.action === action))
        .map((t) => t.key)
        .sort();
    expect(holders('resource_request.approve')).toEqual(['county_em_director']);
    expect(holders('resource_request.place')).toEqual(['county_em_director', 'field_coordinator']);
    expect(holders('resource_request.submit')).toEqual(
      expect.arrayContaining(['planning_gis_lead', 'mass_care_coordinator', 'afn_coordinator']),
    );
  });

  it('partner posting (2026-10-15): only the NGO incident commander posts its own services', () => {
    const holders = (action: string) =>
      roleTemplates.filter((t) => t.grants.some((g) => g.action === action)).map((t) => t.key);
    expect(holders('site.post')).toEqual(['ngo_incident_commander']);
    expect(holders('site.post_publish')).toEqual(['ngo_incident_commander']);
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

  it('CON-12, CMD-21: every role but the FEMA validator opens the command window', () => {
    const without = roleTemplates
      .filter((t) => !t.grants.some((g) => g.action === 'command.use'))
      .map((t) => t.key);
    expect(without).toEqual(['fema_validator']);
  });

  it('REC-01: county EM alone approves the facility registry; the COAD and partners propose', () => {
    const holders = (a: string) =>
      roleTemplates.filter((t) => t.grants.some((g) => g.action === a)).map((t) => t.key);
    expect(holders('facility.approve')).toEqual(['county_em_director']);
    expect(holders('facility.manage')).toEqual(
      expect.arrayContaining(['coad_chair', 'ngo_incident_commander', 'mass_care_coordinator']),
    );
  });

  it('CMD-04: only the tenant administrator sets organization command aliases', () => {
    const holders = roleTemplates
      .filter((t) => t.grants.some((g) => g.action === 'command_alias.manage'))
      .map((t) => t.key);
    expect(holders).toEqual(['tenant_admin']);
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

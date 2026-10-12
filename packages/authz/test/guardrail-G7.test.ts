import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine.ts';
import { validateGrants } from '../src/grants.ts';
import { account, personnelFields, role, TENANT_A } from './helpers.ts';

const fieldsNoCji = personnelFields.filter((f) => f.category !== 'cji');
const record = { type: 'personnel', tenantId: TENANT_A, fields: fieldsNoCji };

describe('G7 restricted health, counseling, legal fields stay with their roles (FL:FR-15/16/23, RULE-16)', () => {
  it('a tenant admin with every grant still cannot see health, counseling or legal fields', () => {
    const admin = account([
      role([{ action: '*', dataCategories: ['contact', 'household', 'free_text'] }]),
    ]);
    const d = decide(admin, 'personnel.read', record);
    expect(d.effect).toBe('allow');
    expect(d.fields.sort()).toEqual(['name', 'phone']);
    expect(d.maskedFields.sort()).toEqual(['counseling_notes', 'legal_notes', 'medications']);
  });

  it('a county cannot save a grant that names a protected category', () => {
    const v = validateGrants([{ action: 'personnel.read', dataCategories: ['health'] }]);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain('protected categories');
  });

  it('the engine ignores protected categories even if they reach it', () => {
    const sneaky = account([
      role([{ action: 'personnel.read', dataCategories: ['health', 'legal'] }]),
    ]);
    const d = decide(sneaky, 'personnel.read', record);
    expect(d.fields).toEqual(['name']);
  });

  it('only the shipped template for the category unlocks it', () => {
    const nurse = account([
      role([{ action: 'personnel.read', dataCategories: ['contact'] }], {
        templateKey: 'shelter_nurse',
      }),
    ]);
    const d = decide(nurse, 'personnel.read', record);
    expect(d.fields.sort()).toEqual(['medications', 'name', 'phone']);
    expect(d.restrictedRead.sort()).toEqual(['contact', 'health']);

    const counselor = account([
      role([{ action: 'personnel.read' }], { templateKey: 'crisis_counselor' }),
    ]);
    expect(decide(counselor, 'personnel.read', record).fields.sort()).toEqual([
      'counseling_notes',
      'name',
    ]);
  });

  it('writes to a protected category by an unqualified role are refused outright', () => {
    const admin = account([role([{ action: '*' }])]);
    const d = decide(admin, 'personnel.update', {
      type: 'personnel',
      tenantId: TENANT_A,
      fields: [{ name: 'medications', category: 'health', classification: 'restricted' }],
    });
    expect(d.reason).toBe('guardrail:G7:protected_category:health');
  });

  it('break-glass does not unlock protected categories either (SEC-08)', () => {
    const bg = account([], {
      breakGlass: { id: 'bg1', expiresAt: new Date(Date.now() + 3600_000) },
    });
    const d = decide(bg, 'personnel.read', record);
    expect(d.reason).toBe('break_glass');
    expect(d.fields.sort()).toEqual(['name', 'phone']);
    expect(d.auditReason).toBe('break_glass:bg1');
  });
});

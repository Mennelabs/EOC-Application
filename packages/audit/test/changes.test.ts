import { describe, expect, it } from 'vitest';
import { diffForAudit, hashValue, type Classifier } from '../src/changes.ts';

const classify: Classifier = (f) =>
  f === 'phone' ? 'restricted' : f === 'email' ? 'sensitive' : f === 'notes' ? 'cji' : 'internal';

describe('diffForAudit (BRD:FR-00.03, SEC-11)', () => {
  it('records only fields that changed, sorted, skipping bookkeeping columns', () => {
    const changes = diffForAudit(
      { name: 'A', status: 'draft', version: 1, updated_at: 1 },
      { name: 'A', status: 'active', version: 2, updated_at: 2 },
      classify,
    );
    expect(changes).toEqual({ fields: [{ name: 'status', from: 'draft', to: 'active' }] });
  });

  it('never stores sensitive, restricted or cji values; hashes stand in for them', () => {
    const changes = diffForAudit(
      { phone: '+13145550142', email: 'a@example.org', notes: 'x' },
      { phone: '+13145550199', email: 'a@example.org', notes: 'y' },
      classify,
    );
    const json = JSON.stringify(changes);
    expect(json).not.toContain('5550142');
    expect(json).not.toContain('5550199');
    expect(changes.fields.map((f) => f.name)).toEqual(['notes', 'phone']);
    expect(changes.fields[1]).toEqual({
      name: 'phone',
      redacted: true,
      from: hashValue('+13145550142'),
      to: hashValue('+13145550199'),
    });
  });

  it('handles creation and deletion (one side null)', () => {
    expect(diffForAudit(null, { status: 'new' }, classify)).toEqual({
      fields: [{ name: 'status', to: 'new' }],
    });
    expect(diffForAudit({ status: 'old' }, null, classify)).toEqual({
      fields: [{ name: 'status', from: 'old' }],
    });
  });

  it('compares dates by instant, not identity', () => {
    const t = new Date('2026-10-12T00:00:00Z');
    expect(diffForAudit({ at: t }, { at: new Date(t.getTime()) }, classify).fields).toEqual([]);
  });
});

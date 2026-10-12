import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine.ts';
import { account, ALICE, BOB, role, TENANT_A } from './helpers.ts';

describe('G6 granting permissions needs a second administrator (ADM-05, Section 30.2)', () => {
  const admin = account([role([{ action: '*' }])]);

  it('cannot approve one’s own permission change request', () => {
    const d = decide(admin, 'permission_change.approve', {
      type: 'permission_change_request',
      tenantId: TENANT_A,
      requestedBy: ALICE,
    });
    expect(d.reason).toBe('guardrail:G6:second_administrator_required');
  });

  it('can approve another administrator’s request', () => {
    const d = decide(admin, 'permission_change.approve', {
      type: 'permission_change_request',
      tenantId: TENANT_A,
      requestedBy: BOB,
    });
    expect(d.effect).toBe('allow');
    expect(d.consequential).toBe(true);
  });

  it('an assignment without an approved change request is refused', () => {
    const d = decide(admin, 'role_assignment.create', {
      type: 'role_assignment',
      tenantId: TENANT_A,
    });
    expect(d.reason).toBe('guardrail:G6:assignment_requires_approved_change_request');
    const pending = decide(admin, 'role_assignment.create', {
      type: 'role_assignment',
      tenantId: TENANT_A,
      changeRequestId: 'cr1',
      changeRequestApproved: false,
      requestedBy: BOB,
    });
    expect(pending.effect).toBe('deny');
  });

  it('the requester may not apply their own approved request', () => {
    const d = decide(admin, 'role_assignment.create', {
      type: 'role_assignment',
      tenantId: TENANT_A,
      changeRequestId: 'cr1',
      changeRequestApproved: true,
      requestedBy: ALICE,
    });
    expect(d.reason).toBe('guardrail:G6:second_administrator_required');
  });

  it('permission changes are frozen during break-glass (plan §8.2)', () => {
    const bg = account([role([{ action: '*' }])], {
      breakGlass: { id: 'bg1', expiresAt: new Date(Date.now() + 3600_000) },
    });
    for (const action of ['role.edit', 'permission_change.request', 'role_assignment.revoke']) {
      expect(decide(bg, action, { type: 'role', tenantId: TENANT_A }).reason).toBe(
        'guardrail:G6:permissions_frozen_during_break_glass',
      );
    }
    expect(decide(bg, 'role.read', { type: 'role', tenantId: TENANT_A }).effect).toBe('allow');
  });
});

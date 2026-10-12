import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine.ts';
import { account, eventInA, role, TENANT_A, TENANT_B } from './helpers.ts';

describe('grant evaluation (ADM-04, SEC-06)', () => {
  it('exact, family and wildcard action patterns', () => {
    expect(decide(account([role([{ action: 'event.read' }])]), 'event.read', eventInA).effect).toBe(
      'allow',
    );
    expect(decide(account([role([{ action: 'event.*' }])]), 'event.close', eventInA).effect).toBe(
      'allow',
    );
    expect(
      decide(account([role([{ action: 'event.*' }])]), 'personnel.read', eventInA).effect,
    ).toBe('deny');
    expect(decide(account([role([{ action: '*' }])]), 'definition.write', eventInA).effect).toBe(
      'allow',
    );
  });

  it('tenant scope: own by default; other tenants denied', () => {
    const d = decide(account([role([{ action: 'event.read' }])]), 'event.read', {
      type: 'event',
      tenantId: TENANT_B,
      tenantPath: 'state.b',
    });
    expect(d).toMatchObject({ effect: 'deny', reason: 'no_grant' });
  });

  it('tenant scope: subtree allows descendants only', () => {
    const state = account([role([{ action: 'event.read', tenants: 'subtree' }])], {
      tenantId: 'state',
      tenantPath: 'state',
    });
    expect(
      decide(state, 'event.read', { type: 'event', tenantId: TENANT_A, tenantPath: 'state.a' })
        .effect,
    ).toBe('allow');
    expect(
      decide(state, 'event.read', { type: 'event', tenantId: 'other', tenantPath: 'otherstate.x' })
        .effect,
    ).toBe('deny');
  });

  it('tenant scope: a signed agreement makes another tenant readable, never writable (SCL-01)', () => {
    const partner = account([role([{ action: 'event.read' }, { action: 'event.update' }])], {
      agreementTenantIds: [TENANT_B],
    });
    const inB = { type: 'event', tenantId: TENANT_B, tenantPath: 'state.b' };
    expect(decide(partner, 'event.read', inB).effect).toBe('allow');
    expect(decide(partner, 'event.update', inB).effect).toBe('deny');
  });

  it('event scope: assigned limits to the assignment’s events', () => {
    const assessor = account([
      role([{ action: 'event.read', events: 'assigned' }], { scope: { eventIds: ['e1'] } }),
    ]);
    expect(decide(assessor, 'event.read', { ...eventInA, eventId: 'e1' }).effect).toBe('allow');
    expect(decide(assessor, 'event.read', { ...eventInA, eventId: 'e2' }).effect).toBe('deny');
  });

  it('reports which role version allowed the action, for the audit record (RULE-07)', () => {
    const d = decide(
      account([role([{ action: 'event.read' }], { key: 'pio', version: 3 })]),
      'event.read',
      eventInA,
    );
    expect(d.reason).toBe('grant:pio@3');
  });

  it('marks consequential actions (RULE-14)', () => {
    expect(decide(account([role([{ action: '*' }])]), 'event.close', eventInA).consequential).toBe(
      true,
    );
    expect(decide(account([role([{ action: '*' }])]), 'event.read', eventInA).consequential).toBe(
      false,
    );
  });

  it('break-glass: read-only, own tenant, expired sessions ignored (SEC-08)', () => {
    const live = account([], {
      breakGlass: { id: 'bg', expiresAt: new Date(Date.now() + 60_000) },
    });
    expect(decide(live, 'event.read', eventInA).reason).toBe('break_glass');
    expect(decide(live, 'event.update', eventInA).effect).toBe('deny');
    expect(decide(live, 'event.read', { type: 'event', tenantId: TENANT_B }).effect).toBe('deny');
    const expired = account([], { breakGlass: { id: 'bg', expiresAt: new Date(Date.now() - 1) } });
    expect(decide(expired, 'event.read', eventInA).effect).toBe('deny');
  });

  it('system subjects pass (worker jobs run under their own database role)', () => {
    expect(
      decide({ kind: 'system', tenantId: TENANT_A, job: 'retention' }, 'event.read', eventInA)
        .effect,
    ).toBe('allow');
  });
});

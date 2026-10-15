/** The navigation lists only the workspaces the person's actions answer for (CON-01, ADM-04). */
import { describe, expect, it } from 'vitest';
import { GROUPS, allWorkspaces, canUse, visibleGroups } from '../src/ui/nav.ts';

describe('console navigation', () => {
  it('keeps every label the journeys click, once', () => {
    const labels = allWorkspaces().map((w) => w.label);
    for (const l of [
      'Home',
      'Review queue',
      'Needs board',
      'Sites',
      'Publication log',
      'Partner workspace',
      'Our services',
      'Contacts',
      'Events',
      'Permission changes',
      'Facility registry',
      'Facility approvals',
      'Recommendations',
      'Resource discovery',
    ]) {
      expect(labels.filter((x) => x === l)).toHaveLength(1);
    }
    const paths = allWorkspaces().map((w) => w.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('no label is a prefix of another, so a journey never matches two links', () => {
    const labels = allWorkspaces().map((w) => w.label);
    for (const a of labels)
      for (const b of labels) if (a !== b) expect(b.startsWith(a)).toBe(false);
  });

  it('shows a workspace when the person holds any of its actions', () => {
    const planner = {
      actions: ['dashboard.read', 'report.read', 'event.read', 'refdata.read'],
      tenantKind: 'county',
    };
    const groups = visibleGroups(planner);
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain('Home');
    expect(labels).toContain('Review queue');
    expect(labels).toContain('Events');
    expect(labels).toContain('Reference data');
    expect(labels).not.toContain('Permission changes');
    expect(labels).not.toContain('Audit log');
    expect(labels).not.toContain('Partner workspace');
    expect(groups.map((g) => g.title)).not.toContain('Field operations');
  });

  it('shows everything when the API gave no action list (an older server)', () => {
    const labels = visibleGroups({}).flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toHaveLength(allWorkspaces().length);
  });

  it('limits partner-only workspaces to partner organizations', () => {
    const partner = allWorkspaces().find((w) => w.label === 'Partner workspace');
    expect(partner).toBeDefined();
    expect(canUse(partner!, { actions: ['need.read'], tenantKind: 'partner_org' })).toBe(true);
    expect(canUse(partner!, { actions: ['need.read'], tenantKind: 'county' })).toBe(false);
  });

  it('attaches counts beside the links without changing labels', () => {
    const groups = visibleGroups(
      { actions: ['report.read'] },
      { '/console/reports': { count: 874, label: 'in the queue' } },
    );
    const item = groups.flatMap((g) => g.items).find((i) => i.path === '/console/reports');
    expect(item).toMatchObject({ label: 'Review queue', count: 874, countLabel: 'in the queue' });
    expect(GROUPS.length).toBeGreaterThan(5);
  });
});

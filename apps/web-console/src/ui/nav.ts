/**
 * The console's workspaces (CON-01): grouped the way the EOC thinks about the
 * work, each gated by the actions the API answers for the person (`/me`
 * returns them, ADM-04). A workspace the person cannot use is not listed; a
 * direct address still shows the denial, never a blank page. Labels are the
 * ones the journeys click; counts stay out of the link names.
 */
import { icons, type LucideIcon, type NavGroup, type NavItem } from '@cg/ui';

export interface Workspace {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Any one of these actions lists the workspace; none means everyone. */
  needs?: readonly string[];
  /** Only for these tenant kinds (for example partner organizations). */
  tenantKinds?: readonly string[];
}
export interface WorkspaceGroup {
  title: string;
  workspaces: readonly Workspace[];
}
export interface NavCount {
  count: number;
  label: string;
  tone?: 'warn' | 'danger';
}

export const GROUPS: readonly WorkspaceGroup[] = [
  {
    title: 'Situation',
    workspaces: [
      { path: '/console/', label: 'Home', icon: icons.Home },
      {
        path: '/console/situation',
        label: 'Situation map',
        icon: icons.Map,
        needs: [
          'dashboard.read',
          'report.read',
          'need.read',
          'site.read',
          'team.read',
          'dispatch.read',
        ],
      },
      {
        path: '/console/recommendations',
        label: 'Recommendations',
        icon: icons.Sparkles,
        needs: ['recommendation.request', 'recommendation.decide'],
      },
      {
        path: '/console/discovery',
        label: 'Resource discovery',
        icon: icons.Globe,
        needs: ['discovery.review', 'discovery.manage'],
      },
    ],
  },
  {
    title: 'Intake and review',
    workspaces: [
      {
        path: '/console/reports',
        label: 'Review queue',
        icon: icons.Inbox,
        needs: ['report.read'],
      },
      {
        path: '/console/assist',
        label: 'Assisted report',
        icon: icons.UserCheck,
        needs: ['report.create_assisted'],
      },
      {
        path: '/console/intake',
        label: 'Intake setup',
        icon: icons.ClipboardList,
        needs: ['intake_graph.read'],
      },
      {
        path: '/console/ai-register',
        label: 'AI use register',
        icon: icons.Bot,
        needs: ['ai_register.read'],
      },
    ],
  },
  {
    title: 'Needs and partners',
    workspaces: [
      {
        path: '/console/needs',
        label: 'Needs board',
        icon: icons.HeartHandshake,
        needs: ['need.read'],
      },
      {
        path: '/console/partner',
        label: 'Partner workspace',
        icon: icons.Handshake,
        needs: ['need.read', 'shared.read'],
        tenantKinds: ['partner_org'],
      },
      {
        path: '/console/our-services',
        label: 'Our services',
        icon: icons.Megaphone,
        needs: ['site.post'],
      },
      {
        path: '/console/partners',
        label: 'Partner agreements',
        icon: icons.ScrollText,
        needs: ['dsa.read'],
      },
      {
        path: '/console/contacts',
        label: 'Contacts',
        icon: icons.Contact,
        needs: ['contact.read'],
      },
    ],
  },
  {
    title: 'Mass care and sites',
    workspaces: [
      { path: '/console/sites', label: 'Sites', icon: icons.Tent, needs: ['site.read'] },
      {
        path: '/console/shelters',
        label: 'Shelters',
        icon: icons.Building2,
        needs: ['shelter_stay.read', 'site.edit'],
      },
      {
        path: '/console/reception',
        label: 'Volunteer reception',
        icon: icons.BadgeCheck,
        needs: ['volunteer_registration.read'],
      },
      {
        path: '/console/facilities',
        label: 'Facility registry',
        icon: icons.Warehouse,
        needs: ['facility.read'],
      },
      {
        path: '/console/facility-approvals',
        label: 'Facility approvals',
        icon: icons.ListChecks,
        needs: ['facility.approve'],
      },
    ],
  },
  {
    title: 'Public information',
    workspaces: [
      {
        path: '/console/resources',
        label: 'Resources',
        icon: icons.BookOpen,
        needs: ['resource.read'],
      },
      {
        path: '/console/publications',
        label: 'Publication log',
        icon: icons.Newspaper,
        needs: ['publication.read'],
      },
    ],
  },
  {
    title: 'Field operations',
    workspaces: [
      {
        path: '/console/dispatch',
        label: 'Dispatch board',
        icon: icons.Radio,
        needs: ['dispatch.read'],
      },
      { path: '/console/missions', label: 'Missions', icon: icons.Truck, needs: ['mission.read'] },
      {
        path: '/console/replay',
        label: 'Board replay',
        icon: icons.History,
        needs: ['dispatch.read'],
      },
      {
        path: '/console/roster',
        label: 'Roster and check-in',
        icon: icons.Users,
        needs: ['team.read'],
      },
      {
        path: '/console/net-control',
        label: 'Net control log',
        icon: icons.Activity,
        needs: ['comms_log.read'],
      },
      {
        path: '/console/field-messages',
        label: 'Messages to the field',
        icon: icons.Mail,
        needs: ['field_message.read', 'field_message.send'],
      },
      { path: '/console/badges', label: 'Badges', icon: icons.QrCode, needs: ['badge.read'] },
      {
        path: '/console/reminders',
        label: 'Reminders',
        icon: icons.Timer,
        needs: ['reminder.read'],
      },
      {
        path: '/console/devices',
        label: 'Field devices',
        icon: icons.Smartphone,
        needs: ['device.read'],
      },
    ],
  },
  {
    title: 'Declaration and reports',
    workspaces: [
      {
        path: '/console/declaration',
        label: 'Declaration data',
        icon: icons.Landmark,
        needs: ['declaration.read'],
      },
      {
        path: '/console/joint-assessment',
        label: 'Joint assessment',
        icon: icons.Route,
        needs: ['joint_assessment.read'],
      },
      {
        path: '/console/shared-declarations',
        label: 'Shared declaration figures',
        icon: icons.FileSpreadsheet,
        needs: ['shared_declaration.read'],
      },
      {
        path: '/console/official-reports',
        label: 'Official reports',
        icon: icons.FileText,
        needs: ['official_report.read'],
      },
      { path: '/console/metrics', label: 'Metrics', icon: icons.BarChart3, needs: ['metric.read'] },
      { path: '/console/equity', label: 'Equity', icon: icons.Scale, needs: ['equity.read'] },
      {
        path: '/console/reference-data',
        label: 'Reference data',
        icon: icons.Database,
        needs: ['refdata.read'],
      },
      {
        path: '/console/fema-mappings',
        label: 'FEMA form mappings',
        icon: icons.Workflow,
        needs: ['fema_mapping.read'],
      },
    ],
  },
  {
    title: 'Administration',
    workspaces: [
      {
        path: '/console/events',
        label: 'Events',
        icon: icons.CalendarClock,
        needs: ['event.read'],
      },
      {
        path: '/console/tenants',
        label: 'Organizations',
        icon: icons.Building2,
        needs: ['partner.invite', 'tenant.create_child', 'tenant.update'],
      },
      {
        path: '/console/accounts',
        label: 'Staff accounts',
        icon: icons.Users,
        needs: ['account.read'],
      },
      {
        path: '/console/personnel',
        label: 'Personnel',
        icon: icons.Contact,
        needs: ['personnel.read'],
      },
      { path: '/console/roles', label: 'Roles', icon: icons.Shield, needs: ['role.read'] },
      {
        path: '/console/approvals',
        label: 'Permission changes',
        icon: icons.ShieldCheck,
        needs: ['permission_change.read'],
      },
      { path: '/console/audit', label: 'Audit log', icon: icons.ScrollText, needs: ['audit.read'] },
      {
        path: '/console/break-glass',
        label: 'Emergency access',
        icon: icons.Siren,
        needs: ['break_glass.read', 'break_glass.start'],
      },
      {
        path: '/console/retention',
        label: 'Retention',
        icon: icons.Archive,
        needs: ['retention.read'],
      },
      {
        path: '/console/integrations',
        label: 'API keys and webhooks',
        icon: icons.KeyRound,
        needs: ['api_key.read', 'webhook.read'],
      },
    ],
  },
];

export interface Person {
  actions?: readonly string[] | undefined;
  tenantKind?: string | undefined;
}

/** True when the person may use the workspace. Without an action list (an older API) everything shows. */
export function canUse(w: Workspace, me: Person | null): boolean {
  if (w.tenantKinds && me?.tenantKind && !w.tenantKinds.includes(me.tenantKind)) return false;
  if (!w.needs || !me?.actions) return true;
  const have = new Set(me.actions);
  return w.needs.some((a) => have.has(a));
}

/** The groups the navigation shows, with counts attached; empty groups are dropped. */
export function visibleGroups(
  me: Person | null,
  counts: Readonly<Record<string, NavCount | undefined>> = {},
): NavGroup[] {
  const out: NavGroup[] = [];
  for (const g of GROUPS) {
    const items: NavItem[] = [];
    for (const w of g.workspaces) {
      if (!canUse(w, me)) continue;
      const c = counts[w.path];
      items.push({
        path: w.path,
        label: w.label,
        icon: w.icon,
        ...(c
          ? { count: c.count, countLabel: c.label, ...(c.tone ? { countTone: c.tone } : {}) }
          : {}),
      });
    }
    if (items.length) out.push({ title: g.title, items });
  }
  return out;
}

/** Every workspace, flat (for the work home and for tests). */
export function allWorkspaces(): Workspace[] {
  return GROUPS.flatMap((g) => [...g.workspaces]);
}

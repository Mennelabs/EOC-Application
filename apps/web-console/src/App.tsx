import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EventChip,
  PersonMenu,
  Shell,
  SideNav,
  TopBar,
  applyPreferences,
  humanize,
  readPreferences,
  writePreferences,
  type Preferences,
} from '@cg/ui';
import { api, describeFailure, setConfirmHandler, type Confirmation } from './api/client.ts';
import {
  beginLogin,
  completeLogin,
  loadSession,
  rememberedRealm,
  sessionClaims,
  signOut,
} from './auth/oidc.ts';
import type { RuntimeConfig } from './runtime-config.ts';
import { AccountsScreen, EventsScreen, PersonnelScreen, TenantsScreen } from './screens/admin.tsx';
import {
  BrandingScreen,
  EventTemplatesScreen,
  PlanningFactorsScreen,
} from './screens/settings.tsx';
import {
  ApprovalsScreen,
  AuditScreen,
  BreakGlassScreen,
  RetentionScreen,
  RolesScreen,
} from './screens/permissions.tsx';
import { AiRegisterScreen, AssistedScreen, IntakeSetupScreen } from './screens/intake.tsx';
import { ContactsScreen } from './screens/contacts.tsx';
import { PeerSupportScreen } from './screens/peer-support.tsx';
import { DispatchScreen, ReplayScreen } from './screens/dispatch.tsx';
import { SheltersScreen, VolunteerReceptionScreen } from './screens/masscare.tsx';
import { SituationScreen } from './screens/situation.tsx';
import {
  BadgesScreen,
  DevicesScreen,
  FieldMessagesScreen,
  NetControlScreen,
  RemindersScreen,
  RosterScreen,
} from './screens/fieldops.tsx';
import { MissionDetailScreen, MissionsScreen } from './screens/missions.tsx';
import { NeedsBoardScreen, PartnerScreen } from './screens/needs.tsx';
import { HomeScreen, type HomeEvent } from './screens/home.tsx';
import { PartnersScreen } from './screens/partners.tsx';
import { OurServicesScreen } from './screens/our-services.tsx';
import { ResourcesScreen } from './screens/resources.tsx';
import { DeclarationScreen } from './screens/declaration.tsx';
import { EquityScreen } from './screens/equity.tsx';
import { FacilitiesScreen, FacilityApprovalsScreen } from './screens/facilities.tsx';
import { RecommendationsScreen } from './screens/recommendations.tsx';
import { DiscoveryScreen } from './screens/discovery.tsx';
import { FemaMappingsScreen } from './screens/fema-mappings.tsx';
import { IntegrationsScreen } from './screens/integrations.tsx';
import { SsoScreen } from './screens/sso.tsx';
import { SubscriptionScreen } from './screens/subscription.tsx';
import { JobAidsScreen } from './screens/job-aids.tsx';
import { ResourceRequestsScreen } from './screens/resource-requests.tsx';
import { IcsFormsScreen } from './screens/ics-forms.tsx';
import { MetricsScreen } from './screens/metrics.tsx';
import { JointAssessmentScreen } from './screens/joint-assessment.tsx';
import { SharedDeclarationsScreen } from './screens/shared-declarations.tsx';
import { OfficialReportScreen, OfficialReportsScreen } from './screens/official-reports.tsx';
import { RefdataScreen } from './screens/refdata.tsx';
import { ReportDetailScreen, ReviewQueueScreen } from './screens/review.tsx';
import { PublicationsScreen, SitesScreen } from './screens/sites.tsx';
import { PublicRecordsScreen } from './screens/public-records.tsx';
import { FindSurvivorScreen } from './screens/find-survivor.tsx';
import { HealthNoticesScreen } from './screens/health-notices.tsx';
import { ParcelsScreen } from './screens/parcels.tsx';
import { ReentryScreen } from './screens/reentry.tsx';
import { CommandWindow } from './ui/command-window.tsx';
import { ConfirmDialog, Field, Status } from './ui/primitives.tsx';
import { visibleGroups, type NavCount } from './ui/nav.ts';
import { formatTime, setDisplayZone } from './ui/time.ts';

/**
 * Console shell (CON-01): one console, role-based workspaces. The navigation
 * lists the workspaces the person's actions answer for (`ui/nav.ts`); a direct
 * address to any other shows the denial, never a blank page. The frame comes
 * from @cg/ui (ADR-0045): the top bar with the event, the command bar and the
 * person's display choices; the workspaces down the side with live counts.
 */

interface Me {
  accountId: string;
  tenantId: string;
  tenantKind?: string;
  timeZone?: string;
  roles: { key: string; version: number; templateKey?: string | null }[];
  breakGlass: { id: string; expiresAt: string } | null;
  /** Actions the account may take (ADM-04); the navigation and the home read them. */
  actions?: string[];
}

interface DashboardCounts {
  reports: { byState: Record<string, number> };
  needs: { byStatus: Record<string, number> };
}

function usePath() {
  const [path, setPath] = useState(location.pathname.replace(/\/$/, '') || '/console');
  useEffect(() => {
    const onPop = () => setPath(location.pathname.replace(/\/$/, '') || '/console');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    history.pushState(null, '', to);
    setPath(to.replace(/\/$/, '') || '/console');
    // A move lands at the top of the new screen with focus on its main region,
    // so a screen reader hears the heading next and a phone shows the screen
    // from its start rather than wherever the drawer's link was (ACC-07).
    window.scrollTo(0, 0);
    document.getElementById('main')?.focus({ preventScroll: true });
  }, []);
  return { path, navigate };
}

function SignIn({ config }: { config: RuntimeConfig }) {
  const [realm, setRealm] = useState(rememberedRealm() ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <main id="main" tabIndex={-1} className="cg-signin">
      <h1>Sign in to {config.productName || 'the console'}</h1>
      <p>
        Enter your organization’s sign-in name. You will sign in with your password and your
        passkey.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          beginLogin(realm.trim().toLowerCase()).catch((err: unknown) =>
            setError(describeFailure(err)),
          );
        }}
      >
        <Field label="Organization" hint="For example: county" {...(error ? { error } : {})}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={realm}
              onChange={(e) => setRealm(e.target.value)}
              autoComplete="organization"
              required
            />
          )}
        </Field>
        <button type="submit" className="primary">
          Continue
        </button>
      </form>
    </main>
  );
}

export function App({ config }: { config: RuntimeConfig }) {
  const { path, navigate } = usePath();
  const [session, setSession] = useState(() => loadSession());
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    action: string;
    description: string;
    draft?: string | undefined;
    resolve: (c: Confirmation) => void;
  } | null>(null);
  const product = config.productName || 'Console';

  useEffect(() => {
    document.title = `${product} — ${config.countyName || 'Console'}`;
  }, [product, config.countyName]);

  useEffect(() => {
    setConfirmHandler(
      (action, description, draft) =>
        new Promise((resolve) => setConfirm({ action, description, draft, resolve })),
    );
  }, []);

  useEffect(() => {
    if (path === '/console/callback') {
      completeLogin()
        .then((to) => {
          setSession(loadSession());
          navigate(to);
        })
        .catch((err: unknown) => {
          setMeError(describeFailure(err));
          navigate('/console/');
        });
    }
  }, [path, navigate]);

  const loadMe = useCallback(() => {
    if (!session) return;
    api<Me>('/me')
      .then((m) => {
        // BRD:FR-00.08: every time from here on is shown and typed on the tenant's clock.
        setDisplayZone(m.timeZone);
        setMe(m);
        setMeError(null);
      })
      .catch((err: unknown) => {
        setMeError(describeFailure(err));
        if ((err as { status?: number }).status === 401) {
          setSession(null);
          setMe(null);
        }
      });
  }, [session]);
  useEffect(loadMe, [loadMe]);

  // The device's theme and density (ADR-0045); briefing mode is a route (CON-11).
  const [prefs, setPrefs] = useState<Preferences>(() => readPreferences());
  const updatePrefs = useCallback((next: Preferences) => {
    setPrefs(next);
    writePreferences(next);
    applyPreferences(next);
  }, []);

  // The open events, for the chip in the top bar and the home.
  const [events, setEvents] = useState<HomeEvent[] | null>(null);
  useEffect(() => {
    if (!me) return;
    let live = true;
    api<HomeEvent[]>('/events?limit=50')
      .then((rows) => live && setEvents(rows.filter((e) => e.status !== 'closed')))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [me]);

  // Live counts beside the workspaces, refreshed every minute and on every move.
  const [navCounts, setNavCounts] = useState<Record<string, NavCount>>({});
  useEffect(() => {
    if (!me) return;
    let live = true;
    const has = (a: string) => !me.actions || me.actions.includes(a);
    const run = async () => {
      const next: Record<string, NavCount> = {};
      const jobs: Promise<void>[] = [];
      if (has('dashboard.read'))
        jobs.push(
          api<DashboardCounts>('/dashboard/counts')
            .then((c) => {
              const fresh = c.reports.byState['submitted'] ?? 0;
              if (fresh) next['/console/reports'] = { count: fresh, label: 'new reports' };
              const open = c.needs.byStatus['open'] ?? 0;
              if (open) next['/console/needs'] = { count: open, label: 'open needs' };
            })
            .catch(() => undefined),
        );
      if (has('facility.approve'))
        jobs.push(
          api<unknown[]>('/facility-changes?state=pending&limit=100')
            .then((rows) => {
              if (rows.length)
                next['/console/facility-approvals'] = {
                  count: rows.length,
                  label: 'proposals waiting',
                  tone: 'warn',
                };
            })
            .catch(() => undefined),
        );
      if (has('permission_change.approve'))
        jobs.push(
          api<unknown[]>('/permission-changes?status=pending&limit=100')
            .then((rows) => {
              if (rows.length)
                next['/console/approvals'] = {
                  count: rows.length,
                  label: 'changes waiting',
                  tone: 'warn',
                };
            })
            .catch(() => undefined),
        );
      if (has('recommendation.decide'))
        jobs.push(
          api<{ state: string }[]>('/recommendations?limit=50')
            .then((rows) => {
              const open = rows.filter((r) => r.state === 'open').length;
              if (open)
                next['/console/recommendations'] = { count: open, label: 'awaiting a decision' };
            })
            .catch(() => undefined),
        );
      if (has('reminder.read'))
        jobs.push(
          api<{ state: string }[]>('/reminders?open=true&mine=true&limit=100')
            .then((rows) => {
              const overdue = rows.filter((r) => r.state === 'overdue').length;
              if (overdue)
                next['/console/reminders'] = { count: overdue, label: 'overdue', tone: 'danger' };
            })
            .catch(() => undefined),
        );
      await Promise.all(jobs);
      if (live) setNavCounts(next);
    };
    void run();
    const timer = setInterval(() => void run(), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [me, path]);

  const groups = useMemo(() => visibleGroups(me, navCounts), [me, navCounts]);
  const activeEvent = events?.find((e) => e.status === 'active') ?? events?.[0] ?? null;
  const claims = useMemo(() => (session ? sessionClaims(session) : null), [session]);
  const personName =
    claims?.name || claims?.preferredUsername || claims?.email || (me ? 'Signed in' : '');
  const personRole = me?.roles.map((r) => humanize(r.templateKey ?? r.key)).join(', ') ?? '';

  const county = config.countyName ? `${config.countyName} Emergency Management` : undefined;

  if (!session) {
    return (
      <>
        <TopBar product={product} homeHref="/console/" {...(county ? { county } : {})} />
        {meError ? <Status kind="error">{meError}</Status> : null}
        <SignIn config={config} />
      </>
    );
  }

  const screen = (() => {
    if (path.startsWith('/console/missions/'))
      return <MissionDetailScreen id={path.slice('/console/missions/'.length)} />;
    if (path.startsWith('/console/official-reports/'))
      return (
        <OfficialReportScreen
          id={path.slice('/console/official-reports/'.length)}
          navigate={navigate}
        />
      );
    if (path.startsWith('/console/reports/'))
      return <ReportDetailScreen id={path.slice('/console/reports/'.length)} navigate={navigate} />;
    switch (path) {
      case '/console/dispatch':
        return <DispatchScreen />;
      case '/console/missions':
        return <MissionsScreen navigate={navigate} />;
      case '/console/replay':
        return <ReplayScreen />;
      case '/console/situation':
        return <SituationScreen />;
      case '/console/shelters':
        return <SheltersScreen me={me} />;
      case '/console/reception':
        return <VolunteerReceptionScreen />;
      case '/console/health-notices':
        return <HealthNoticesScreen />;
      case '/console/reentry':
        return <ReentryScreen />;
      case '/console/parcels':
        return <ParcelsScreen />;
      case '/console/roster':
        return <RosterScreen />;
      case '/console/net-control':
        return <NetControlScreen />;
      case '/console/field-messages':
        return <FieldMessagesScreen />;
      case '/console/badges':
        return <BadgesScreen />;
      case '/console/reminders':
        return <RemindersScreen />;
      case '/console/peer-support':
        return <PeerSupportScreen />;
      case '/console/devices':
        return <DevicesScreen />;
      case '/console/reference-data':
        return <RefdataScreen />;
      case '/console/fema-mappings':
        return <FemaMappingsScreen />;
      case '/console/integrations':
        return <IntegrationsScreen />;
      case '/console/sso':
        return <SsoScreen />;
      case '/console/subscription':
        return <SubscriptionScreen />;
      case '/console/job-aids':
        return <JobAidsScreen />;
      case '/console/resource-requests':
        return <ResourceRequestsScreen />;
      case '/console/ics-forms':
        return <IcsFormsScreen />;
      case '/console/facilities':
        return <FacilitiesScreen />;
      case '/console/facility-approvals':
        return <FacilityApprovalsScreen />;
      case '/console/recommendations':
        return <RecommendationsScreen />;
      case '/console/discovery':
        return <DiscoveryScreen />;
      case '/console/declaration':
        return <DeclarationScreen />;
      case '/console/metrics':
        return <MetricsScreen />;
      case '/console/equity':
        return <EquityScreen />;
      case '/console/joint-assessment':
        return <JointAssessmentScreen />;
      case '/console/shared-declarations':
        return <SharedDeclarationsScreen />;
      case '/console/official-reports':
        return <OfficialReportsScreen navigate={navigate} />;
      case '/console/reports':
        return <ReviewQueueScreen navigate={navigate} />;
      case '/console/assist':
        return <AssistedScreen />;
      case '/console/intake':
        return <IntakeSetupScreen />;
      case '/console/ai-register':
        return <AiRegisterScreen />;
      case '/console/needs':
        return <NeedsBoardScreen me={me} />;
      case '/console/partner':
        return <PartnerScreen me={me} />;
      case '/console/our-services':
        return <OurServicesScreen me={me} />;
      case '/console/sites':
        return <SitesScreen />;
      case '/console/resources':
        return <ResourcesScreen />;
      case '/console/publications':
        return <PublicationsScreen />;
      case '/console/contacts':
        return <ContactsScreen />;
      case '/console/partners':
        return <PartnersScreen me={me} />;
      case '/console/events':
        return <EventsScreen />;
      case '/console/event-templates':
        return <EventTemplatesScreen />;
      case '/console/planning-factors':
        return <PlanningFactorsScreen />;
      case '/console/branding':
        return <BrandingScreen />;
      case '/console/tenants':
        return <TenantsScreen />;
      case '/console/accounts':
        return <AccountsScreen />;
      case '/console/personnel':
        return <PersonnelScreen />;
      case '/console/roles':
        return <RolesScreen />;
      case '/console/approvals':
        return <ApprovalsScreen />;
      case '/console/audit':
        return <AuditScreen />;
      case '/console/break-glass':
        return <BreakGlassScreen onChanged={loadMe} />;
      case '/console/retention':
        return <RetentionScreen />;
      case '/console/briefing':
        return <HomeScreen me={me} events={events} navigate={navigate} briefing />;
      case '/console/public-records':
        return <PublicRecordsScreen />;
      case '/console/find-survivor':
        return <FindSurvivorScreen navigate={navigate} />;
      default:
        return <HomeScreen me={me} events={events} navigate={navigate} />;
    }
  })();

  return (
    <>
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <Shell
        topBar={
          <TopBar
            product={product}
            {...(county ? { county } : {})}
            homeHref="/console/"
            onNavigate={navigate}
            end={
              me ? (
                <PersonMenu
                  name={personName}
                  role={personRole}
                  theme={prefs.theme}
                  density={prefs.density}
                  briefing={path === '/console/briefing'}
                  onTheme={(theme) => updatePrefs({ ...prefs, theme })}
                  onDensity={(density) => updatePrefs({ ...prefs, density })}
                  {...(!me.actions || me.actions.includes('dashboard.read')
                    ? {
                        onBriefing: (on: boolean) =>
                          navigate(on ? '/console/briefing' : '/console/'),
                      }
                    : {})}
                  onSignOut={signOut}
                />
              ) : (
                <button type="button" className="link" onClick={signOut}>
                  Sign out
                </button>
              )
            }
          >
            {activeEvent ? (
              <EventChip
                name={activeEvent.name}
                hazard={activeEvent.hazardType ?? null}
                status={activeEvent.status}
                openedAt={activeEvent.openedAt ?? null}
              />
            ) : null}
            {me ? <CommandWindow navigate={navigate} /> : null}
          </TopBar>
        }
        banner={
          <>
            {me?.breakGlass ? (
              <p className="banner" role="status">
                Emergency access is active until {formatTime(new Date(me.breakGlass.expiresAt))}.
                Every record you open is audited as restricted.
              </p>
            ) : null}
            {meError ? <Status kind="error">{meError}</Status> : null}
          </>
        }
        nav={({ id, open, close }) => (
          <SideNav
            groups={groups}
            currentPath={path}
            id={id}
            open={open}
            onNavigate={(to) => {
              navigate(to);
              close();
            }}
          />
        )}
      >
        {screen}
      </Shell>
      <ConfirmDialog
        request={
          confirm
            ? { action: confirm.action, description: confirm.description, draft: confirm.draft }
            : null
        }
        onDone={(c) => {
          confirm?.resolve(c);
          setConfirm(null);
        }}
      />
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api, describeFailure, setConfirmHandler, type Confirmation } from './api/client.ts';
import { beginLogin, completeLogin, loadSession, rememberedRealm, signOut } from './auth/oidc.ts';
import type { RuntimeConfig } from './runtime-config.ts';
import { AccountsScreen, EventsScreen, PersonnelScreen, TenantsScreen } from './screens/admin.tsx';
import {
  ApprovalsScreen,
  AuditScreen,
  BreakGlassScreen,
  RetentionScreen,
  RolesScreen,
} from './screens/permissions.tsx';
import { AiRegisterScreen, AssistedScreen, IntakeSetupScreen } from './screens/intake.tsx';
import { ContactsScreen } from './screens/contacts.tsx';
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
import { KeyCounts, NeedsBoardScreen, PartnerScreen } from './screens/needs.tsx';
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
import { MetricsScreen } from './screens/metrics.tsx';
import { JointAssessmentScreen } from './screens/joint-assessment.tsx';
import { SharedDeclarationsScreen } from './screens/shared-declarations.tsx';
import { OfficialReportScreen, OfficialReportsScreen } from './screens/official-reports.tsx';
import { RefdataScreen } from './screens/refdata.tsx';
import { ReportDetailScreen, ReviewQueueScreen } from './screens/review.tsx';
import { PublicationsScreen, SitesScreen } from './screens/sites.tsx';
import { PublicRecordsScreen } from './screens/public-records.tsx';
import { FindSurvivorScreen } from './screens/find-survivor.tsx';
import { CommandWindow } from './ui/command-window.tsx';
import { ConfirmDialog, Field, Status } from './ui/primitives.tsx';
import { formatTime, setDisplayZone } from './ui/time.ts';

/**
 * Console shell (CON-01): one console, role-based workspaces. Layer 1 ships
 * the administration workspaces; the others arrive with their layers. The
 * navigation shows every workspace the API answers for; a denied workspace
 * shows the denial, never a blank page.
 */
const routes = [
  { path: '/console/', label: 'Home', layer: 1 },
  { path: '/console/reports', label: 'Review queue', layer: 2 },
  { path: '/console/find-survivor', label: "Find a survivor's record", layer: 3 },
  { path: '/console/assist', label: 'Assisted report', layer: 2 },
  { path: '/console/intake', label: 'Intake setup', layer: 2 },
  { path: '/console/needs', label: 'Needs board', layer: 3 },
  { path: '/console/partner', label: 'Partner workspace', layer: 3 },
  { path: '/console/our-services', label: 'Our services', layer: 3 },
  { path: '/console/sites', label: 'Sites', layer: 3 },
  { path: '/console/resources', label: 'Resources', layer: 3 },
  { path: '/console/publications', label: 'Publication log', layer: 3 },
  { path: '/console/contacts', label: 'Contacts', layer: 3 },
  { path: '/console/partners', label: 'Partner agreements', layer: 3 },
  { path: '/console/dispatch', label: 'Dispatch board', layer: 4 },
  { path: '/console/missions', label: 'Missions', layer: 4 },
  { path: '/console/replay', label: 'Board replay', layer: 4 },
  { path: '/console/situation', label: 'Situation map', layer: 4 },
  { path: '/console/shelters', label: 'Shelters', layer: 4 },
  { path: '/console/reception', label: 'Volunteer reception', layer: 4 },
  { path: '/console/roster', label: 'Roster and check-in', layer: 4 },
  { path: '/console/net-control', label: 'Net control log', layer: 4 },
  { path: '/console/field-messages', label: 'Messages to the field', layer: 4 },
  { path: '/console/badges', label: 'Badges', layer: 4 },
  { path: '/console/reminders', label: 'Reminders', layer: 4 },
  { path: '/console/devices', label: 'Field devices', layer: 4 },
  { path: '/console/declaration', label: 'Declaration data', layer: 6 },
  { path: '/console/joint-assessment', label: 'Joint assessment', layer: 6 },
  { path: '/console/shared-declarations', label: 'Shared declaration figures', layer: 6 },
  { path: '/console/official-reports', label: 'Official reports', layer: 6 },
  { path: '/console/metrics', label: 'Metrics', layer: 6 },
  { path: '/console/equity', label: 'Equity', layer: 6 },
  { path: '/console/reference-data', label: 'Reference data', layer: 6 },
  { path: '/console/fema-mappings', label: 'FEMA form mappings', layer: 6 },
  { path: '/console/integrations', label: 'API keys and webhooks', layer: 6 },
  { path: '/console/facilities', label: 'Facility registry', layer: 7 },
  { path: '/console/facility-approvals', label: 'Facility approvals', layer: 7 },
  { path: '/console/recommendations', label: 'Recommendations', layer: 7 },
  { path: '/console/discovery', label: 'Resource discovery', layer: 7 },
  { path: '/console/events', label: 'Events', layer: 1 },
  { path: '/console/tenants', label: 'Organizations', layer: 1 },
  { path: '/console/accounts', label: 'Staff accounts', layer: 1 },
  { path: '/console/personnel', label: 'Personnel', layer: 1 },
  { path: '/console/roles', label: 'Roles', layer: 1 },
  { path: '/console/approvals', label: 'Permission changes', layer: 1 },
  { path: '/console/audit', label: 'Audit log', layer: 1 },
  { path: '/console/break-glass', label: 'Emergency access', layer: 1 },
  { path: '/console/retention', label: 'Retention', layer: 1 },
  { path: '/console/public-records', label: 'Records requests', layer: 7 },
  { path: '/console/ai-register', label: 'AI use register', layer: 2 },
] as const;

interface Me {
  accountId: string;
  tenantId: string;
  tenantKind?: string;
  timeZone?: string;
  roles: { key: string; version: number }[];
  breakGlass: { id: string; expiresAt: string } | null;
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
    document.getElementById('main')?.focus();
  }, []);
  return { path, navigate };
}

function SignIn({ config }: { config: RuntimeConfig }) {
  const [realm, setRealm] = useState(rememberedRealm() ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <main id="main" tabIndex={-1} className="signin">
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

  if (!session) {
    return (
      <>
        <header className="top">
          <p className="product">{product}</p>
          <p className="county">
            {config.countyName ? `${config.countyName} Emergency Management` : ''}
          </p>
        </header>
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
      case '/console/devices':
        return <DevicesScreen />;
      case '/console/reference-data':
        return <RefdataScreen />;
      case '/console/fema-mappings':
        return <FemaMappingsScreen />;
      case '/console/integrations':
        return <IntegrationsScreen />;
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
      case '/console/public-records':
        return <PublicRecordsScreen />;
      case '/console/find-survivor':
        return <FindSurvivorScreen navigate={navigate} />;
      default:
        return (
          <section aria-labelledby="home-h">
            <h1 id="home-h">Welcome</h1>
            {me ? (
              <dl className="meta">
                <dt>Your roles</dt>
                <dd>
                  {me.roles.map((r) => `${r.key} (v${r.version})`).join(', ') ||
                    'none assigned yet'}
                </dd>
                <dt>Data</dt>
                <dd>Synthetic exercise data only</dd>
              </dl>
            ) : (
              <p role="status">Loading your account…</p>
            )}
            {me ? <KeyCounts /> : null}
          </section>
        );
    }
  })();

  return (
    <>
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <header className="top">
        <p className="product">{product}</p>
        <p className="county">
          {config.countyName ? `${config.countyName} Emergency Management` : ''}
        </p>
        {me ? <CommandWindow navigate={navigate} /> : null}
        <button type="button" className="link light" onClick={signOut}>
          Sign out
        </button>
      </header>
      {me?.breakGlass ? (
        <p className="banner" role="status">
          Emergency access is active until {formatTime(new Date(me.breakGlass.expiresAt))}. Every
          record you open is audited as restricted.
        </p>
      ) : null}
      {meError ? <Status kind="error">{meError}</Status> : null}
      <div className="layout">
        <nav aria-label="Workspaces">
          <ul>
            {routes.map((r) => (
              <li key={r.path}>
                <a
                  href={r.path}
                  aria-current={
                    path === r.path.replace(/\/$/, '') ||
                    (r.path === '/console/' && path === '/console')
                      ? 'page'
                      : undefined
                  }
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(r.path);
                  }}
                >
                  {r.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1}>
          {screen}
        </main>
      </div>
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

/**
 * The console home (CON-01, CON-03, CON-04, CON-06, CON-11; mockups/console/Main.dc.html).
 *
 * - The situation home, for anyone who holds `dashboard.read` while an event is
 *   open: the key counts as tiles with their as-of time, what needs the person's
 *   decision (recommendations, facility proposals, permission changes, overdue
 *   reminders), the significant events, and the way to the map and the reports.
 * - The work home, for everyone else: the workspaces they can use, as cards.
 * - Briefing mode (CON-11): the situation home at wall size, refreshed every
 *   minute, without the decision list (it names people).
 *
 * Every panel says when its data is from and what it is from
 * (docs/design/users-and-needs.md §1.2). Nothing here is new data: each panel
 * reads an endpoint that exists, and a role without one simply has no panel.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  DecisionCard,
  DecisionList,
  EmptyState,
  LinkButton,
  Notice,
  PageHeader,
  Pill,
  StatTile,
  Tiles,
  Timeline,
  applyMode,
  clockTime,
  count,
  humanize,
  icons,
  relativeTime,
} from '@cg/ui';
import { api, describeFailure } from '../api/client.ts';
import { visibleGroups } from '../ui/nav.ts';

export interface HomeMe {
  accountId: string;
  tenantId: string;
  tenantKind?: string | undefined;
  roles: { key: string; version: number; templateKey?: string | null }[];
  actions?: string[] | undefined;
}
export interface HomeEvent {
  id: string;
  name: string;
  hazardType?: string | null;
  status: string;
  openedAt?: string | null;
}

interface Counts {
  asOf: string;
  reports: { total: number; byState: Record<string, number>; danger: number };
  needs: { total: number; byStatus: Record<string, number>; standalone: number };
  sites: { byStatus: Record<string, number>; published: number };
  sharing: { activeGrants: number; partners: number };
  claims: { name: string; count: number }[];
}
interface Recommendation {
  id: string;
  kind: string;
  state: string;
  createdAt: string;
}
interface FacilityChange {
  id: string;
  facilityName: string | null;
  change: 'create' | 'update' | 'retire';
  source: string;
  createdAt: string;
}
interface PermissionChange {
  id: string;
  status: string;
  createdAt: string;
  summary?: string;
}
interface Reminder {
  id: string;
  title: string;
  dueAt: string;
  state: string;
}
interface Significant {
  id: string;
  occurredAt: string;
  kind: string;
  summary: string;
}
interface Declaration {
  clock?: { daysLeft: number; overdue: boolean; deadline: string } | null;
}

const has = (me: HomeMe | null, action: string) => !me?.actions || me.actions.includes(action);
const n = (v: number | undefined) => v ?? 0;

function useRefreshTick(every: number | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => setTick((x) => x + 1), every);
    return () => clearInterval(t);
  }, [every]);
  return tick;
}

/** The key counts (CON-04): one tile per figure, the as-of time once above them. */
export function KeyCountTiles({
  counts,
  navigate,
  extra,
}: {
  counts: Counts;
  navigate: (to: string) => void;
  /** More tiles for the same grid (the declaration window). */
  extra?: ReactNode;
}) {
  const r = counts.reports;
  const d = counts.needs;
  const s = counts.sites;
  return (
    <section aria-labelledby="counts-h">
      <div className="cg-card__head">
        <h2 id="counts-h">Key counts</h2>
        <p className="hint" style={{ margin: 0 }}>
          As of {clockTime(counts.asOf)} · from the county's own records
        </p>
      </div>
      <Tiles>
        <StatTile
          label="Resident reports"
          value={count(r.total)}
          detail={`${n(r.byState['submitted'])} new · ${n(r.byState['under_review'])} in review · ${n(r.byState['approved'])} approved`}
          href="/console/reports"
          onNavigate={navigate}
        />
        <StatTile
          label="Danger flags"
          value={count(r.danger)}
          detail="Awareness only; residents are told to call 911"
          {...(r.danger > 0 ? { tone: 'danger' as const } : {})}
        />
        <StatTile
          label="Needs"
          value={count(n(d.byStatus['open']))}
          unit="open"
          detail={`${n(d.byStatus['claimed'])} claimed · ${n(d.byStatus['met'])} met · ${d.standalone} without a damage report`}
          href="/console/needs"
          onNavigate={navigate}
          {...(n(d.byStatus['open']) > 0 ? { tone: 'warn' as const } : {})}
        />
        <StatTile
          label="Sites"
          value={count(n(s.byStatus['open']))}
          unit="open"
          detail={`${n(s.byStatus['full'])} full · ${n(s.byStatus['closed'])} closed · ${s.published} published`}
          href="/console/sites"
          onNavigate={navigate}
        />
        <StatTile
          label="Partner sharing"
          value={count(counts.sharing.activeGrants)}
          unit="grants"
          detail={`${counts.sharing.partners} partner organizations · ${counts.claims.reduce((a, c) => a + c.count, 0)} claims`}
        />
        {extra}
      </Tiles>
    </section>
  );
}

export function HomeScreen({
  me,
  events,
  navigate,
  briefing = false,
}: {
  me: HomeMe | null;
  events: HomeEvent[] | null;
  navigate: (to: string) => void;
  briefing?: boolean;
}) {
  const event = events?.find((e) => e.status === 'active') ?? events?.[0] ?? null;
  const situational = Boolean(me && has(me, 'dashboard.read') && event);
  const tick = useRefreshTick(briefing ? 60_000 : null);

  const [counts, setCounts] = useState<Counts | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [facilityChanges, setFacilityChanges] = useState<FacilityChange[] | null>(null);
  const [permissionChanges, setPermissionChanges] = useState<PermissionChange[] | null>(null);
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [significant, setSignificant] = useState<Significant[] | null>(null);
  const [declaration, setDeclaration] = useState<Declaration | null>(null);
  const [loadedAt, setLoadedAt] = useState<string>(() => new Date().toISOString());

  const load = useCallback(() => {
    if (!me) return;
    const jobs: Promise<unknown>[] = [];
    if (has(me, 'dashboard.read')) {
      jobs.push(
        api<Counts>('/dashboard/counts')
          .then((c) => {
            setCounts(c);
            setCountsError(null);
          })
          .catch((e: unknown) => setCountsError(describeFailure(e))),
      );
    }
    if (!briefing) {
      if (has(me, 'recommendation.decide'))
        jobs.push(
          api<Recommendation[]>('/recommendations?limit=50')
            .then((rows) => setRecs(rows.filter((r) => r.state === 'open')))
            .catch(() => setRecs(null)),
        );
      if (has(me, 'facility.approve'))
        jobs.push(
          api<FacilityChange[]>('/facility-changes?state=pending&limit=50')
            .then(setFacilityChanges)
            .catch(() => setFacilityChanges(null)),
        );
      if (has(me, 'permission_change.approve'))
        jobs.push(
          api<PermissionChange[]>('/permission-changes?status=pending&limit=50')
            .then(setPermissionChanges)
            .catch(() => setPermissionChanges(null)),
        );
      if (has(me, 'reminder.read'))
        jobs.push(
          api<Reminder[]>('/reminders?open=true&mine=true&limit=50')
            .then((rows) => setReminders(rows.filter((r) => r.state === 'overdue')))
            .catch(() => setReminders(null)),
        );
    }
    if (event && has(me, 'significant_event.read'))
      jobs.push(
        api<Significant[]>(`/significant-events?eventId=${event.id}&limit=8`)
          .then(setSignificant)
          .catch(() => setSignificant(null)),
      );
    if (event && has(me, 'declaration.read'))
      jobs.push(
        api<Declaration>(`/events/${event.id}/declaration`)
          .then(setDeclaration)
          .catch(() => setDeclaration(null)),
      );
    // The page's own time, set once the answers are in (not synchronously in the effect).
    void Promise.allSettled(jobs).then(() => setLoadedAt(new Date().toISOString()));
  }, [me, event, briefing]);

  useEffect(load, [load, tick]);

  useEffect(() => {
    if (!briefing) return;
    applyMode('briefing');
    return () => applyMode('normal');
  }, [briefing]);

  const groups = useMemo(() => visibleGroups(me), [me]);

  if (!me) {
    return (
      <section aria-labelledby="home-h">
        <h1 id="home-h">Home</h1>
        <p role="status">Loading your account…</p>
      </section>
    );
  }

  const roles = me.roles.length ? (
    <p className="small muted">
      Signed in as{' '}
      {me.roles.map((r, i) => (
        <span key={r.key}>
          {i > 0 ? ', ' : ''}
          {humanize(r.key)} (<code>{r.key}</code> v{r.version})
        </span>
      ))}
      . Synthetic exercise data only.
    </p>
  ) : (
    <p className="small muted">
      No role assigned yet; ask your administrator. Synthetic exercise data only.
    </p>
  );

  if (!situational) {
    return (
      <section aria-labelledby="home-h">
        <PageHeader
          id="home-h"
          title="Your work"
          lede={
            event
              ? `${event.name} · ${humanize(event.hazardType ?? '')} · ${humanize(event.status)}`
              : 'No open event.'
          }
        />
        {has(me, 'dashboard.read') && counts ? (
          <KeyCountTiles counts={counts} navigate={navigate} />
        ) : null}
        {countsError ? <Notice tone="warn">{countsError}</Notice> : null}
        <h2 id="work-h">Your workspaces</h2>
        <ul className="cg-tiles" aria-labelledby="work-h" style={{ listStyle: 'none', padding: 0 }}>
          {groups
            .flatMap((g) => g.items)
            .filter((i) => i.path !== '/console/')
            .map((i) => {
              const Icon = i.icon;
              return (
                <li key={i.path}>
                  {/* A button, not a second link with the workspace's name: the navigation holds the link. */}
                  <button type="button" className="cg-stat" onClick={() => navigate(i.path)}>
                    <span
                      className="cg-stat__label"
                      style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
                    >
                      {Icon ? <Icon width={18} height={18} aria-hidden="true" /> : null}
                      {i.label}
                    </span>
                  </button>
                </li>
              );
            })}
        </ul>
        {roles}
      </section>
    );
  }

  const decisions: { key: string; node: ReactNode }[] = [];
  for (const r of recs ?? [])
    decisions.push({
      key: `rec-${r.id}`,
      node: (
        <DecisionCard
          key={`rec-${r.id}`}
          kicker={`Recommendation · ${humanize(r.kind)}`}
          title={`${humanize(r.kind)} recommendation awaiting a decision`}
          tone="ai"
          actions={
            <LinkButton
              href="/console/recommendations"
              variant="primary"
              onPress={() => navigate('/console/recommendations')}
            >
              Review recommendation
            </LinkButton>
          }
        >
          Proposed {relativeTime(r.createdAt)}. A named person accepts, edits or rejects it; the
          record shows who.
        </DecisionCard>
      ),
    });
  for (const c of facilityChanges ?? [])
    decisions.push({
      key: `fac-${c.id}`,
      node: (
        <DecisionCard
          key={`fac-${c.id}`}
          kicker="Facility registry · proposal"
          title={`${c.change === 'create' ? 'New facility' : c.change === 'retire' ? 'Retire' : 'Change'}: ${c.facilityName ?? 'unnamed place'}`}
          actions={
            <LinkButton
              href="/console/facility-approvals"
              onPress={() => navigate('/console/facility-approvals')}
            >
              Decide in Facility approvals
            </LinkButton>
          }
        >
          From {humanize(c.source)}, {relativeTime(c.createdAt)}.
        </DecisionCard>
      ),
    });
  for (const p of permissionChanges ?? [])
    decisions.push({
      key: `perm-${p.id}`,
      node: (
        <DecisionCard
          key={`perm-${p.id}`}
          kicker="Permission change · second administrator"
          title="A permission change waits for your approval"
          tone="warn"
          actions={
            <LinkButton href="/console/approvals" onPress={() => navigate('/console/approvals')}>
              Open Permission changes
            </LinkButton>
          }
        >
          Requested {relativeTime(p.createdAt)}. Granting permissions needs a second administrator
          (ADM-05).
        </DecisionCard>
      ),
    });
  for (const r of reminders ?? [])
    decisions.push({
      key: `rem-${r.id}`,
      node: (
        <DecisionCard
          key={`rem-${r.id}`}
          kicker="Reminder · overdue"
          title={r.title}
          tone="danger"
          actions={
            <LinkButton href="/console/reminders" onPress={() => navigate('/console/reminders')}>
              Open Reminders
            </LinkButton>
          }
        >
          Due {relativeTime(r.dueAt)}.
        </DecisionCard>
      ),
    });

  const clock = declaration?.clock ?? null;

  return (
    <section aria-labelledby="home-h">
      <PageHeader
        id="home-h"
        title="Situation"
        lede={
          event
            ? `${event.name} · ${humanize(event.hazardType ?? '')} · ${humanize(event.status)} · this page refreshed ${clockTime(loadedAt)}`
            : undefined
        }
        actions={
          briefing ? (
            <LinkButton href="/console/" onPress={() => navigate('/console/')} icon={icons.Tv}>
              Leave briefing mode
            </LinkButton>
          ) : (
            <>
              <LinkButton
                href="/console/situation"
                onPress={() => navigate('/console/situation')}
                icon={icons.Map}
              >
                Situation map
              </LinkButton>
              <LinkButton
                href="/console/briefing"
                onPress={() => navigate('/console/briefing')}
                icon={icons.Tv}
              >
                Briefing mode
              </LinkButton>
              <Button icon={icons.RefreshCw} onPress={load}>
                Refresh
              </Button>
            </>
          )
        }
      />
      {briefing ? (
        <p className="cg-briefing-bar" role="status">
          <Pill tone="info" dot>
            Refreshes every minute
          </Pill>
          <span>Wall display: counts and events only, no personal details (CON-11).</span>
        </p>
      ) : null}

      {counts ? (
        <KeyCountTiles
          counts={counts}
          navigate={navigate}
          extra={
            clock ? (
              <StatTile
                label="Declaration window"
                value={count(Math.max(0, clock.daysLeft))}
                unit="days"
                detail={
                  clock.overdue
                    ? `The 30-day clock ran out on ${clock.deadline}`
                    : `left of 30 · deadline ${clock.deadline}`
                }
                {...(clock.overdue || clock.daysLeft <= 7 ? { tone: 'danger' as const } : {})}
                href="/console/declaration"
                onNavigate={navigate}
              />
            ) : null
          }
        />
      ) : countsError ? (
        <Notice tone="warn">{countsError}</Notice>
      ) : (
        <p role="status">Loading key counts…</p>
      )}

      {!briefing ? (
        <section aria-labelledby="decisions-h">
          <h2 id="decisions-h">Needs your decision</h2>
          {decisions.length ? (
            <DecisionList aria-labelledby="decisions-h">
              {decisions.map((d) => d.node)}
            </DecisionList>
          ) : (
            <EmptyState icon={icons.CircleCheck} title="Nothing waits on you right now">
              Recommendations, facility proposals, permission changes and overdue reminders appear
              here when they need a named person's decision.
            </EmptyState>
          )}
        </section>
      ) : null}

      {significant ? (
        <Card
          title={<h2 id="sig-h">Significant events</h2>}
          kicker={`${event?.name ?? ''} · as of ${clockTime(loadedAt)}`}
          actions={
            !briefing ? (
              <LinkButton
                variant="link"
                href="/console/missions"
                onPress={() => navigate('/console/missions')}
              >
                Missions and the full log
              </LinkButton>
            ) : undefined
          }
          aria-labelledby="sig-h"
        >
          {significant.length ? (
            <Timeline
              aria-labelledby="sig-h"
              entries={significant.map((s) => ({
                id: s.id,
                time: clockTime(s.occurredAt),
                at: s.occurredAt,
                source: humanize(s.kind),
                text: s.summary,
              }))}
            />
          ) : (
            <p className="empty">No significant events recorded for this event yet.</p>
          )}
        </Card>
      ) : null}

      {!briefing ? roles : null}
    </section>
  );
}

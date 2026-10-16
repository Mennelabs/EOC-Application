/**
 * Home (mockup FieldHome.dc.html; FLD-01, FLD-13, FLD-16, DSP-07, DSP-08):
 * team and time on shift, the location indicator, the check-in timer with
 * "We're OK" (team leads; others see who confirms), hazard warnings near the
 * current position, the work assigned to this person or team with
 * "Got it", the latest message from dispatch, and how many records are
 * still on the phone. "What you can do" lists only the modules the role
 * allows (FLD-01; the server checks again). The help button is on every screen (ui.tsx).
 */
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { timerLabel, timerPhase } from '@cg/field-core';
import { useField, useHazardWarnings } from '../src/field';
import { useOnline } from '../src/online';
import { clock, duration } from '../src/format';
import { MODULES } from '../src/records';
import { label } from '../src/vocab';
import { Alert, Body, Button, Card, Heading, NavBar, Page, SyncBadge } from '../src/ui';

export default function Home() {
  const f = useField();
  const {
    t,
    locale,
    checkIn,
    team,
    timer,
    assignments,
    messages,
    outbox,
    policy,
    areaState,
    areaSummary,
  } = f;
  const warnings = useHazardWarnings();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const pending = outbox.filter(
    (c) => c.status === 'on_this_phone' || c.status === 'sending',
  ).length;
  const unread = messages.filter((m) => !m.receipt?.acknowledgedAt);
  const latest = unread[0] ?? null;
  const phase = timer ? timerPhase(timer, now) : 'ok';
  // FL-12: the last hand-over left for this worker's team (needs signal; quiet without it).
  const handovers = useOnline(checkIn && !checkIn.endedAt ? `handovers:${checkIn.id}` : null, () =>
    f.online<
      { checkInId: string; personnelName: string | null; createdAt: string; text: string }[]
    >('/handovers?mine=true&limit=1'),
  );
  const last = handovers.data?.find((h) => h.checkInId !== checkIn?.id) ?? null;
  return (
    <Page title={t('home.heading')}>
      {last ? (
        <Card label={t('handover.last')}>
          <Heading level={2}>{t('handover.last')}</Heading>
          <Body muted>
            {t('handover.lastBy', {
              name: last.personnelName ?? '—',
              time: clock(last.createdAt, locale),
            })}
          </Body>
          <Body>{last.text}</Body>
        </Card>
      ) : null}
      <Card label={t('home.heading')}>
        <Heading level={2}>
          {team
            ? t('home.team', {
                team: team.callsign ? `${team.name} (${team.callsign})` : team.name,
              })
            : t('home.noTeam')}
        </Heading>
        {checkIn ? (
          <Body>{t('home.onShift', { time: duration(checkIn.startedAt, now) })}</Body>
        ) : null}
        <Body>{policy.enabled ? `● ${t('home.sharing')}` : `○ ${t('home.notSharing')}`}</Body>
        {timer ? (
          <View style={{ gap: 8 }}>
            <Body live>
              {t('home.timer', {
                time: clock(
                  new Date(
                    new Date(timer.lastConfirmedAt).getTime() + timer.intervalMinutes * 60_000,
                  ).toISOString(),
                  locale,
                ),
              })}
              {' · '}
              {phase === 'overdue' || phase === 'due' ? '⚠ ' : ''}
              {timerLabel(timer, now, locale)}
            </Body>
            {f.can('team.status') ? (
              <Button label={t('home.ok')} onPress={() => void f.weAreOk()} />
            ) : (
              <Body muted>{t('home.okLead')}</Body>
            )}
          </View>
        ) : null}
      </Card>

      {warnings.map((w) => (
        <Alert key={w.hazard.id} tone="danger">
          {w.inside
            ? t('home.hazardInside', { kind: label(locale, 'hazardKinds', w.hazard.kind) })
            : t('home.hazardNear', {
                kind: label(locale, 'hazardKinds', w.hazard.kind),
                distance: w.distanceM,
              })}
          {w.hazard.summary ? ` — ${w.hazard.summary}` : ''}
        </Alert>
      ))}

      {areaState === 'downloading' ? <Body live>{t('area.downloading')}</Body> : null}
      {areaState === 'failed' ? <Alert tone="warn">{t('area.failed')}</Alert> : null}
      {areaSummary ? (
        <Body muted live>
          {t('area.ready')}{' '}
          {t('area.counts', {
            assignments: areaSummary.assignments,
            parcels: areaSummary.parcels,
            hazards: areaSummary.hazards,
          })}
        </Body>
      ) : null}

      <Card label={t('home.tools')}>
        <Heading level={2}>{t('home.tools')}</Heading>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {f.can('command.use') ? (
            <Button
              kind="secondary"
              label={t('command.open')}
              onPress={() => router.push('/command')}
            />
          ) : null}
          {f.can('assessment.record') ? (
            <Button label={t('work.newProperty')} onPress={() => router.push('/locate')} />
          ) : null}
          {f.can('hazard.report') ? (
            <Button
              kind="secondary"
              label={t('report.heading')}
              onPress={() => router.push('/report')}
            />
          ) : null}
          {f.can('service_log.write') ? (
            <Button
              kind="secondary"
              label={t('counters.heading')}
              onPress={() => router.push('/counters')}
            />
          ) : null}
          {f.can('site.confirm') ? (
            <Button
              kind="secondary"
              label={t('census.heading')}
              onPress={() => router.push('/census')}
            />
          ) : null}
          {f.can('need.done') ? (
            <Button
              kind="secondary"
              label={t('needs.heading')}
              onPress={() => router.push('/needs')}
            />
          ) : null}
          {MODULES.filter((m) => f.can(m.action)).map((m) => (
            <Button
              key={m.kind}
              kind="secondary"
              label={m.title[locale]}
              onPress={() => router.push({ pathname: '/record/[kind]', params: { kind: m.kind } })}
            />
          ))}
          {f.can('shelter_stay.write') ? (
            <Button
              kind="secondary"
              label={t('shelter.heading')}
              onPress={() => router.push('/shelter')}
            />
          ) : null}
          {f.can('child_check_in.write') ? (
            <Button
              kind="secondary"
              label={t('child.heading')}
              onPress={() => router.push('/child')}
            />
          ) : null}
          {f.can('stock.write') ? (
            <Button
              kind="secondary"
              label={t('stock.heading')}
              onPress={() => router.push('/stock')}
            />
          ) : null}
          {f.can('scribe.use') ? (
            <Button
              kind="secondary"
              label={t('scribe.heading')}
              onPress={() => router.push('/scribe')}
            />
          ) : null}
          {f.can('survivor.find') ? (
            <Button
              kind="secondary"
              label={t('find.heading')}
              onPress={() => router.push('/find')}
            />
          ) : null}
          {f.can('translation.use') ? (
            <Button
              kind="secondary"
              label={t('translate.heading')}
              onPress={() => router.push('/translate')}
            />
          ) : null}
          {f.can('interpreter.respond') ? (
            <Button
              kind="secondary"
              label={t('interp.heading')}
              onPress={() => router.push('/interpreter')}
            />
          ) : null}
          {f.can('badge.verify') ? (
            <Button
              kind="secondary"
              label={t('check.heading')}
              onPress={() => router.push('/checkpoint')}
            />
          ) : null}
          {f.can('job_aid.read') ? (
            <Button
              kind="secondary"
              label={t('aids.heading')}
              onPress={() => router.push('/job-aids')}
            />
          ) : null}
        </View>
      </Card>

      <Card label={t('home.route')}>
        <Heading level={2}>{t('home.route')}</Heading>
        {assignments.length === 0 ? <Body muted>{t('home.noWork')}</Body> : null}
        {assignments.map((a) => (
          <View key={a.id} style={{ gap: 6, paddingVertical: 6 }}>
            <Heading level={3}>
              {a.mission?.reference ?? a.reference ?? ''} ·{' '}
              {label(locale, 'missionKinds', a.mission?.kind)}
            </Heading>
            {a.mission?.summary ? <Body>{a.mission.summary}</Body> : null}
            {a.mission?.location ? (
              <Body muted>
                {[a.mission.location.line1, a.mission.location.city, a.mission.location.landmark]
                  .filter(Boolean)
                  .join(', ')}
                {a.mission.location.usng ? ` · USNG ${a.mission.location.usng}` : ''}
              </Body>
            ) : null}
            <Body>{label(locale, 'assignmentStates', a.state)}</Body>
            <SyncBadge state={a.syncState} />
            {a.state === 'dispatched' || a.state === 'assigned' ? (
              <Button
                label={t('home.acknowledge')}
                onPress={() => void f.acknowledgeAssignment(a.id)}
              />
            ) : null}
            <Button
              kind="secondary"
              label={t('home.open')}
              onPress={() => router.push({ pathname: '/work/[id]', params: { id: a.id } })}
            />
          </View>
        ))}
      </Card>

      <Card label={t('home.messages')}>
        <Heading level={2}>{t('home.messages')}</Heading>
        {latest ? (
          <View style={{ gap: 6 }}>
            <Body muted>{t('messages.from', { time: clock(latest.sentAt, locale) })}</Body>
            <Body>{latest.body}</Body>
            <Button
              label={t('messages.ack')}
              onPress={() => void f.acknowledgeMessage(latest.id)}
            />
          </View>
        ) : (
          <Body muted>{t('home.noMessages')}</Body>
        )}
      </Card>

      <Card label={t('nav.sync')}>
        {pending ? (
          <>
            <Body>{t('home.records', { count: pending })}</Body>
            <Body muted>{t('home.recordsBody')}</Body>
          </>
        ) : (
          <Body muted>{t('home.allSent')}</Body>
        )}
      </Card>
      <NavBar current="home" />
    </Page>
  );
}

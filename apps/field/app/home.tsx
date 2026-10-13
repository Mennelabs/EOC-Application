/**
 * Home (mockup FieldHome.dc.html; FLD-01, FLD-13, FLD-16, DSP-07, DSP-08):
 * team and time on shift, the location indicator, the check-in timer with
 * "We're OK" (team leads; others see who confirms), hazard warnings near the
 * current position, the work assigned to this person or team with
 * "Got it", the latest message from dispatch, and how many records are
 * still on the phone. The help button is on every screen (ui.tsx).
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { timerLabel, timerPhase } from '@cg/field-core';
import { useField, useHazardWarnings } from '../src/field';
import { clock, duration } from '../src/format';
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
  return (
    <Page title={t('home.heading')}>
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

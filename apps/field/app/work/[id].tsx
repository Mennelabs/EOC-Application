/**
 * One assignment (FLD-01, RULE-03, DSP-05): what the work is and where, and
 * the facts the team records one at a time: on the way, arrived, done here.
 * "Arrived?" is only ever a suggestion from the position, confirmed by a
 * tap, never applied by itself. Verification routes open the street sweep;
 * any job can record a property.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { distanceM, hazardsAround } from '@cg/field-core';
import { useField } from '../../src/field';
import { label } from '../../src/vocab';
import { Alert, Body, Button, Card, Heading, NavBar, Page, SyncBadge } from '../../src/ui';

export default function Work() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const f = useField();
  const { t, locale, assignments, fix } = f;
  const a = assignments.find((x) => x.id === id);
  if (!a)
    return (
      <Page title={t('work.heading')}>
        <Body>{t('work.gone')}</Body>
        <NavBar current="home" />
      </Page>
    );
  const m = a.mission;
  const where = m?.location?.position ?? null;
  const near = fix && where ? distanceM(fix, where) <= 100 : false;
  // HAZ-01, BRD:FR-04.05: the hazard areas the job is in or within 100 m of, from the area package.
  const atJob = where ? hazardsAround(where, f.hazards, 100) : [];
  const can = (to: string) =>
    (to === 'en_route' && ['acknowledged', 'dispatched', 'assigned'].includes(a.state)) ||
    (to === 'on_scene' && ['acknowledged', 'en_route'].includes(a.state)) ||
    (to === 'cleared' && a.state === 'on_scene');
  return (
    <Page title={`${m?.reference ?? ''} · ${label(locale, 'missionKinds', m?.kind)}`}>
      <Card>
        {m?.summary ? <Body>{m.summary}</Body> : null}
        {m?.location ? (
          <Body muted>
            {[m.location.line1, m.location.city, m.location.landmark].filter(Boolean).join(', ')}
            {m.location.usng ? ` · USNG ${m.location.usng}` : ''}
          </Body>
        ) : null}
        <Body>{label(locale, 'assignmentStates', a.state)}</Body>
        <SyncBadge state={a.syncState} />
      </Card>
      {atJob.length ? (
        <>
          <Heading level={2}>{t('work.hazards')}</Heading>
          {atJob.map((w) => (
            <Alert key={w.hazard.id} tone="danger">
              {w.inside
                ? t('work.hazardAt', { kind: label(locale, 'hazardKinds', w.hazard.kind) })
                : t('work.hazardNearJob', {
                    kind: label(locale, 'hazardKinds', w.hazard.kind),
                    distance: String(w.distanceM),
                  })}
              {w.hazard.summary ? ` — ${w.hazard.summary}` : ''}
            </Alert>
          ))}
        </>
      ) : null}
      {near && can('on_scene') ? <Alert>{t('work.arrivedSuggest')}</Alert> : null}
      <Heading level={2}>{t('work.facts')}</Heading>
      {a.state === 'dispatched' || a.state === 'assigned' ? (
        <Button label={t('home.acknowledge')} onPress={() => void f.acknowledgeAssignment(a.id)} />
      ) : null}
      {can('en_route') ? (
        <Button
          kind="secondary"
          label={t('work.enRoute')}
          onPress={() => void f.setAssignmentStatus(a.id, 'en_route')}
        />
      ) : null}
      {can('on_scene') ? (
        <Button
          kind={near ? 'primary' : 'secondary'}
          label={t('work.arrived')}
          onPress={() => void f.setAssignmentStatus(a.id, 'on_scene')}
        />
      ) : null}
      {can('cleared') ? (
        <Button
          kind="secondary"
          label={t('work.cleared')}
          onPress={() => void f.setAssignmentStatus(a.id, 'cleared')}
        />
      ) : null}
      {f.can('assessment.record') ? (
        <>
          <Heading level={2}>{t('work.properties')}</Heading>
          {m?.kind === 'verification_route' ? (
            <Button
              label={t('work.sweep')}
              onPress={() =>
                router.push({ pathname: '/sweep', params: { missionId: m.id, assignmentId: a.id } })
              }
            />
          ) : null}
          <Button
            kind="secondary"
            label={t('work.newProperty')}
            onPress={() =>
              router.push({
                pathname: '/locate',
                params: { missionId: m?.id ?? '', assignmentId: a.id },
              })
            }
          />
        </>
      ) : null}
      {m && f.can('command.use') && f.can('mission.read') ? (
        // CMD-06: the command screen opened from here takes this job's mission as "this".
        <Button
          kind="secondary"
          label={t('command.aboutJob')}
          onPress={() =>
            router.push({
              pathname: '/command',
              params: { missionId: m.id, missionRef: m.reference ?? '' },
            })
          }
        />
      ) : null}
      {m && f.can('mission.person.edit') ? (
        <Button
          kind="secondary"
          label={t('people.heading')}
          onPress={() => router.push({ pathname: '/people/[id]', params: { id: m.id } })}
        />
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}

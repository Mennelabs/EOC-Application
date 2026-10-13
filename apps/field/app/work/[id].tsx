/**
 * One assignment (FLD-01, RULE-03, DSP-05): what the work is and where, and
 * the facts the team records one at a time: on the way, arrived, done here.
 * "Arrived?" is only ever a suggestion from the position, confirmed by a
 * tap, never applied by itself. Verification routes open the street sweep;
 * any job can record a property.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { distanceM } from '@cg/field-core';
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

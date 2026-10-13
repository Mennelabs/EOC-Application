/**
 * People involved in a mission, for medical assist (FL:FR-02, DSP-13,
 * AC-04): the injury level and transport for each person, entered by the
 * crew on scene. Medical assist only: this never dispatches EMS or calls
 * 911. Details the role may not see stay hidden (restricted categories); the
 * list needs signal and every change carries the version it was based on.
 */
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { RadioGroup } from '../../src/controls';
import { useField } from '../../src/field';
import { problem, useOnline } from '../../src/online';
import { Alert, Body, Card, Heading, NavBar, Page } from '../../src/ui';

interface Person {
  id: string;
  version: number;
  role: string;
  displayLabel: string | null;
  injury: string | null;
  transport: string | null;
  status: string;
}
const INJURIES = ['none', 'minor', 'serious', 'critical', 'unknown'];
const TRANSPORTS = ['none', 'ems', 'own', 'shelter_transport', 'other', 'unknown'];

export default function People() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const f = useField();
  const { t } = f;
  const [message, setMessage] = useState<string | null>(null);
  const query = useOnline(id ?? null, () => f.online<Person[]>(`/missions/${id ?? ''}/people`));
  const people = query.data;
  const load = query.reload;
  const update = async (p: Person, patch: Record<string, string>) => {
    try {
      await f.send('PATCH', `/missions/${id}/people/${p.id}`, patch, {
        'if-match': String(p.version),
      });
      setMessage(t('people.saved'));
      void load();
    } catch (err) {
      setMessage(problem(err, t));
      void load();
    }
  };
  return (
    <Page title={t('people.heading')}>
      <Alert tone="warn">{t('people.notDispatch')}</Alert>
      {message ? <Alert>{message}</Alert> : null}
      {query.error ? <Alert tone="warn">{problem(query.error, t)}</Alert> : null}
      {people === null ? <Body muted>{t('records.needsSignal')}</Body> : null}
      {people?.length === 0 ? <Body muted>{t('people.none')}</Body> : null}
      {people
        ?.filter((p) => p.status === 'active')
        .map((p, i) => (
          <Card key={p.id} label={p.displayLabel ?? t('people.person', { n: i + 1 })}>
            <Heading level={3}>{p.displayLabel ?? t('people.person', { n: i + 1 })}</Heading>
            <RadioGroup
              label={t('people.injury')}
              options={INJURIES.map((v) => ({ value: v, label: t(`people.injury.${v}` as never) }))}
              value={p.injury}
              onChange={(v) => void update(p, { injury: v })}
            />
            <RadioGroup
              label={t('people.transport')}
              options={TRANSPORTS.map((v) => ({
                value: v,
                label: t(`people.transport.${v}` as never),
              }))}
              value={p.transport}
              onChange={(v) => void update(p, { transport: v })}
            />
          </Card>
        ))}
      <NavBar current="home" />
    </Page>
  );
}

/**
 * Service counters (FL-06, FR-17, FR-22, FLD-12): one tap per meal, water
 * case, tarp or cot, at a site or along a route; each tap is saved on the
 * phone with its own id so a resend never counts twice. Today's taps on
 * this phone are shown beside each button.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useField } from '../src/field';
import { Body, Button, Card, Heading, NavBar, Page } from '../src/ui';

const KINDS = ['meal', 'water_case', 'tarp', 'cot', 'ride', 'person_served'] as const;

export default function Counters() {
  const f = useField();
  const { t } = f;
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [site, setSite] = useState<string | null>(null);
  const [tally, setTally] = useState<Record<string, number>>({});
  useEffect(() => {
    void f.list<{ id: string; name: string }>('sites').then(setSites);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, []);
  const add = async (kind: string, n: number) => {
    await f.logService(kind, n, site ?? undefined);
    setTally((x) => ({ ...x, [kind]: (x[kind] ?? 0) + n }));
  };
  return (
    <Page title={t('counters.heading')}>
      <Card label={t('counters.where')}>
        <Heading level={2}>{t('counters.where')}</Heading>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button
            kind={site === null ? 'primary' : 'secondary'}
            label={t('counters.route')}
            onPress={() => setSite(null)}
          />
          {sites.map((s) => (
            <Button
              key={s.id}
              kind={site === s.id ? 'primary' : 'secondary'}
              label={s.name}
              onPress={() => setSite(s.id)}
            />
          ))}
        </View>
      </Card>
      {KINDS.map((k) => (
        <Card key={k} label={t(`counters.kind.${k}`)}>
          <Heading level={3}>{t(`counters.kind.${k}`)}</Heading>
          <Body live>{t('counters.today', { n: tally[k] ?? 0 })}</Body>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={`+1 ${t(`counters.kind.${k}`)}`} onPress={() => void add(k, 1)} />
            {k === 'meal' ? (
              <Button
                kind="secondary"
                label={`+10 ${t(`counters.kind.${k}`)}`}
                onPress={() => void add(k, 10)}
              />
            ) : null}
          </View>
        </Card>
      ))}
      <NavBar current="home" />
    </Page>
  );
}

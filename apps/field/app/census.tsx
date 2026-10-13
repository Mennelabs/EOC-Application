/** Census and capacity in two taps (FLD-12, CON-16): pick the site, set how many people are there and whether it has room. */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useField } from '../src/field';
import { Alert, Body, Button, Card, Heading, NavBar, Page } from '../src/ui';

interface Site {
  id: string;
  name: string;
  kind: string;
  status: string;
}

export default function Census() {
  const f = useField();
  const { t } = f;
  const [sites, setSites] = useState<Site[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<'open' | 'limited' | 'full'>('open');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void f.list<Site>('sites').then(setSites);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, []);
  return (
    <Page
      title={t('census.heading')}
      actions={
        site ? (
          <Button
            label={t('census.save')}
            onPress={() => void f.census(site.id, count, status).then(() => setSaved(true))}
          />
        ) : undefined
      }
    >
      {saved ? <Alert>{t('census.saved')}</Alert> : null}
      <Card label={t('census.site')}>
        <Heading level={2}>{t('census.site')}</Heading>
        {sites.length === 0 ? <Body muted>{t('census.noSites')}</Body> : null}
        {sites.map((s) => (
          <Button
            key={s.id}
            kind={site?.id === s.id ? 'primary' : 'secondary'}
            label={s.name}
            onPress={() => {
              setSite(s);
              setSaved(false);
            }}
          />
        ))}
      </Card>
      {site ? (
        <Card label={t('census.count')}>
          <Heading level={2}>{t('census.count')}</Heading>
          <Body live>{t('census.people', { n: count })}</Body>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button
              kind="secondary"
              label="−10"
              onPress={() => setCount((c) => Math.max(0, c - 10))}
            />
            <Button
              kind="secondary"
              label="−1"
              onPress={() => setCount((c) => Math.max(0, c - 1))}
            />
            <Button kind="secondary" label="+1" onPress={() => setCount((c) => c + 1)} />
            <Button kind="secondary" label="+10" onPress={() => setCount((c) => c + 10)} />
          </View>
          <Heading level={3}>{t('census.room')}</Heading>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(['open', 'limited', 'full'] as const).map((s) => (
              <Button
                key={s}
                kind={status === s ? 'primary' : 'secondary'}
                label={t(`census.status.${s}`)}
                onPress={() => setStatus(s)}
              />
            ))}
          </View>
        </Card>
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}

/**
 * Pets (FL:FR-08): how many animals each shelter holds now, and lost reports
 * matched to animals found or sheltered. Possible matches are suggestions
 * only, the same kind of animal with the words the descriptions share; a
 * person confirms a match, and marks the pet gone home. Owners are known by
 * their reference code only. Needs signal; intakes and lost reports are
 * recorded on the pet intake form, which works offline.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useField } from '../src/field';
import { problem, useOnline } from '../src/online';
import { label } from '../src/vocab';
import { Alert, Body, Button, Card, Heading, NavBar, Page } from '../src/ui';

interface Pet {
  id: string;
  species: string;
  description: string | null;
  ownerReferenceCode: string | null;
  status: string;
  matchedWith: string | null;
}
interface Census {
  siteId: string | null;
  siteName: string | null;
  total: number;
  bySpecies: Record<string, number>;
}
interface Candidate {
  record: Pet;
  shared: string[];
}

export default function Pets() {
  const f = useField();
  const { t, locale } = f;
  const eventId = f.checkIn?.eventId ?? null;
  const [message, setMessage] = useState<string | null>(null);
  const [looking, setLooking] = useState<{ id: string; list: Candidate[] } | null>(null);
  const q = eventId ? `?eventId=${eventId}` : '';
  const census = useOnline(`pets:census:${eventId}`, () =>
    f.online<Census[]>(`/field-records/pet_intake/census${q}`),
  );
  const lost = useOnline(`pets:lost:${eventId}`, () =>
    f.online<Pet[]>(`/field-records/pet_intake${q ? `${q}&` : '?'}status=lost_report&limit=50`),
  );
  const animal = (p: Pet) =>
    `${label(locale, 'species', p.species)}${p.description ? `: ${p.description}` : ''}`;
  const find = async (p: Pet) => {
    try {
      const list = await f.online<Candidate[]>(`/field-records/pet_intake/${p.id}/candidates`);
      setLooking({ id: p.id, list });
      setMessage(list.length ? null : t('pets.noCandidates'));
    } catch (err) {
      setMessage(problem(err, t));
    }
  };
  const step = async (path: string, body: unknown, done: string) => {
    try {
      await f.send('POST', path, body);
      setMessage(done);
      setLooking(null);
    } catch (err) {
      setMessage(problem(err, t));
    }
    census.reload();
    lost.reload();
  };
  const open = lost.data?.filter((p) => !p.matchedWith) ?? [];
  const matched = lost.data?.filter((p) => p.matchedWith) ?? [];
  return (
    <Page title={t('pets.heading')}>
      <Body>{t('pets.intro')}</Body>
      {message ? <Alert>{message}</Alert> : null}
      {census.error || lost.error ? (
        <Alert tone="warn">{problem(census.error ?? lost.error, t)}</Alert>
      ) : null}
      <Button
        kind="secondary"
        label={t('pets.intake')}
        onPress={() => router.push({ pathname: '/record/[kind]', params: { kind: 'pet_intake' } })}
      />
      <Card label={t('pets.census')}>
        <Heading level={2}>{t('pets.census')}</Heading>
        {census.data?.length === 0 ? <Body muted>{t('pets.noneSheltered')}</Body> : null}
        {census.data?.map((c) => (
          <Body key={c.siteId ?? 'none'}>
            {t('pets.atSite', {
              site: c.siteName ?? t('pets.noSite'),
              total: c.total,
              kinds: Object.entries(c.bySpecies)
                .map(([k, n]) => `${label(locale, 'species', k)} ${n}`)
                .join(', '),
            })}
          </Body>
        ))}
      </Card>
      <Card label={t('pets.lost')}>
        <Heading level={2}>{t('pets.lost')}</Heading>
        {lost.data && open.length === 0 ? <Body muted>{t('pets.noLost')}</Body> : null}
        {open.map((p) => (
          <View key={p.id} style={{ gap: 6, paddingVertical: 4 }}>
            <Body>
              {animal(p)}
              {p.ownerReferenceCode ? ` · ${t('pets.code', { code: p.ownerReferenceCode })}` : ''}
            </Body>
            <Button
              kind="secondary"
              label={t('pets.find', { animal: label(locale, 'species', p.species) })}
              onPress={() => void find(p)}
            />
            {looking?.id === p.id
              ? looking.list.map((c) => (
                  <View key={c.record.id} style={{ gap: 4, paddingLeft: 12 }}>
                    <Body>{animal(c.record)}</Body>
                    <Body muted>
                      {c.shared.length
                        ? t('pets.shares', { words: c.shared.join(', ') })
                        : t('pets.sharesNothing')}
                    </Body>
                    <Button
                      kind="secondary"
                      label={t('pets.confirm')}
                      onPress={() =>
                        void step(
                          `/field-records/pet_intake/${p.id}/match`,
                          { otherId: c.record.id },
                          t('pets.matched'),
                        )
                      }
                    />
                  </View>
                ))
              : null}
          </View>
        ))}
      </Card>
      {matched.length ? (
        <Card label={t('pets.matchedHeading')}>
          <Heading level={2}>{t('pets.matchedHeading')}</Heading>
          {matched.map((p) => (
            <View key={p.id} style={{ gap: 6, paddingVertical: 4 }}>
              <Body>{animal(p)}</Body>
              <Button
                kind="secondary"
                label={t('pets.home', { animal: label(locale, 'species', p.species) })}
                onPress={() =>
                  void step(`/field-records/pet_intake/${p.id}/reunite`, {}, t('pets.wentHome'))
                }
              />
            </View>
          ))}
        </Card>
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}

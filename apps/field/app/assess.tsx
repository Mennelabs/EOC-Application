/**
 * Damage assessment (FLD-08, FLD-05, FLD-13): the home type, then the degree
 * chosen from a picture and a short description for that home type, a few
 * picture-based observations, a note and, when there is no parcel, a
 * landmark. Saved on the phone first; it sends when there is signal. No
 * resident personal details are asked for.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import {
  DEGREES,
  STRUCTURES,
  degreeName,
  describe,
  structureName,
  type Degree,
  type Structure,
} from '../src/assessment';
import { HouseDiagram } from '../src/diagram';
import { useField } from '../src/field';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

export default function Assess() {
  const p = useLocalSearchParams<{
    parcelId?: string;
    address?: string;
    structure?: string;
    lat?: string;
    lon?: string;
    acc?: string;
    landmark?: string;
    missionId?: string;
    assignmentId?: string;
  }>();
  const f = useField();
  const { t, locale, theme } = f;
  const [structure, setStructure] = useState<Structure>(
    (STRUCTURES as string[]).includes(p.structure ?? '')
      ? (p.structure as Structure)
      : 'single_family',
  );
  const [degree, setDegree] = useState<Degree | null>(null);
  const [waterInside, setWaterInside] = useState<'yes' | 'no' | 'unknown'>('unknown');
  const [note, setNote] = useState('');
  const [landmark, setLandmark] = useState('');
  const [saved, setSaved] = useState(false);
  const needsLandmark = !p.parcelId;
  const save = async () => {
    if (!degree) return;
    await f.recordAssessment({
      mode: 'detailed',
      structure,
      degree,
      ...(p.parcelId ? { parcelId: p.parcelId, address: p.address ?? null } : {}),
      ...(p.lat && p.lon
        ? {
            position: {
              lat: Number(p.lat),
              lon: Number(p.lon),
              ...(p.acc ? { accuracyM: Number(p.acc) } : {}),
            },
          }
        : {}),
      ...(landmark.trim() ? { landmark: landmark.trim() } : {}),
      observations: { water_inside: waterInside },
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(p.missionId ? { missionId: p.missionId } : {}),
      ...(p.assignmentId ? { assignmentId: p.assignmentId } : {}),
    });
    setSaved(true);
  };
  const choice = (selected: boolean): ViewStyle => ({
    minHeight: theme.target,
    borderWidth: selected ? 4 : 2,
    borderColor: selected ? theme.primary : theme.border,
    borderRadius: 10,
    padding: 10,
    backgroundColor: theme.surface,
  });
  if (saved)
    return (
      <Page title={t('assess.heading')}>
        <Alert>{t('assess.saved')}</Alert>
        <Button
          label={t('assess.another')}
          onPress={() =>
            router.replace({
              pathname: '/locate',
              params: {
                ...(p.missionId ? { missionId: p.missionId } : {}),
                ...(p.assignmentId ? { assignmentId: p.assignmentId } : {}),
              },
            })
          }
        />
        <Button kind="secondary" label={t('nav.home')} onPress={() => router.replace('/home')} />
        <NavBar current="home" />
      </Page>
    );
  return (
    <Page
      title={t('assess.heading')}
      actions={
        <Button
          label={t('assess.save')}
          disabled={!degree || (needsLandmark && !landmark.trim())}
          onPress={() => void save()}
        />
      }
    >
      <Body>
        {p.address || (p.parcelId ? t('locate.parcel', { id: p.parcelId }) : t('assess.noParcel'))}
      </Body>
      {needsLandmark ? (
        <Field
          label={t('assess.landmark')}
          hint={t('assess.landmarkHint')}
          value={landmark}
          onChange={setLandmark}
        />
      ) : null}
      <Heading level={2}>{t('assess.homeType')}</Heading>
      <View
        role="radiogroup"
        aria-label={t('assess.homeType')}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
      >
        {STRUCTURES.map((s) => (
          <Pressable
            key={s}
            role="radio"
            aria-checked={s === structure}
            onPress={() => setStructure(s)}
            style={choice(s === structure)}
          >
            <Text style={{ color: theme.text, fontSize: theme.font }}>
              {structureName(locale, s)}
            </Text>
          </Pressable>
        ))}
      </View>
      <Heading level={2}>{t('assess.degree')}</Heading>
      <Body muted>{t('assess.degreeHint')}</Body>
      <View role="radiogroup" aria-label={t('assess.degree')} style={{ gap: 8 }}>
        {DEGREES.map((d) => (
          <Pressable
            key={d}
            role="radio"
            aria-checked={d === degree}
            onPress={() => setDegree(d)}
            style={[choice(d === degree), { flexDirection: 'row', gap: 12, alignItems: 'center' }]}
          >
            <HouseDiagram
              structure={structure}
              degree={d}
              theme={theme}
              size={84}
              label={`${degreeName(locale, d)}: ${describe(locale, structure, d)}`}
            />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: theme.text, fontSize: theme.font + 1, fontWeight: '700' }}>
                {degreeName(locale, d)}
              </Text>
              <Text style={{ color: theme.text, fontSize: theme.font - 1 }}>
                {describe(locale, structure, d)}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
      <Card>
        <Heading level={3}>{t('assess.water')}</Heading>
        <View
          role="radiogroup"
          aria-label={t('assess.water')}
          style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}
        >
          {(['yes', 'no', 'unknown'] as const).map((v) => (
            <Pressable
              key={v}
              role="radio"
              aria-checked={v === waterInside}
              onPress={() => setWaterInside(v)}
              style={choice(v === waterInside)}
            >
              <Text style={{ color: theme.text, fontSize: theme.font }}>
                {t(`assess.water.${v}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </Card>
      <Field label={t('assess.note')} hint={t('assess.noteHint')} value={note} onChange={setNote} />
      <NavBar current="home" />
    </Page>
  );
}

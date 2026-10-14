/**
 * Damage assessment (FLD-08, FLD-05, FLD-07, FLD-09, FLD-13): photos first,
 * the home type, then the degree chosen from a picture and a short
 * description for that home type, the damage seen, a voice or typed note
 * that can draft the home type and damage seen (each confirmed by the
 * volunteer, never the degree), the details FEMA asks for (DCL:DEC-17:
 * water depth in feet and inches, units, occupancy, insurance, utilities,
 * tribal ownership where the county asks it, business details) and, when
 * there is no parcel, a landmark. Saved on the phone first; it sends when
 * there is signal. No resident personal details are asked for.
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
import { emptyFema, femaObservations } from '../src/fema';
import { FemaCard } from '../src/fema-card';
import { useField } from '../src/field';
import { PhotoStrip } from '../src/photos';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';
import { VoiceNote } from '../src/voice';

const SEEN = ['roof', 'windows_doors', 'walls', 'tree_on_home', 'moved_off_foundation'] as const;

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
  const [id] = useState(() => globalThis.crypto.randomUUID());
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [seen, setSeen] = useState<string[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [usedDrafts, setUsedDrafts] = useState<string[]>([]);
  const [fema, setFema] = useState(emptyFema);
  const tribalOwnership = f.options.tribalOwnership;
  const details = femaObservations(fema, structure, tribalOwnership, (l) => t(`fema.depth.${l}`));
  const needsLandmark = !p.parcelId;
  const save = async () => {
    if (!degree || details.problems.length) return;
    await f.recordAssessment({
      id,
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
      observations: {
        water_inside: waterInside,
        ...(seen.length ? { seen } : {}),
        ...details.observations,
        // Which fields came from a confirmed voice draft; the draft records provider and model (AIG-12).
        ...(draftId && usedDrafts.length ? { voice_draft: draftId, voice_used: usedDrafts } : {}),
      },
      ...(photoIds.length ? { photoIds } : {}),
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
          disabled={!degree || (needsLandmark && !landmark.trim()) || details.problems.length > 0}
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
      <PhotoStrip ids={photoIds} onChange={setPhotoIds} />
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
      <Card>
        <Heading level={3}>{t('assess.seen')}</Heading>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {SEEN.map((v) => (
            <Pressable
              key={v}
              role="checkbox"
              aria-checked={seen.includes(v)}
              onPress={() => setSeen(seen.includes(v) ? seen.filter((x) => x !== v) : [...seen, v])}
              style={choice(seen.includes(v))}
            >
              <Text style={{ color: theme.text, fontSize: theme.font }}>{t(`seen.${v}`)}</Text>
            </Pressable>
          ))}
        </View>
      </Card>
      <FemaCard
        value={fema}
        onChange={setFema}
        structure={structure}
        tribalOwnership={tribalOwnership}
      />
      {details.problems.length ? (
        <Alert tone="warn">
          {[t('fema.fix'), ...details.problems.map((x) => t(x.key, x.params))].join('\n')}
        </Alert>
      ) : null}
      <VoiceNote
        clientUuid={id}
        text={note}
        onText={setNote}
        label={t('assess.note')}
        onUse={(d, did) => {
          setDraftId(did);
          setUsedDrafts((u) => [...u, `${d.field}:${d.value}`]);
          if (d.field === 'structure' && (STRUCTURES as string[]).includes(d.value))
            setStructure(d.value as Structure);
          else if (d.field === 'water_inside') setWaterInside('yes');
          else if (d.field === 'seen')
            setSeen((cur) => (cur.includes(d.value) ? cur : [...cur, d.value]));
        }}
      />
      <NavBar current="home" />
    </Page>
  );
}

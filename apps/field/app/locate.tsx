/**
 * Locate (mockup FieldLocate.dc.html; FLD-04, FLD-05): the position snapped
 * to the nearest parcel from the area package, "Is this the property?" with
 * the address of record, the parcel id, the USNG coordinate and the GPS
 * accuracy, and the lot drawn from its outline with the pin on it (a sketch
 * named in words). "Pick another lot" lists the neighbours; "Move the pin" nudges
 * it ten metres at a time with buttons (no dragging needed, WCAG 2.5.7);
 * "Add a landmark note instead" works with no parcel at all.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  distanceToParcelM,
  pointInParcel,
  snapToParcel,
  toUsng,
  type Parcel,
  type Point,
} from '@cg/field-core';
import { useField } from '../src/field';
import { currentFix } from '../src/location';
import { ParcelSketch } from '../src/parcel-sketch';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

const STEP_M = 10;

export default function Locate() {
  const params = useLocalSearchParams<{ missionId?: string; assignmentId?: string }>();
  const f = useField();
  const { t } = f;
  const [parcels, setParcels] = useState<Parcel[]>([]);
  const [pin, setPin] = useState<(Point & { accuracyM: number | null }) | null>(null);
  const [state, setState] = useState<'locating' | 'ready' | 'no_fix'>('locating');
  const [chosen, setChosen] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    void f.list<Parcel>('parcels').then(setParcels);
    void currentFix().then((fix) => {
      if (fix) {
        setPin({ lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM });
        setState('ready');
      } else setState('no_fix');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on arrival
  }, []);
  const snap = useMemo(() => (pin ? snapToParcel(pin, parcels) : null), [pin, parcels]);
  const parcel = chosen
    ? (parcels.find((p) => p.parcelId === chosen) ?? null)
    : (snap?.parcel ?? null);
  const go = (p: Parcel | null, landmark = false) =>
    router.push({
      pathname: '/assess',
      params: {
        ...(params.missionId ? { missionId: params.missionId } : {}),
        ...(params.assignmentId ? { assignmentId: params.assignmentId } : {}),
        ...(p
          ? {
              parcelId: p.parcelId,
              address: [p.line1, p.city].filter(Boolean).join(', '),
              structure: p.structure,
            }
          : {}),
        ...(pin
          ? { lat: String(pin.lat), lon: String(pin.lon), acc: String(pin.accuracyM ?? '') }
          : {}),
        ...(landmark ? { landmark: '1' } : {}),
      },
    });
  const nudge = (dLat: number, dLon: number) =>
    setPin((p) => {
      if (!p) return p;
      setChosen(null);
      const degLat = STEP_M / 111_320;
      const degLon = STEP_M / (111_320 * Math.cos((p.lat * Math.PI) / 180));
      return { ...p, lat: p.lat + dLat * degLat, lon: p.lon + dLon * degLon };
    });
  const matches =
    search.trim().length >= 2
      ? parcels
          .filter((p) =>
            `${p.line1 ?? ''} ${p.parcelId}`.toLowerCase().includes(search.trim().toLowerCase()),
          )
          .slice(0, 8)
      : [];
  return (
    <Page title={t('locate.heading')}>
      {state === 'locating' ? <Body live>{t('locate.locating')}</Body> : null}
      {state === 'no_fix' ? <Alert tone="warn">{t('locate.noFix')}</Alert> : null}
      {parcel ? (
        <Card label={t('locate.question')}>
          <Heading level={2}>{t('locate.question')}</Heading>
          <Body>
            {[parcel.line1, parcel.city].filter(Boolean).join(', ') || t('locate.noAddress')}
          </Body>
          <Body muted>{t('locate.parcel', { id: parcel.parcelId })}</Body>
          <ParcelSketch
            parcel={parcel}
            parcels={parcels}
            pin={pin}
            label={[
              t('locate.sketch', {
                address: [parcel.line1, parcel.city].filter(Boolean).join(', ') || parcel.parcelId,
              }),
              pin
                ? pointInParcel(pin, parcel)
                  ? t('locate.sketchInside')
                  : t('locate.sketchOutside', {
                      m: Math.round(distanceToParcelM(pin, parcel)),
                    })
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
          />
          {pin ? <Body muted>USNG {toUsng(pin.lat, pin.lon)}</Body> : null}
          {pin?.accuracyM != null ? (
            <Body muted>{t('locate.accuracy', { m: Math.round(pin.accuracyM) })}</Body>
          ) : null}
          {snap && !chosen && snap.confidence === 'far' ? (
            <Alert tone="warn">{t('locate.far', { m: Math.round(snap.distanceM) })}</Alert>
          ) : null}
          <Button label={t('locate.yes')} onPress={() => go(parcel)} />
        </Card>
      ) : state === 'ready' ? (
        <Alert tone="warn">{t('locate.noParcel')}</Alert>
      ) : null}
      {snap?.alternatives.length ? (
        <Card label={t('locate.another')}>
          <Heading level={2}>{t('locate.another')}</Heading>
          {snap.alternatives.map((alt) => (
            <Button
              key={alt.parcel.parcelId}
              kind="secondary"
              label={`${alt.parcel.line1 ?? alt.parcel.parcelId} · ${Math.round(alt.distanceM)} m`}
              onPress={() => setChosen(alt.parcel.parcelId)}
            />
          ))}
        </Card>
      ) : null}
      {pin ? (
        <Card label={t('locate.move')}>
          <Heading level={2}>{t('locate.move')}</Heading>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button kind="secondary" label={t('locate.north')} onPress={() => nudge(1, 0)} />
            <Button kind="secondary" label={t('locate.south')} onPress={() => nudge(-1, 0)} />
            <Button kind="secondary" label={t('locate.west')} onPress={() => nudge(0, -1)} />
            <Button kind="secondary" label={t('locate.east')} onPress={() => nudge(0, 1)} />
          </View>
        </Card>
      ) : null}
      <Card label={t('locate.search')}>
        <Field label={t('locate.search')} value={search} onChange={setSearch} />
        {matches.map((p) => (
          <Button
            key={p.parcelId}
            kind="secondary"
            label={`${p.line1 ?? ''} · ${p.parcelId}`}
            onPress={() => go(p)}
          />
        ))}
      </Card>
      <Button kind="secondary" label={t('locate.landmark')} onPress={() => go(null, true)} />
      <NavBar current="home" />
    </Page>
  );
}

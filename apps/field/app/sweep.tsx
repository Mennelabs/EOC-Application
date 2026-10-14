/**
 * Street sweep (mockup FieldSweep.dc.html; FLD-10, FLD-13): walking a block,
 * one tap per property (no damage, affected, minor, major, destroyed, can't
 * reach); each tap is saved on the phone and the pin advances to the next
 * parcel in walking order. "Can't reach" asks why in one more tap, private
 * or public road or bridge first, as FEMA asks (DCL:DEC-17); the reason can
 * be skipped. Undo takes back the last tap while it is still
 * on the phone; once sent, tapping the property again makes a second record
 * that a reviewer sees beside the first (never overwritten).
 */
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  CANT_REACH_REASONS,
  currentStop,
  startSweep,
  sweepProgress,
  tap,
  undo,
  type CantReachReason,
  type Parcel,
  type SweepState,
  type SweepTap,
} from '@cg/field-core';
import { SWEEP_TAPS, degreeName, type Structure } from '../src/assessment';
import { HouseDiagram } from '../src/diagram';
import { useField, type Mission } from '../src/field';
import { lastFix } from '../src/location';
import { Alert, Body, Button, Card, Heading, NavBar, Page } from '../src/ui';

type Saved = SweepState & {
  commands: Record<string, string>;
  structures: Record<string, string>;
  addresses?: Record<string, string>;
};

export default function Sweep() {
  const { missionId = '', assignmentId = '' } = useLocalSearchParams<{
    missionId?: string;
    assignmentId?: string;
  }>();
  const f = useField();
  const { t, locale, theme } = f;
  const [sweep, setSweep] = useState<Saved | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // One tap per property: a tap while the previous one is still being saved is ignored (FLD-10).
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  // "Can't reach" was tapped: the reasons show in place of the damage taps.
  const [reaching, setReaching] = useState(false);
  const key = `sweep.${missionId}`;
  useEffect(() => {
    void (async () => {
      const stored = await f.list<{ id: string; state: Saved }>('sweeps');
      const existing = stored.find((x) => x.id === key);
      if (existing) return setSweep(existing.state);
      const missions = await f.list<Mission & { route?: { area?: string } | null }>('missions');
      const mission = missions.find((m) => m.id === missionId);
      const parcels = await f.list<Parcel>('parcels');
      const area = mission?.route?.area;
      const stops = parcels
        .filter((p) => p.centroid && (!area || p.areaKey === area))
        .map((p) => ({ parcelId: p.parcelId, position: p.centroid! }));
      const start = lastFix() ??
        mission?.location?.position ??
        stops[0]?.position ?? { lat: 0, lon: 0 };
      const s = startSweep(stops, start);
      const structures = Object.fromEntries(parcels.map((p) => [p.parcelId, p.structure]));
      const addresses = Object.fromEntries(
        parcels.map((p) => [p.parcelId, [p.line1, p.city].filter(Boolean).join(', ')]),
      );
      setSweep({ ...s, commands: {}, structures, addresses });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mission
  }, [missionId]);
  const persist = async (next: Saved) => {
    setSweep(next);
    await f.saveDoc('sweeps', { id: key, state: next });
  };
  if (!sweep)
    return (
      <Page title={t('sweep.heading')}>
        <Body live>{t('area.downloading')}</Body>
      </Page>
    );
  const stop = currentStop(sweep);
  const progress = sweepProgress(sweep);
  const structure = ((stop && sweep.structures[stop.parcelId]) ?? 'single_family') as Structure;
  const onTap = async (value: SweepTap, reason?: CantReachReason) => {
    if (!stop || busy.current) return;
    if (value === 'cant_reach' && !reaching) {
      setReaching(true);
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      const id = await f.recordAssessment({
        mode: 'sweep',
        parcelId: stop.parcelId,
        position: { lat: stop.position.lat, lon: stop.position.lon },
        structure,
        degree: value,
        ...(reason ? { observations: { cant_reach_reason: reason } } : {}),
        ...(missionId ? { missionId } : {}),
        ...(assignmentId ? { assignmentId } : {}),
      });
      setMessage(null);
      setReaching(false);
      await persist({
        ...sweep,
        ...tap(sweep, value),
        commands: { ...sweep.commands, [stop.parcelId]: id },
      });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const onUndo = async () => {
    const prev = sweep.order[sweep.index - 1];
    if (!prev || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const cmd = sweep.commands[prev.parcelId];
      const withdrawn = cmd ? await f.withdraw(cmd) : false;
      setMessage(withdrawn ? t('sweep.undone') : t('sweep.undoSent'));
      const rest = { ...sweep.commands };
      if (withdrawn) delete rest[prev.parcelId];
      await persist({ ...sweep, ...undo(sweep), commands: rest });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  return (
    <Page title={t('sweep.heading')}>
      <Body live>{t('sweep.progress', { done: progress.done, total: progress.total })}</Body>
      {stop ? (
        <Card label={t('sweep.current')}>
          <Heading level={2}>{t('sweep.current')}</Heading>
          {sweep.addresses?.[stop.parcelId] ? <Body>{sweep.addresses[stop.parcelId]}</Body> : null}
          <Body muted>{t('locate.parcel', { id: stop.parcelId })}</Body>
        </Card>
      ) : (
        <Alert>{t('sweep.finished')}</Alert>
      )}
      {message ? <Alert>{message}</Alert> : null}
      {stop && reaching ? (
        <View role="group" aria-label={t('sweep.reach.heading')} style={{ gap: 8 }}>
          <Heading level={2}>{t('sweep.reach.heading')}</Heading>
          {CANT_REACH_REASONS.map((r) => (
            <Button
              key={r}
              kind="secondary"
              label={t(`reach.${r}`)}
              disabled={saving}
              onPress={() => void onTap('cant_reach', r)}
            />
          ))}
          <Button
            kind="secondary"
            label={t('sweep.reach.none')}
            disabled={saving}
            onPress={() => void onTap('cant_reach')}
          />
          <Button kind="secondary" label={t('common.back')} onPress={() => setReaching(false)} />
        </View>
      ) : null}
      {stop && !reaching ? (
        <View
          role="group"
          aria-label={t('sweep.tapGroup')}
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
        >
          {SWEEP_TAPS.map((d) => (
            <Pressable
              key={d}
              role="button"
              aria-disabled={saving}
              disabled={saving}
              onPress={() => void onTap(d)}
              style={{
                minHeight: theme.target * 2,
                width: '48%',
                borderWidth: 2,
                borderColor: theme.border,
                borderRadius: 10,
                padding: 8,
                alignItems: 'center',
                gap: 4,
                backgroundColor: theme.surface,
              }}
            >
              {d !== 'cant_reach' ? (
                <HouseDiagram structure={structure} degree={d} theme={theme} size={64} label="" />
              ) : null}
              <Text style={{ color: theme.text, fontSize: theme.font, fontWeight: '700' }}>
                {degreeName(locale, d)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {sweep.index > 0 && !reaching ? (
        <Button kind="secondary" label={t('sweep.undo')} onPress={() => void onUndo()} />
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}

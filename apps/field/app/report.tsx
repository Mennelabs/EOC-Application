/**
 * Quick report from any screen (FLD-11, HAZ-01): a hazard, how a site looks,
 * or a resource the worker came across, each as a pin, a photo and a
 * category, with a short note. A hazard goes to dispatch as "reported" until
 * someone confirms it. A site report is an observation for dispatch, never
 * the site's status of record (its lead confirms that on the census screen).
 * In danger now: call 911.
 */
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { RadioGroup } from '../src/controls';
import { useField } from '../src/field';
import { currentFix } from '../src/location';
import { label } from '../src/vocab';
import { PhotoStrip } from '../src/photos';
import { Alert, Body, Button, Field, Heading, NavBar, Page } from '../src/ui';

const KINDS = [
  'downed_line',
  'gas_leak',
  'blocked_road',
  'unsafe_structure',
  'flooding',
  'debris',
  'animal',
  'other',
] as const;
const TYPES = ['hazard', 'site_status', 'resource_seen'] as const;
const SITE_STATUSES = ['open', 'limited', 'full', 'closed', 'damaged'] as const;
const RESOURCES = [
  'water',
  'food',
  'fuel',
  'pharmacy',
  'store',
  'power',
  'equipment',
  'other',
] as const;

interface Site {
  id: string;
  name: string;
}

export default function Report() {
  const f = useField();
  const { t, locale, theme } = f;
  const [type, setType] = useState<(typeof TYPES)[number]>('hazard');
  const [kind, setKind] = useState<(typeof KINDS)[number] | null>(null);
  const [severity, setSeverity] = useState<'caution' | 'danger'>('caution');
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [siteStatus, setSiteStatus] = useState<(typeof SITE_STATUSES)[number] | null>(null);
  const [resource, setResource] = useState<(typeof RESOURCES)[number] | null>(null);
  const [place, setPlace] = useState('');
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  useEffect(() => {
    void f.list<Site>('sites').then(setSites);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, []);
  const choice = (selected: boolean): ViewStyle => ({
    minHeight: theme.target,
    borderWidth: selected ? 4 : 2,
    borderColor: selected ? theme.primary : theme.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    justifyContent: 'center',
    backgroundColor: theme.surface,
  });
  const ready =
    type === 'hazard'
      ? kind !== null
      : type === 'site_status'
        ? siteId !== null && siteStatus !== null
        : resource !== null;
  const send = async () => {
    if (!ready) return;
    if (type === 'hazard' && kind) {
      const fix = await currentFix();
      await f.quickReport({
        kind,
        severity,
        ...(note.trim() ? { summary: note.trim() } : {}),
        ...(photoIds.length ? { photoIds } : {}),
        ...(fix
          ? {
              position: {
                lat: fix.lat,
                lon: fix.lon,
                ...(fix.accuracyM != null ? { accuracyM: fix.accuracyM } : {}),
              },
            }
          : {}),
      });
      setSaved(t('report.saved'));
      return;
    }
    const site = sites.find((s) => s.id === siteId);
    const summary =
      type === 'site_status'
        ? `${site?.name ?? ''}: ${t(`report.siteStatus.${siteStatus ?? 'open'}`)}`
        : t(`report.resource.${resource ?? 'other'}`);
    await f.saveRecord(
      'field_report',
      {
        category: type,
        ...(type === 'site_status' ? { siteId, siteStatus } : { resourceKind: resource }),
        ...(type === 'resource_seen' && place.trim() ? { place: place.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      summary,
      { photoIds, attachPosition: true },
    );
    setSaved(t('report.savedObservation'));
  };
  if (saved)
    return (
      <Page title={t('report.heading')}>
        <Alert>{saved}</Alert>
        <Button label={t('nav.home')} onPress={() => router.replace('/home')} />
      </Page>
    );
  return (
    <Page
      title={t('report.heading')}
      actions={<Button label={t('report.send')} disabled={!ready} onPress={() => void send()} />}
    >
      <Alert tone="danger">{t('emergency.call911')}</Alert>
      <RadioGroup
        label={t('report.type')}
        options={TYPES.map((v) => ({ value: v, label: t(`report.type.${v}`) }))}
        value={type}
        onChange={(v) => setType(v as (typeof TYPES)[number])}
      />
      {type === 'hazard' ? (
        <>
          <Heading level={2}>{t('report.what')}</Heading>
          <View
            role="radiogroup"
            aria-label={t('report.what')}
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
          >
            {KINDS.map((k) => (
              <Pressable
                key={k}
                role="radio"
                aria-checked={k === kind}
                onPress={() => setKind(k)}
                style={choice(k === kind)}
              >
                <Text style={{ color: theme.text, fontSize: theme.font }}>
                  {label(locale, 'hazardKinds', k)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Heading level={2}>{t('report.how')}</Heading>
          <View
            role="radiogroup"
            aria-label={t('report.how')}
            style={{ flexDirection: 'row', gap: 8 }}
          >
            {(['caution', 'danger'] as const).map((s) => (
              <Pressable
                key={s}
                role="radio"
                aria-checked={s === severity}
                onPress={() => setSeverity(s)}
                style={choice(s === severity)}
              >
                <Text style={{ color: theme.text, fontSize: theme.font }}>
                  {t(`report.severity.${s}`)}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      {type === 'site_status' ? (
        <>
          {sites.length === 0 ? (
            <Body muted>{t('report.noSites')}</Body>
          ) : (
            <RadioGroup
              label={t('report.site')}
              options={sites.map((s) => ({ value: s.id, label: s.name }))}
              value={siteId}
              onChange={setSiteId}
            />
          )}
          <RadioGroup
            label={t('report.siteStatus')}
            options={SITE_STATUSES.map((v) => ({ value: v, label: t(`report.siteStatus.${v}`) }))}
            value={siteStatus}
            onChange={(v) => setSiteStatus(v as (typeof SITE_STATUSES)[number])}
          />
        </>
      ) : null}
      {type === 'resource_seen' ? (
        <>
          <RadioGroup
            label={t('report.resource')}
            options={RESOURCES.map((v) => ({ value: v, label: t(`report.resource.${v}`) }))}
            value={resource}
            onChange={(v) => setResource(v as (typeof RESOURCES)[number])}
          />
          <Field
            label={t('report.place')}
            hint={t('report.placeHint')}
            value={place}
            onChange={setPlace}
          />
        </>
      ) : null}
      <Field label={t('report.note')} value={note} onChange={setNote} multiline />
      <PhotoStrip ids={photoIds} onChange={setPhotoIds} />
      <Body muted>{t('report.where')}</Body>
      <NavBar current="home" />
    </Page>
  );
}

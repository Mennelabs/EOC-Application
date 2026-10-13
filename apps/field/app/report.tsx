/**
 * Quick report from any screen (FLD-11, HAZ-01): a hazard as a pin and a
 * category, with how serious it looks and a short note. It goes to dispatch
 * as "reported" until someone confirms it. In danger now: call 911.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
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

export default function Report() {
  const f = useField();
  const { t, locale, theme } = f;
  const [kind, setKind] = useState<(typeof KINDS)[number] | null>(null);
  const [severity, setSeverity] = useState<'caution' | 'danger'>('caution');
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const choice = (selected: boolean): ViewStyle => ({
    minHeight: theme.target,
    borderWidth: selected ? 4 : 2,
    borderColor: selected ? theme.primary : theme.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    justifyContent: 'center',
    backgroundColor: theme.surface,
  });
  const send = async () => {
    if (!kind) return;
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
    setSaved(true);
  };
  if (saved)
    return (
      <Page title={t('report.heading')}>
        <Alert>{t('report.saved')}</Alert>
        <Button label={t('nav.home')} onPress={() => router.replace('/home')} />
      </Page>
    );
  return (
    <Page
      title={t('report.heading')}
      actions={<Button label={t('report.send')} disabled={!kind} onPress={() => void send()} />}
    >
      <Alert tone="danger">{t('emergency.call911')}</Alert>
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
      <View role="radiogroup" aria-label={t('report.how')} style={{ flexDirection: 'row', gap: 8 }}>
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
      <Field label={t('report.note')} value={note} onChange={setNote} multiline />
      <PhotoStrip ids={photoIds} onChange={setPhotoIds} />
      <Body muted>{t('report.where')}</Body>
      <NavBar current="home" />
    </Page>
  );
}

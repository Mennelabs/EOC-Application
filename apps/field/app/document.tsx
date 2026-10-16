/**
 * Add a document a survivor chooses to share (FL-09). After finding their
 * record, the worker asks in the survivor's language whether they may
 * photograph the document into the record; the question is shown on screen
 * for the survivor to read too. Only when they say or tap yes does the camera
 * open. The photo goes from the camera to the server and is never saved in
 * the phone's photo library or kept on the phone; without signal, nothing is
 * taken. The survivor's answer and the words they agreed to are kept with
 * the document.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { takePhoto } from '../src/camera';
import { RadioGroup } from '../src/controls';
import { useField } from '../src/field';
import { translate, type Locale, type MessageKey } from '../src/i18n';
import { problem } from '../src/online';
import { Alert, Body, Button, Card, Heading, NavBar, Page } from '../src/ui';

type Kind = 'lease' | 'id' | 'insurance' | 'other';

const bytesOf = (b64: string): Uint8Array => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
};

export default function ShareDocument() {
  const f = useField();
  const { t } = f;
  const params = useLocalSearchParams<{ reportId?: string; code?: string }>();
  const [kind, setKind] = useState<Kind | null>(null);
  const [theirs, setTheirs] = useState<Locale>(f.locale);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reportId = params.reportId ?? '';

  const question = kind
    ? translate(theirs, 'doc.consent', {
        doc: translate(theirs, `doc.kind.${kind}` as MessageKey),
      })
    : null;

  const capture = async (method: 'spoken' | 'tapped') => {
    if (!kind || !question) return;
    setBusy(true);
    setMessage(null);
    try {
      // The camera only: a document never comes from, or goes to, the photo library.
      const shot = await takePhoto(false);
      if (shot === 'denied') {
        setMessage({ tone: 'warn', text: t('doc.cameraDenied') });
        return;
      }
      if (!shot) {
        setMessage({ tone: 'info', text: t('doc.cancelled') });
        return;
      }
      const made = await f.send<{ documentId: string; uploadPath: string }>(
        'POST',
        `/reports/${reportId}/documents`,
        {
          clientUuid: crypto.randomUUID(),
          kind,
          consent: { method, language: theirs, text: question },
          contentType: shot.contentType,
          bytes: Math.round(shot.bytes),
        },
      );
      await f.sendBytes(
        made.uploadPath.replace(/^\/api\/v1/, ''),
        shot.contentType,
        bytesOf(shot.data),
      );
      setMessage({ tone: 'info', text: t('doc.saved') });
      setKind(null);
    } catch (err) {
      // Nothing stays on the phone: without signal the survivor is asked again later.
      setMessage({ tone: 'warn', text: problem(err, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title={t('doc.heading')}>
      <Body>{t('doc.intro', { code: params.code ?? '' })}</Body>
      {!reportId ? <Alert tone="warn">{t('doc.noRecord')}</Alert> : null}
      <RadioGroup
        label={t('doc.which')}
        value={kind}
        onChange={(v) => {
          setKind(v as Kind);
          setMessage(null);
        }}
        options={(['lease', 'id', 'insurance', 'other'] as const).map((k) => ({
          value: k,
          label: t(`doc.option.${k}` as MessageKey),
        }))}
      />
      <RadioGroup
        label={t('doc.theirLanguage')}
        value={theirs}
        onChange={(v) => setTheirs(v as Locale)}
        options={[
          { value: 'en', label: 'English' },
          { value: 'es', label: 'Español' },
        ]}
      />
      {question ? (
        <Card label={t('doc.ask')}>
          <Heading level={2}>{t('doc.ask')}</Heading>
          <View {...({ lang: theirs } as object)}>
            <Body>{question}</Body>
          </View>
          <Button
            label={t('doc.saidYes')}
            disabled={busy || !reportId}
            onPress={() => void capture('spoken')}
          />
          <Button
            kind="secondary"
            label={t('doc.tappedYes')}
            disabled={busy || !reportId}
            onPress={() => void capture('tapped')}
          />
          <Button
            kind="secondary"
            label={t('doc.saidNo')}
            disabled={busy}
            onPress={() => {
              setKind(null);
              setMessage({ tone: 'info', text: t('doc.nothingTaken') });
            }}
          />
        </Card>
      ) : null}
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <Button kind="secondary" label={t('doc.back')} onPress={() => router.back()} />
      <NavBar current="home" />
    </Page>
  );
}

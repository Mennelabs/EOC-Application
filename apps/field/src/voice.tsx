/**
 * Voice notes (FLD-09, INT-13, INT-16, AIG-10): the volunteer dictates with
 * the keyboard's microphone (or types) into the note; "Fill in from my
 * words" asks the server for drafted fields. Each draft is shown as a plain
 * statement with the words behind it, and is used only when the volunteer
 * says yes, one at a time. The degree is never drafted (FLD-08). With the
 * feature off, no signal or a failure, the volunteer is told plainly and
 * fills the fields in; the words stay in the note either way.
 */
import { useState } from 'react';
import { View } from 'react-native';
import type { VoiceDraft } from './api';
import { structureName, type Structure } from './assessment';
import { useField } from './field';
import type { MessageKey } from './i18n';
import { Alert, Body, Button, Card, Field, Heading } from './ui';

type Draft = VoiceDraft['drafts'][number];

export function VoiceNote({
  clientUuid,
  text,
  onText,
  label,
  onUse,
}: {
  clientUuid: string;
  text: string;
  onText: (v: string) => void;
  label: string;
  onUse: (d: Draft, draftId: string) => void;
}) {
  const f = useField();
  const { t, locale } = f;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'drafts'; draftId: string; drafts: Draft[]; injection: boolean }
    | { kind: 'message'; text: string }
    | null
  >(null);
  const [answered, setAnswered] = useState<Record<number, 'used' | 'rejected'>>({});
  const statement = (d: Draft) =>
    d.field === 'structure'
      ? t('voice.structure', { value: structureName(locale, d.value as Structure) })
      : d.field === 'water_inside'
        ? t('voice.water')
        : t('voice.seen', { value: t(`seen.${d.value}` as MessageKey) });
  const draft = async () => {
    setBusy(true);
    setAnswered({});
    try {
      const r = await f.voiceDraft(clientUuid, text.trim());
      if ('offline' in r) setResult({ kind: 'message', text: t('voice.offline') });
      else if ('off' in r) setResult({ kind: 'message', text: r.off });
      else
        setResult({
          kind: 'drafts',
          draftId: r.draftId,
          drafts: r.drafts,
          injection: r.injectionSuspected,
        });
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <Heading level={2}>{t('voice.heading')}</Heading>
      <Field label={label} hint={t('voice.hint')} value={text} onChange={onText} multiline />
      {f.can('assessment.record') ? (
        <Button
          kind="secondary"
          label={busy ? t('voice.working') : t('voice.draft')}
          disabled={busy || text.trim().length < 3}
          onPress={() => void draft()}
        />
      ) : null}
      {result?.kind === 'message' ? <Alert tone="warn">{result.text}</Alert> : null}
      {result?.kind === 'drafts' ? (
        <View style={{ gap: 8 }} aria-live="polite">
          {result.injection ? (
            <Alert tone="warn">{t('voice.injection')}</Alert>
          ) : result.drafts.length === 0 ? (
            <Alert tone="warn">{t('voice.none')}</Alert>
          ) : (
            <Body muted>{t('voice.notice')}</Body>
          )}
          {result.drafts.map((d, i) => (
            <Card key={`${d.field}-${d.value}-${i}`}>
              <Body>{t('voice.youSaid', { evidence: d.evidence })}</Body>
              <Heading level={3}>{statement(d)}</Heading>
              {answered[i] ? (
                <Body muted>{answered[i] === 'used' ? t('voice.used') : t('voice.rejected')}</Body>
              ) : (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Button
                    label={t('voice.confirm')}
                    onPress={() => {
                      onUse(d, result.draftId);
                      setAnswered({ ...answered, [i]: 'used' });
                    }}
                  />
                  <Button
                    kind="secondary"
                    label={t('voice.reject')}
                    onPress={() => setAnswered({ ...answered, [i]: 'rejected' })}
                  />
                </View>
              )}
            </Card>
          ))}
        </View>
      ) : null}
    </View>
  );
}

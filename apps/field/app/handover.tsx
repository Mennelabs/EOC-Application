/**
 * Shift hand-over (layer-7 task H; FL-12, AI-03): before checking out, the
 * worker reads a draft of what their shift did and what is still open, made
 * from their own records; the AI assistant can rewrite it from the same
 * facts, labelled with its provider and model. The worker changes what is
 * needed and saves it for the next shift on the team, then checks out. It
 * needs signal; without it, or without a note, the worker simply checks out.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useField } from '../src/field';
import { problem, useOnline } from '../src/online';
import { Alert, Body, Button, Field, NavBar, Page } from '../src/ui';

interface Draft {
  rules: string;
  saved: { text: string } | null;
}
interface AiDraft {
  text: string;
  provider: string;
  model: string;
  outputId: string;
}

export default function Handover() {
  const f = useField();
  const { t, locale, checkIn } = f;
  const query = useOnline(checkIn ? `handover:${checkIn.id}:${locale}` : null, () =>
    f.online<Draft>(`/check-ins/${checkIn!.id}/handover?language=${locale}`),
  );
  const [text, setText] = useState<string | null>(null);
  const [ai, setAi] = useState<AiDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const value = text ?? query.data?.saved?.text ?? query.data?.rules ?? '';

  const draft = async () => {
    if (!checkIn) return;
    setBusy(true);
    setMessage(null);
    try {
      const d = await f.send<AiDraft>('POST', `/check-ins/${checkIn.id}/handover/ai-draft`, {
        language: locale,
      });
      setAi(d);
      setText(d.text);
    } catch (e) {
      setMessage(problem(e, t));
    } finally {
      setBusy(false);
    }
  };
  const checkOut = async () => {
    await f.checkOut();
    router.replace('/home');
  };
  const save = async () => {
    if (!checkIn) return;
    setBusy(true);
    setMessage(null);
    try {
      await f.send('POST', `/check-ins/${checkIn.id}/handover`, {
        language: locale,
        text: value,
        ...(ai ? { ai: { outputId: ai.outputId, changed: value !== ai.text } } : {}),
      });
      await checkOut();
    } catch (e) {
      setMessage(problem(e, t));
      setBusy(false);
    }
  };

  return (
    <Page title={t('handover.heading')}>
      <Body>{t('handover.intro')}</Body>
      {message ? <Alert tone="warn">{message}</Alert> : null}
      {query.error ? <Alert tone="warn">{problem(query.error, t)}</Alert> : null}
      {ai ? (
        <Alert>{t('handover.aiLabel', { provider: ai.provider, model: ai.model })}</Alert>
      ) : null}
      {query.data ? (
        <Field label={t('handover.text')} value={value} onChange={setText} multiline />
      ) : null}
      <View style={{ gap: 8 }}>
        {query.data ? (
          <Button
            kind="secondary"
            label={t('handover.ai')}
            disabled={busy}
            onPress={() => void draft()}
          />
        ) : null}
        {query.data ? (
          <Button
            label={t('handover.save')}
            disabled={busy || !value.trim()}
            onPress={() => void save()}
          />
        ) : null}
        <Button kind="secondary" label={t('handover.skip')} onPress={() => void checkOut()} />
      </View>
      <NavBar current="settings" />
    </Page>
  );
}

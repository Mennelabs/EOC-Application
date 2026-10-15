/**
 * Live translation (layer-7 task H; FL-14, FL:FR-24, EQ-08, AI-03, WCAG 2.2
 * AA). One turn at a time between the worker and the person, each way,
 * labelled as machine translation, shown large in the person's language with
 * its `lang`. Consent, legal and medical conversations never use machine
 * translation: the screen says so and offers the interpreter. "Bring in an
 * interpreter" is one tap from anywhere on the screen: it files an
 * interpreter request (kept on the phone until it is sent). Nothing said is
 * kept, on the phone or on the server.
 */
import { useState } from 'react';
import { Text, View } from 'react-native';
import { RadioGroup } from '../src/controls';
import { useField } from '../src/field';
import type { MessageKey } from '../src/i18n';
import { problem } from '../src/online';
import { Alert, Body, Button, Card, Field, NavBar, Page } from '../src/ui';

type Lang = 'en' | 'es';
type Topic = 'general' | 'consent' | 'legal' | 'medical';
interface Turn {
  text: string;
  to: Lang;
  provider: string;
  model: string;
}
/** The interpreter queue names languages in words (records.ts). */
const QUEUE_LANGUAGE: Record<Lang, string> = { en: 'english', es: 'spanish' };

export default function Translate() {
  const f = useField();
  const { t, theme, locale } = f;
  const mine: Lang = locale === 'es' ? 'es' : 'en';
  const [theirs, setTheirs] = useState<Lang>(mine === 'en' ? 'es' : 'en');
  const [topic, setTopic] = useState<Topic>('general');
  const [said, setSaid] = useState('');
  const [heard, setHeard] = useState('');
  const [turn, setTurn] = useState<Turn | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const translate = async (text: string, from: Lang, to: Lang) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await f.send<Turn>('POST', '/translations', { text, from, to, topic });
      setTurn({ ...r, to });
    } catch (e) {
      setTurn(null);
      setMessage({ tone: 'warn', text: problem(e, t) });
    } finally {
      setBusy(false);
    }
  };
  const interpreter = async () => {
    await f.saveRecord(
      'interpreter_request',
      { language: QUEUE_LANGUAGE[theirs], mode: 'phone', note: 'From live translation' },
      t('translate.interpreter'),
    );
    setMessage({ tone: 'info', text: t('translate.requested') });
  };

  return (
    <Page title={t('translate.heading')}>
      <Body>{t('translate.intro')}</Body>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {f.can('interpreter.request') ? (
        <Button
          kind="danger"
          label={t('translate.interpreter')}
          onPress={() => void interpreter()}
        />
      ) : null}
      <RadioGroup
        label={t('translate.their')}
        value={theirs}
        onChange={(v) => {
          setTheirs(v as Lang);
          setTurn(null);
        }}
        options={[
          { value: 'en', label: 'English' },
          { value: 'es', label: 'Español' },
        ]}
      />
      <RadioGroup
        label={t('translate.topic')}
        value={topic}
        onChange={(v) => {
          setTopic(v as Topic);
          setTurn(null);
        }}
        options={(['general', 'consent', 'legal', 'medical'] as const).map((k) => ({
          value: k,
          label: t(`translate.topic.${k}` as MessageKey),
        }))}
      />
      {topic !== 'general' ? (
        <Alert tone="warn">{t('translate.human')}</Alert>
      ) : theirs === mine ? null : (
        <>
          <Field label={t('translate.mine')} value={said} onChange={setSaid} multiline />
          <Button
            label={t('translate.forThem')}
            disabled={busy || !said.trim()}
            onPress={() => void translate(said, mine, theirs)}
          />
          <Field label={t('translate.theirs')} value={heard} onChange={setHeard} multiline />
          <Button
            kind="secondary"
            label={t('translate.forMe')}
            disabled={busy || !heard.trim()}
            onPress={() => void translate(heard, theirs, mine)}
          />
        </>
      )}
      {turn ? (
        <Card label={t('translate.label', { provider: turn.provider, model: turn.model })}>
          <Body muted>{t('translate.label', { provider: turn.provider, model: turn.model })}</Body>
          <View role="status" aria-live="polite">
            <Text
              // WCAG 3.1.2: the translation is marked with its language on the web build.
              {...({ lang: turn.to } as object)}
              style={{
                color: theme.text,
                fontSize: theme.font + 6,
                lineHeight: (theme.font + 6) * 1.4,
              }}
            >
              {turn.text}
            </Text>
          </View>
        </Card>
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}

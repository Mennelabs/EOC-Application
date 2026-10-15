/**
 * The conversation note-taker (layer-7 task H; FL-04, FL-05, FL-18,
 * FL:FR-16, AI-03, WCAG 2.2 AA).
 *
 * 1. Ask: the worker picks the kind of conversation (never counseling or
 *    spiritual care) and the person's language, then reads or shows the
 *    consent statement the server gives, in that language. "They said no"
 *    records nothing.
 * 2. Listening: recording runs only on this screen, with the listening sign
 *    and its timer showing the whole time; it stops when the worker taps
 *    "Stop", when the person says stop, or when the app leaves the screen
 *    (it never runs in the background).
 * 3. Check: the drafted note, labelled with the AI provider and model, each
 *    line editable with the words it rests on, lines that read like a promise
 *    or advice marked. Saving keeps only the note; the recording is deleted.
 *    Discarding keeps nothing. If the draft fails or AI is off, the worker
 *    writes the note in the same form.
 */
import { router } from 'expo-router';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import { RadioGroup } from '../src/controls';
import { useField } from '../src/field';
import type { MessageKey } from '../src/i18n';
import { problem, useOnline } from '../src/online';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

const SECTIONS = ['needsHeard', 'helpGiven', 'followUps', 'referrals'] as const;
type Section = (typeof SECTIONS)[number];
interface Line {
  text: string;
  quote: string | null;
  check: boolean;
}
type Note = Record<Section, Line[]>;
interface Session {
  id: string;
  version: number;
  state: string;
  draft: {
    needsHeard: { text: string; quote: string; check: string[] }[];
    helpGiven: { text: string; quote: string; check: string[] }[];
    followUps: { text: string; quote: string; check: string[] }[];
    referrals: { text: string; quote: string; check: string[] }[];
    dropped: number;
    injectionSuspected: boolean;
    provider: string;
    model: string;
  } | null;
}
type Step = 'ask' | 'listening' | 'working' | 'review' | 'done';

const emptyNote = (): Note => ({ needsHeard: [], helpGiven: [], followUps: [], referrals: [] });
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function Scribe() {
  const f = useField();
  const { t, theme } = f;
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [step, setStep] = useState<Step>('ask');
  const [context, setContext] = useState<'general' | 'legal_aid' | 'child'>('general');
  const [language, setLanguage] = useState<'en' | 'es'>('en');
  const [session, setSession] = useState<Session | null>(null);
  const [note, setNote] = useState<Note>(emptyNote());
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const listening = useRef(false);

  // The consent statement comes from the server, in the person's language (FL-18).
  const consentQuery = useOnline(`consent:${language}`, () =>
    f.online<{ text: string }>(`/scribe/consent?language=${language}`),
  );
  const consent = consentQuery.data?.text ?? null;

  // The timer beside the listening sign.
  useEffect(() => {
    if (step !== 'listening') return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [step]);

  const draftFrom = (s: Session) => {
    setSession(s);
    const d = s.draft;
    setNote(
      d
        ? (Object.fromEntries(
            SECTIONS.map((k) => [
              k,
              d[k].map((l) => ({ text: l.text, quote: l.quote, check: l.check.length > 0 })),
            ]),
          ) as Note)
        : emptyNote(),
    );
  };

  const draft = async (id: string) => {
    setStep('working');
    try {
      draftFrom(await f.send<Session>('POST', `/scribe/sessions/${id}/draft`));
      setMessage(null);
    } catch (e) {
      setMessage({ tone: 'warn', text: `${problem(e, t)} ${t('scribe.failed')}` });
    }
    setStep('review');
  };

  const stop = async (by: 'worker' | 'survivor') => {
    if (!listening.current || !session) return;
    listening.current = false;
    setStep('working');
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('no recording');
      const blob = await (await fetch(uri)).blob();
      const type =
        Platform.OS === 'web' ? (blob.type.split(';')[0] ?? '') || 'audio/webm' : 'audio/mp4';
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await f.sendBytes(`/scribe/sessions/${session.id}/audio?stoppedBy=${by}`, type, bytes);
      setSession({ ...session, state: 'recorded' });
      await draft(session.id);
    } catch (e) {
      setMessage({ tone: 'warn', text: `${problem(e, t)} ${t('scribe.failed')}` });
      setStep('review');
    }
  };

  // FL-18: never in the background. Leaving the app stops the recording.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && listening.current) void stop('worker');
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  // Leaving the screen stops it too; nothing is sent.
  useEffect(
    () => () => {
      if (listening.current) {
        listening.current = false;
        void recorder.stop().catch(() => undefined);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const begin = async (method: 'spoken' | 'tapped') => {
    setMessage(null);
    // The server's gates first (AI on, the organization's switch, the kind of conversation).
    let s: Session;
    try {
      s = await f.send<Session>('POST', '/scribe/sessions', {
        clientUuid: globalThis.crypto.randomUUID(),
        context,
        language,
        consent: { method, given: true },
      });
    } catch (e) {
      setMessage({ tone: 'warn', text: problem(e, t) });
      return;
    }
    const perm = await requestRecordingPermissionsAsync().catch(() => null);
    try {
      if (!perm?.granted) throw new Error('microphone');
      await setAudioModeAsync({ allowsRecording: true, shouldPlayInBackground: false });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setSession(s);
      listening.current = true;
      setSeconds(0);
      setStep('listening');
    } catch {
      setMessage({ tone: 'warn', text: t('scribe.micDenied') });
      await f.send('POST', `/scribe/sessions/${s.id}/discard`).catch(() => undefined);
    }
  };

  const save = async () => {
    if (!session) return;
    const body = Object.fromEntries(
      SECTIONS.map((k) => [k, note[k].map((l) => l.text.trim()).filter(Boolean)]),
    );
    try {
      // A note written by hand, when no recording or draft came, needs a fresh version.
      const current = await f.online<{ version: number }>(`/scribe/sessions/${session.id}`);
      await f.send('POST', `/scribe/sessions/${session.id}/confirm`, {
        version: current.version,
        note: body,
      });
      setMessage({ tone: 'info', text: t('scribe.saved') });
      setStep('done');
    } catch (e) {
      setMessage({ tone: 'warn', text: problem(e, t) });
    }
  };
  const discard = async () => {
    if (session)
      await f.send('POST', `/scribe/sessions/${session.id}/discard`).catch(() => undefined);
    setMessage({ tone: 'info', text: t('scribe.discarded') });
    setStep('done');
  };
  const reset = () => {
    setSession(null);
    setNote(emptyNote());
    setMessage(null);
    setStep('ask');
  };

  const setLine = (k: Section, i: number, text: string) =>
    setNote({ ...note, [k]: note[k].map((l, j) => (j === i ? { ...l, text } : l)) });
  const hasLines = SECTIONS.some((k) => note[k].some((l) => l.text.trim()));

  return (
    <Page title={t('scribe.heading')}>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {consentQuery.error && step === 'ask' ? (
        <Alert tone="warn">{problem(consentQuery.error, t)}</Alert>
      ) : null}

      {step === 'ask' ? (
        <>
          <Body>{t('scribe.intro')}</Body>
          <Alert tone="warn">{t('scribe.never')}</Alert>
          <RadioGroup
            label={t('scribe.context')}
            value={context}
            onChange={(v) => setContext(v as typeof context)}
            options={(['general', 'legal_aid', 'child'] as const).map((c) => ({
              value: c,
              label: t(`scribe.context.${c}` as MessageKey),
            }))}
          />
          <RadioGroup
            label={t('scribe.language')}
            value={language}
            onChange={(v) => setLanguage(v as typeof language)}
            options={[
              { value: 'en', label: 'English' },
              { value: 'es', label: 'Español' },
            ]}
          />
          <Card label={t('scribe.consentHeading')}>
            <Heading level={2}>{t('scribe.consentHeading')}</Heading>
            {consent ? (
              <Text
                // WCAG 3.1.2: the statement is in the person's language (react-native-web passes lang on).
                {...({ lang: language } as object)}
                style={{
                  color: theme.text,
                  fontSize: theme.font + 2,
                  lineHeight: (theme.font + 2) * 1.45,
                }}
              >
                {consent}
              </Text>
            ) : null}
          </Card>
          <View style={{ gap: 8 }}>
            <Button
              label={t('scribe.consentYesSpoken')}
              disabled={!consent}
              onPress={() => void begin('spoken')}
            />
            <Button
              kind="secondary"
              label={t('scribe.consentYesTapped')}
              disabled={!consent}
              onPress={() => void begin('tapped')}
            />
            <Button
              kind="secondary"
              label={t('scribe.consentNo')}
              onPress={() => setMessage({ tone: 'info', text: t('scribe.declined') })}
            />
          </View>
        </>
      ) : null}

      {step === 'listening' ? (
        <>
          {/* FL-18: the listening sign shows the whole time the phone records. */}
          <View
            role="status"
            aria-live="polite"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              padding: 16,
              borderRadius: 12,
              borderWidth: 3,
              borderColor: theme.danger,
              backgroundColor: theme.surface,
            }}
          >
            <View
              aria-hidden
              style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: theme.danger }}
            />
            <Text style={{ color: theme.text, fontSize: theme.font + 6, fontWeight: '700' }}>
              {t('scribe.listening', { time: clock(seconds) })}
            </Text>
          </View>
          <Body>{t('scribe.listeningHint')}</Body>
          <View style={{ gap: 8 }}>
            <Button label={t('scribe.stopDone')} onPress={() => void stop('worker')} />
            <Button
              kind="danger"
              label={t('scribe.stopSurvivor')}
              onPress={() => void stop('survivor')}
            />
          </View>
        </>
      ) : null}

      {step === 'working' ? <Body live>{t('scribe.sending')}</Body> : null}

      {step === 'review' ? (
        <>
          <Heading level={2}>{t('scribe.reviewHeading')}</Heading>
          {session?.draft ? (
            <Alert>
              {t('scribe.drafted', {
                provider: session.draft.provider,
                model: session.draft.model,
              })}
            </Alert>
          ) : null}
          {session?.draft?.injectionSuspected ? (
            <Alert tone="warn">{t('scribe.injection')}</Alert>
          ) : null}
          {session?.draft?.dropped ? (
            <Body muted>{t('scribe.dropped', { count: session.draft.dropped })}</Body>
          ) : null}
          {SECTIONS.map((k) => {
            const name = t(`scribe.section.${k}` as MessageKey);
            return (
              <Card key={k} label={name}>
                <Heading level={3}>{name}</Heading>
                {note[k].map((l, i) => (
                  <View key={i} style={{ gap: 4 }}>
                    <Field
                      label={t('scribe.line', { section: name, n: i + 1 })}
                      value={l.text}
                      onChange={(v) => setLine(k, i, v)}
                      multiline
                    />
                    {l.quote ? <Body muted>{t('scribe.said', { quote: l.quote })}</Body> : null}
                    {l.check ? <Alert tone="warn">{t('scribe.check')}</Alert> : null}
                    <Button
                      kind="secondary"
                      label={t('scribe.remove', { n: i + 1 })}
                      onPress={() => setNote({ ...note, [k]: note[k].filter((_, j) => j !== i) })}
                    />
                  </View>
                ))}
                <Button
                  kind="secondary"
                  label={t('scribe.add', { section: name })}
                  onPress={() =>
                    setNote({ ...note, [k]: [...note[k], { text: '', quote: null, check: false }] })
                  }
                />
              </Card>
            );
          })}
          <View style={{ gap: 8 }}>
            {session && session.state === 'recorded' ? (
              <Button
                kind="secondary"
                label={t('scribe.retry')}
                onPress={() => void draft(session.id)}
              />
            ) : null}
            <Button label={t('scribe.save')} disabled={!hasLines} onPress={() => void save()} />
            <Button kind="danger" label={t('scribe.discard')} onPress={() => void discard()} />
          </View>
        </>
      ) : null}

      {step === 'done' ? (
        <View style={{ gap: 8 }}>
          <Button label={t('scribe.another')} onPress={reset} />
          <Button kind="secondary" label={t('nav.home')} onPress={() => router.replace('/home')} />
        </View>
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}

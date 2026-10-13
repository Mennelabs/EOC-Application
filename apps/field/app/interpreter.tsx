/**
 * The interpreter queue (FL:FR-24): open requests by language, accept one,
 * start, and finish with the minutes; the language support is logged. The
 * queue needs signal; each step is kept on the phone until it is sent.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { Stepper } from '../src/controls';
import { useField } from '../src/field';
import { problem, useOnline } from '../src/online';
import { Alert, Body, Button, Card, Heading, NavBar, Page } from '../src/ui';

interface Req {
  id: string;
  language: string;
  mode: string;
  state: string;
  requestedAt: string;
  note: string | null;
  interpreterPersonnelId: string | null;
}

export default function Interpreter() {
  const f = useField();
  const { t } = f;
  const [message, setMessage] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  const query = useOnline('queue', async () => {
    const [open, accepted, going] = await Promise.all([
      f.online<Req[]>('/field-records/interpreter_request?state=open'),
      f.online<Req[]>('/field-records/interpreter_request?state=accepted'),
      f.online<Req[]>('/field-records/interpreter_request?state=in_progress'),
    ]);
    return [...going, ...accepted, ...open];
  });
  const list = query.data;
  const load = query.reload;
  const step = async (id: string, state: string, extra: Record<string, unknown> = {}) => {
    await f.recordStep('interpreter_request.respond', id, { state, ...extra });
    setMessage(t('records.stepSaved'));
    setTimeout(() => void load(), 1500);
  };
  return (
    <Page title={t('interp.heading')}>
      {message ? <Alert>{message}</Alert> : null}
      {query.error ? <Alert tone="warn">{problem(query.error, t)}</Alert> : null}
      {list === null ? <Body muted>{t('records.needsSignal')}</Body> : null}
      {list?.length === 0 ? <Body muted>{t('interp.none')}</Body> : null}
      {list?.map((r) => (
        <Card key={r.id} label={r.language}>
          <Heading level={3}>{`${r.language} · ${t(`interp.mode.${r.mode}` as never)}`}</Heading>
          <Body muted>{t(`interp.state.${r.state}` as never)}</Body>
          {r.note ? <Body>{r.note}</Body> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {r.state === 'open' ? (
              <Button label={t('interp.accept')} onPress={() => void step(r.id, 'accepted')} />
            ) : null}
            {r.state === 'accepted' ? (
              <Button
                kind="secondary"
                label={t('interp.start')}
                onPress={() => void step(r.id, 'in_progress')}
              />
            ) : null}
          </View>
          {r.state === 'accepted' || r.state === 'in_progress' ? (
            <View style={{ gap: 6 }}>
              <Stepper
                label={t('interp.minutes')}
                min={0}
                max={600}
                value={minutes[r.id] ?? 15}
                onChange={(v) => setMinutes({ ...minutes, [r.id]: v })}
              />
              <Button
                label={t('interp.done')}
                onPress={() => void step(r.id, 'done', { minutes: minutes[r.id] ?? 15 })}
              />
            </View>
          ) : null}
        </Card>
      ))}
      <NavBar current="home" />
    </Page>
  );
}

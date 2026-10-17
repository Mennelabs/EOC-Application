/**
 * Ask or command (layer-7 task C; FL-07, CMD-01, CMD-20–CMD-28, CMD-33,
 * CMD-34, Section 30.2): the console's command window on the phone. The
 * volunteer says it with the keyboard's microphone or types it, in plain
 * words or shorthand; the server answers with a plan and nothing changes
 * until it is confirmed on this screen. It needs a connection: a command is
 * never kept on the phone or sent later by itself, and no history is kept on
 * a phone that may be shared. Opened from a job, "this" means that job's
 * mission (CMD-06): it is said on screen and read again by the server under
 * the person's own permissions.
 */
import { useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { ApiError, OfflineError } from '../src/api';
import { useField } from '../src/field';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

interface Execution {
  id: string | null;
  status: string;
  message: string;
  plan: { description: string; interpretation: string | null } | null;
  planHash: string | null;
  options: { kind: string; id: string; label: string }[];
  undoUntil: string | null;
  commands: { name: string; title: string; usage: string; enabled: boolean; allowed: boolean }[];
}

export default function Command() {
  const f = useField();
  const { t } = f;
  const job = useLocalSearchParams<{ missionId?: string; missionRef?: string }>();
  const context = job.missionId ? { kind: 'mission', id: job.missionId } : null;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<Execution | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (step: () => Promise<Execution>) => {
    setBusy(true);
    setProblem(null);
    try {
      setCurrent(await step());
    } catch (err) {
      if (err instanceof OfflineError) setProblem(t('command.offline'));
      else if (err instanceof ApiError) setProblem(t('command.failed', { message: err.message }));
      else throw err;
    } finally {
      setBusy(false);
    }
  };

  // Answers to "which one?" for this line add up: a mission, then a person.
  const chosen = useRef<Record<string, string>>({});
  const prepare = (extra: Record<string, string> | null = null) => {
    chosen.current = extra ? { ...chosen.current, ...extra } : {};
    return run(() =>
      f.send<Execution>('POST', '/commands', {
        executionId: globalThis.crypto.randomUUID(),
        input: text.trim(),
        remember: false,
        ...chosen.current,
        ...(context ? { context } : {}),
      }),
    );
  };
  const act = (path: string, body: Record<string, unknown> = {}) =>
    run(() => f.send<Execution>('POST', path, body));

  return (
    <Page title={t('command.heading')}>
      <Card label={t('command.heading')}>
        <Body>{t('command.hint')}</Body>
        {context ? <Body>{t('command.thisMeans', { ref: job.missionRef ?? '' })}</Body> : null}
        <Field label={t('command.label')} value={text} onChange={setText} multiline />
        <Button
          label={busy ? t('command.working') : t('command.go')}
          disabled={busy || !text.trim()}
          onPress={() => void prepare()}
        />
      </Card>

      {problem ? <Alert tone="warn">{problem}</Alert> : null}

      {current ? (
        <Card label={t('command.result')}>
          {current.status === 'awaiting_confirmation' && current.plan ? (
            <>
              <Heading level={2}>{t('command.plan')}</Heading>
              <Body>{current.plan.description}</Body>
              {current.plan.interpretation ? (
                <Body muted>{t('command.readAs', { line: current.plan.interpretation })}</Body>
              ) : null}
              <View style={{ gap: 8 }}>
                <Button
                  label={t('command.confirm')}
                  disabled={busy}
                  onPress={() =>
                    void act(`/commands/${current.id}/confirm`, { planHash: current.planHash })
                  }
                />
                <Button
                  kind="secondary"
                  label={t('command.cancel')}
                  disabled={busy}
                  onPress={() => void act(`/commands/${current.id}/cancel`)}
                />
              </View>
            </>
          ) : (
            <Body>{current.message}</Body>
          )}
          {current.status === 'clarify' && current.options.length > 0 ? (
            <>
              <Heading level={3}>{t('command.which')}</Heading>
              {current.options.map((o) => (
                <Button
                  key={o.id}
                  kind="secondary"
                  label={o.label}
                  disabled={busy}
                  onPress={() =>
                    void prepare(
                      o.kind === 'event'
                        ? { eventId: o.id }
                        : o.kind === 'personnel'
                          ? { personId: o.id }
                          : { targetId: o.id },
                    )
                  }
                />
              ))}
            </>
          ) : null}
          {current.status === 'help'
            ? current.commands
                .filter((c) => c.enabled && c.allowed)
                .map((c) => (
                  <Body key={c.name}>
                    {c.usage} — {c.title}
                  </Body>
                ))
            : null}
          {current.status === 'succeeded' && current.undoUntil ? (
            <Button
              kind="secondary"
              label={t('command.undo')}
              disabled={busy}
              onPress={() =>
                void act(`/commands/${current.id}/undo`, {
                  executionId: globalThis.crypto.randomUUID(),
                })
              }
            />
          ) : null}
        </Card>
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}

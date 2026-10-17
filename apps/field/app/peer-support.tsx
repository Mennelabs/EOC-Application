/**
 * Peer support (FL-16): a private way to ask a peer supporter to reach you.
 * Only how and when are sent, no words; only the peer support team sees the
 * request, never the worker's lead, dispatch or coordinators. It is saved on
 * the phone and sent like any other record when there is signal. With signal
 * the screen shows where the request stands and lets the worker withdraw it.
 * The 988 line is always on the screen for someone in crisis now.
 */
import { useState } from 'react';
import { RadioGroup } from '../src/controls';
import { useField } from '../src/field';
import { problem, useOnline } from '../src/online';
import { Alert, Body, Button, Card, Heading, NavBar, Page } from '../src/ui';

type ReachBy = 'call' | 'text' | 'in_person';
type ReachWhen = 'now' | 'after_shift';
interface Mine {
  id: string;
  version: number;
  status: 'open' | 'contacted' | 'closed';
}

export default function PeerSupport() {
  const f = useField();
  const { t } = f;
  const [reachBy, setReachBy] = useState<ReachBy | null>(null);
  const [reachWhen, setReachWhen] = useState<ReachWhen | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const mine = useOnline('peer-support:mine', () => f.online<Mine[]>('/peer-support/mine'));
  const open = mine.data?.[0] ?? null;

  const ask = async () => {
    if (!reachBy || !reachWhen) return;
    try {
      await f.askPeerSupport(reachBy, reachWhen);
      setMessage({ tone: 'info', text: t('peer.sent') });
      setReachBy(null);
      setReachWhen(null);
      mine.reload();
    } catch (err) {
      setMessage({ tone: 'warn', text: problem(err, t) });
    }
  };
  const withdraw = async () => {
    if (!open) return;
    try {
      await f.send(
        'POST',
        `/peer-support/${open.id}/withdraw`,
        {},
        {
          'if-match': `"${open.version}"`,
        },
      );
      setMessage({ tone: 'info', text: t('peer.withdrawn') });
      mine.reload();
    } catch (err) {
      setMessage({ tone: 'warn', text: problem(err, t) });
    }
  };

  return (
    <Page title={t('peer.heading')}>
      <Body>{t('peer.body')}</Body>
      <Alert tone="info">{t('peer.crisis')}</Alert>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {open ? (
        <Card label={t('peer.heading')}>
          <Body live>
            {open.status === 'contacted' ? t('peer.status.contacted') : t('peer.status.open')}
          </Body>
          <Button kind="secondary" label={t('peer.withdraw')} onPress={() => void withdraw()} />
        </Card>
      ) : (
        <Card label={t('peer.open')}>
          <Heading level={2}>{t('peer.open')}</Heading>
          <RadioGroup
            label={t('peer.reachBy')}
            options={(['call', 'text', 'in_person'] as const).map((v) => ({
              value: v,
              label: t(`peer.reachBy.${v}`),
            }))}
            value={reachBy}
            onChange={(v) => setReachBy(v as ReachBy)}
          />
          <RadioGroup
            label={t('peer.reachWhen')}
            options={(['now', 'after_shift'] as const).map((v) => ({
              value: v,
              label: t(`peer.reachWhen.${v}`),
            }))}
            value={reachWhen}
            onChange={(v) => setReachWhen(v as ReachWhen)}
          />
          <Button
            label={t('peer.send')}
            disabled={!reachBy || !reachWhen}
            onPress={() => void ask()}
          />
        </Card>
      )}
      <NavBar current="home" />
    </Page>
  );
}

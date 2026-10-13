/** Messages from dispatch (DSP-06): newest first, each with "Got it"; the receipt is saved on the phone and sent with the next sync. */
import { View } from 'react-native';
import { useField } from '../src/field';
import { clock } from '../src/format';
import { Body, Button, Card, NavBar, Page, SyncBadge } from '../src/ui';

export default function Messages() {
  const { t, locale, messages, acknowledgeMessage } = useField();
  return (
    <Page title={t('messages.heading')}>
      {messages.length === 0 ? <Body muted>{t('home.noMessages')}</Body> : null}
      {messages.map((m) => (
        <Card key={m.id} label={t('messages.from', { time: clock(m.sentAt, locale) })}>
          <Body muted>{t('messages.from', { time: clock(m.sentAt, locale) })}</Body>
          <Body>{m.body}</Body>
          <View style={{ gap: 6 }}>
            {m.receipt?.acknowledgedAt ? (
              <>
                <Body>✓ {t('messages.acked')}</Body>
                <SyncBadge state={m.syncState} />
              </>
            ) : (
              <Button label={t('messages.ack')} onPress={() => void acknowledgeMessage(m.id)} />
            )}
          </View>
        </Card>
      ))}
      <NavBar current="messages" />
    </Page>
  );
}

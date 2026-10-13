/**
 * On this phone (FLD-13, AC-00B): every command with "On this phone",
 * "Sending", "Received", "Needs a decision" or "Not accepted"; the last
 * sync; "Sync now". A conflict keeps the volunteer's entry; removing it is a
 * deliberate choice.
 */
import { View } from 'react-native';
import { useField } from '../src/field';
import { clock } from '../src/format';
import { label } from '../src/vocab';
import { Alert, Body, Button, Card, NavBar, Page, SyncBadge } from '../src/ui';

export default function SyncScreen() {
  const { t, locale, outbox, sync, syncNow, discard } = useField();
  const visible = outbox
    .filter((c) => c.status !== 'received')
    .concat(outbox.filter((c) => c.status === 'received').slice(-5));
  return (
    <Page
      title={t('sync.heading')}
      actions={<Button label={t('sync.now')} onPress={() => void syncNow()} />}
    >
      <Body live>
        {sync.lastSyncAt
          ? t('sync.lastSync', { time: clock(sync.lastSyncAt, locale) })
          : t('sync.never')}
      </Body>
      {sync.phase === 'offline' ? <Alert tone="warn">{t('sync.offline')}</Alert> : null}
      {visible.length === 0 ? <Body muted>{t('sync.empty')}</Body> : null}
      {visible.map((c) => (
        <Card key={c.id}>
          <Body>{label(locale, 'commandKinds', c.kind)}</Body>
          <Body muted>{clock(c.clientAt, locale)}</Body>
          <SyncBadge state={c.status} />
          {c.status === 'conflict' || c.status === 'rejected' ? (
            <View style={{ gap: 6 }}>
              {c.status === 'conflict' ? <Body>{t('sync.conflictBody')}</Body> : null}
              {c.lastError ? <Body muted>{c.lastError}</Body> : null}
              <Button
                kind="secondary"
                label={t('sync.discard')}
                onPress={() => void discard(c.id)}
              />
            </View>
          ) : null}
        </Card>
      ))}
      <NavBar current="sync" />
    </Page>
  );
}

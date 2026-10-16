/**
 * On this phone (FLD-13, AC-00B): every command with "On this phone",
 * "Sending", "Received", "Needs a decision" or "Not accepted"; the last
 * sync; "Sync now". A conflict keeps the volunteer's entry; removing it is a
 * deliberate choice. The map packages of the volunteer's areas, with their
 * size (FLD-13).
 */
import { View } from 'react-native';
import { useField } from '../src/field';
import { clock } from '../src/format';
import { label } from '../src/vocab';
import { Alert, Body, Button, Card, Heading, NavBar, Page, SyncBadge } from '../src/ui';

const size = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function SyncScreen() {
  const { t, locale, outbox, sync, syncNow, discard, maps, mapState } = useField();
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
      {/* FLD-13: the map packages of the volunteer's areas. */}
      <Card label={t('maps.heading')}>
        <Heading level={2}>{t('maps.heading')}</Heading>
        {maps.map((m) => (
          <Body key={m.areaKey}>{t('maps.item', { area: m.areaKey, size: size(m.bytes) })}</Body>
        ))}
        {mapState === 'downloading' ? <Body live>{t('maps.downloading')}</Body> : null}
        {mapState === 'failed' ? <Alert tone="warn">{t('maps.failed')}</Alert> : null}
        {maps.length === 0 && mapState !== 'downloading' ? (
          <Body muted>{t('maps.none')}</Body>
        ) : null}
      </Card>
      <NavBar current="sync" />
    </Page>
  );
}

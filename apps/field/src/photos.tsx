/**
 * Photo-first capture on a field screen (FLD-07, FLD-11, FLD-12): take or
 * choose photos before saving; they are kept encrypted on the phone and
 * attached to the record when the screen saves (field.tsx tags them with
 * the record's command). Each photo shows whether it is still on the phone
 * or received, and can be removed until it leaves. Thumbnails carry a text
 * alternative (WCAG 1.1.1); the remove buttons say which photo.
 */
import { useState } from 'react';
import { Image, View } from 'react-native';
import { useField } from './field';
import { Alert, Body, Button, Heading } from './ui';

export function PhotoStrip({
  ids,
  onChange,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const f = useField();
  const { t, theme } = f;
  const [denied, setDenied] = useState(false);
  const docs = ids
    .map((id) => f.photos.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p);
  const add = async (fromLibrary: boolean) => {
    const r = await f.takePhoto(fromLibrary);
    if (r === 'denied') {
      setDenied(true);
      return;
    }
    setDenied(false);
    if (r) onChange([...ids, r.id]);
  };
  return (
    <View style={{ gap: 8 }}>
      <Heading level={3}>{t('photos.heading')}</Heading>
      <Body muted>{t('photos.hint')}</Body>
      {denied ? <Alert tone="warn">{t('photos.denied')}</Alert> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {docs.map((p, i) => (
          <View key={p.id} style={{ gap: 4, alignItems: 'center' }}>
            {p.data ? (
              <Image
                source={{ uri: `data:${p.contentType};base64,${p.data}` }}
                alt={t('photos.alt', { n: i + 1 })}
                accessibilityLabel={t('photos.alt', { n: i + 1 })}
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 8,
                  borderWidth: 2,
                  borderColor: theme.border,
                }}
              />
            ) : null}
            <Body muted>
              {p.stage === 'received'
                ? t('photos.sent')
                : p.stage === 'failed'
                  ? t('photos.failed')
                  : t('photos.waiting')}
            </Body>
            {p.stage === 'on_this_phone' || p.stage === 'failed' ? (
              <Button
                kind="secondary"
                label={t('photos.remove', { n: i + 1 })}
                onPress={() =>
                  void f.removePhoto(p.id).then((ok) => {
                    if (ok) onChange(ids.filter((x) => x !== p.id));
                  })
                }
              />
            ) : null}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button kind="secondary" label={t('photos.take')} onPress={() => void add(false)} />
        <Button kind="secondary" label={t('photos.pick')} onPress={() => void add(true)} />
      </View>
    </View>
  );
}

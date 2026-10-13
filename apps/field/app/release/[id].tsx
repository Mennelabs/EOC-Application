/**
 * The release after the work (FL:FR-19): the resident signs again on this
 * phone. It needs signal, because the server keeps the signature encrypted
 * beside the right of entry it closes.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useField } from '../../src/field';
import { SignaturePad } from '../../src/signature';
import { Alert, Body, Button, NavBar, Page } from '../../src/ui';
import { problem } from '../../src/online';

export default function Release() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const f = useField();
  const { t } = f;
  const [sig, setSig] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'done' | string>('idle');
  const send = async () => {
    try {
      await f.send('POST', `/field-records/right_of_entry/${id}/release`, { signatureSvg: sig });
      setState('done');
    } catch (err) {
      setState(problem(err, t));
    }
  };
  return (
    <Page
      title={t('release.heading')}
      actions={<Button label={t('release.send')} disabled={!sig} onPress={() => void send()} />}
    >
      <Body>{t('release.body')}</Body>
      {state === 'done' ? <Alert>{t('release.done')}</Alert> : null}
      {state !== 'idle' && state !== 'done' ? <Alert tone="warn">{state}</Alert> : null}
      <SignaturePad label={t('release.sign')} onChange={setSig} />
      {state === 'done' ? (
        <Button kind="secondary" label={t('nav.home')} onPress={() => router.replace('/home')} />
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}

/**
 * Help alert (FLD-16, DSP-07, plan §12.1): a second, explicit tap sends the
 * alert with the exact position and team, whatever the precision setting;
 * with no signal it is saved on the phone and sent the moment one appears.
 * CON-10: the screen also says to call 911 when someone is in danger.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { useField } from '../src/field';
import { Alert, Body, Button, Page } from '../src/ui';

export default function Help() {
  const { t, raiseHelp } = useField();
  const [state, setState] = useState<'confirm' | 'sending' | 'queued' | 'sent'>('confirm');
  return (
    <Page
      title={t('help.confirmHeading')}
      showHelp={false}
      actions={
        state === 'confirm' ? (
          <>
            <Button
              kind="danger"
              label={t('help.send')}
              onPress={() => {
                setState('sending');
                void raiseHelp().then(setState);
              }}
            />
            <Button kind="secondary" label={t('help.cancel')} onPress={() => router.back()} />
          </>
        ) : (
          <Button
            kind="secondary"
            label={t('common.back')}
            onPress={() => router.replace('/home')}
          />
        )
      }
    >
      <Alert tone="danger">{t('emergency.call911')}</Alert>
      {state === 'confirm' ? <Body>{t('help.confirmBody')}</Body> : null}
      {state === 'queued' ? <Body live>{t('help.queued')}</Body> : null}
      {state === 'sent' ? <Body live>{t('help.sent')}</Body> : null}
    </Page>
  );
}

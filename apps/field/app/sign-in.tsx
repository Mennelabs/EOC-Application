/** Sign-in (SEC-07): the organization code picks the county's realm; the realm's own page asks for the password and passkey. */
import { useState } from 'react';
import { useField } from '../src/field';
import { rememberedRealm } from '../src/auth';
import { Alert, Body, Button, Field, Page } from '../src/ui';

export default function SignIn() {
  const { t, config, signIn, phase, notice } = useField();
  const [realm, setRealm] = useState(rememberedRealm() ?? config?.tenant ?? '');
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  return (
    <Page
      title={t('signin.heading')}
      actions={
        <Button
          label={state === 'working' ? t('signin.working') : t('signin.button')}
          disabled={!realm.trim() || state === 'working'}
          onPress={() => {
            setState('working');
            signIn(realm).catch(() => setState('error'));
          }}
        />
      }
    >
      <Body>{t('app.subtitle', { county: config?.countyName ?? '' })}</Body>
      {phase === 'wiped' ? <Alert tone="warn">{t('wiped.body')}</Alert> : null}
      {notice ? <Alert tone="warn">{notice}</Alert> : null}
      <Field
        label={t('signin.org.label')}
        hint={t('signin.org.hint')}
        value={realm}
        onChange={setRealm}
        autoComplete="organization"
      />
      {state === 'error' ? <Alert tone="danger">{t('signin.error')}</Alert> : null}
      <Body muted>{t('emergency.call911')}</Body>
    </Page>
  );
}

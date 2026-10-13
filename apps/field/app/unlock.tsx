/**
 * Unlock (FLD-02): first use chooses a PIN of at least six digits; later the
 * PIN (or fingerprint or face on the phone) opens the encrypted store. Ten
 * wrong PINs clear the app's data on this phone.
 */
import { useEffect, useState } from 'react';
import { useField } from '../src/field';
import { Alert, Body, Button, Field, Page } from '../src/ui';

export default function Unlock() {
  const { t, phase, createPin, unlock, unlockWithBiometrics, biometrics } = useField();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [bio, setBio] = useState(false);
  const setting = phase === 'set_pin';
  useEffect(() => {
    if (!setting) void biometrics().then(setBio);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mode
  }, [setting]);
  const submit = async () => {
    setError(null);
    if (!/^\d{6,}$/.test(pin)) return setError(t('unlock.short'));
    if (setting) {
      if (pin !== again) return setError(t('unlock.mismatch'));
      await createPin(pin);
      return;
    }
    const r = await unlock(pin);
    if (!r.ok && r.triesLeft !== undefined && r.triesLeft > 0)
      setError(t('unlock.wrong', { left: r.triesLeft }));
    setPin('');
  };
  return (
    <Page
      title={setting ? t('unlock.setHeading') : t('unlock.heading')}
      showHelp={false}
      actions={
        <>
          <Button
            label={setting ? t('unlock.setButton') : t('unlock.button')}
            onPress={() => void submit()}
          />
          {bio ? (
            <Button
              kind="secondary"
              label={t('unlock.biometric')}
              onPress={() => void unlockWithBiometrics()}
            />
          ) : null}
        </>
      }
    >
      {setting ? <Body>{t('unlock.setBody')}</Body> : null}
      <Field
        label={t('unlock.pin')}
        value={pin}
        onChange={setPin}
        secure
        numeric
        autoComplete={setting ? 'new-password' : 'current-password'}
      />
      {setting ? (
        <Field
          label={t('unlock.pinAgain')}
          value={again}
          onChange={setAgain}
          secure
          numeric
          autoComplete="new-password"
        />
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Page>
  );
}

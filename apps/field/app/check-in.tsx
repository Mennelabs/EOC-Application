/**
 * Check-in (FLD-03, DSP-08): the event code from staging (the QR code
 * carries the same code; the camera scan is in the phone build). Location is
 * shared with dispatch only while checked in, and only if the volunteer
 * leaves the box on. After check-in the area package downloads ("Your area
 * is ready offline", FLD-13).
 */
import { useState } from 'react';
import { useField } from '../src/field';
import { Alert, Body, Button, Field, NavBar, Page, Toggle } from '../src/ui';

export default function CheckInScreen() {
  const { t, checkInWithCode, downloadArea } = useField();
  const [code, setCode] = useState('');
  const [share, setShare] = useState(true);
  const [state, setState] = useState<'idle' | 'working'>('idle');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setState('working');
    setError(null);
    const err = await checkInWithCode(code, share);
    setState('idle');
    if (err) setError(err);
    else void downloadArea();
  };
  return (
    <Page
      title={t('checkin.heading')}
      actions={
        <Button
          label={state === 'working' ? t('checkin.working') : t('checkin.button')}
          disabled={code.trim().length < 3 || state === 'working'}
          onPress={() => void submit()}
        />
      }
    >
      <Body>{t('checkin.body')}</Body>
      <Field
        label={t('checkin.code')}
        value={code}
        onChange={(v) => setCode(v.toUpperCase())}
        autoComplete="off"
      />
      <Toggle label={t('checkin.share')} value={share} onChange={setShare} />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <NavBar current="home" />
    </Page>
  );
}

/** Returns from the realm's sign-in page (web build): exchanges the code, then the guard moves on to the PIN. */
import { useEffect, useState } from 'react';
import { useField } from '../src/field';
import { Alert, Body, Page } from '../src/ui';

export default function Callback() {
  const { t, completeSignIn } = useField();
  const [error, setError] = useState(false);
  useEffect(() => {
    completeSignIn().catch(() => setError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);
  return (
    <Page title={t('signin.heading')} showHelp={false}>
      {error ? (
        <Alert tone="danger">{t('signin.error')}</Alert>
      ) : (
        <Body live>{t('callback.working')}</Body>
      )}
    </Page>
  );
}

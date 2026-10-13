/**
 * Root layout: the field state provider and the route guard. Signed out →
 * sign-in; signed in but locked → unlock (or choose a PIN); unlocked and not
 * checked in → check-in (settings, "on this phone" and help stay open);
 * after a remote wipe → sign-in with the notice (FLD-02).
 */
import { Slot, router, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { FieldProvider, useField } from '../src/field';

const OPEN_WHEN_NOT_CHECKED_IN = ['/check-in', '/settings', '/sync', '/need-help'];

function Guard() {
  const { phase, checkIn, theme } = useField();
  const path = usePathname();
  useEffect(() => {
    if (phase === 'loading') return;
    const go = (to: string) => {
      if (path !== to) router.replace(to);
    };
    if (phase === 'signed_out' || phase === 'wiped') {
      if (path !== '/callback') go('/sign-in');
      return;
    }
    if (phase === 'locked' || phase === 'set_pin') return go('/unlock');
    if (!checkIn) {
      if (!OPEN_WHEN_NOT_CHECKED_IN.includes(path)) go('/check-in');
      return;
    }
    if (['/', '/sign-in', '/unlock', '/callback', '/check-in'].includes(path)) go('/home');
  }, [phase, checkIn, path]);
  if (phase === 'loading')
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.bg,
        }}
      >
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  return <Slot />;
}

export default function Root() {
  return (
    <FieldProvider>
      <Guard />
    </FieldProvider>
  );
}

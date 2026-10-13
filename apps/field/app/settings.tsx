/**
 * Settings (FLD-15, EQ-06, DSP-08, FLD-14): language, high contrast, large
 * targets, one-handed layout, battery saver, location sharing, check-out
 * (clears resident details from the phone) and sign-out.
 */
import { View } from 'react-native';
import { useField } from '../src/field';
import { localeNames, locales } from '../src/i18n';
import { Body, Button, Card, Heading, NavBar, Page, Toggle } from '../src/ui';

export default function Settings() {
  const f = useField();
  const { t, settings, locale, checkIn, policy } = f;
  return (
    <Page title={t('settings.heading')}>
      <Card label={t('settings.language')}>
        <Heading level={2}>{t('settings.language')}</Heading>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {locales.map((l) => (
            <Button
              key={l}
              kind={l === locale ? 'primary' : 'secondary'}
              label={localeNames[l]}
              onPress={() => void f.setLocale(l)}
            />
          ))}
        </View>
      </Card>
      <Card>
        <Toggle
          label={t('settings.contrast')}
          value={settings.highContrast}
          onChange={(v) => void f.updateSettings({ highContrast: v })}
        />
        <Toggle
          label={t('settings.large')}
          value={settings.largeTargets}
          onChange={(v) => void f.updateSettings({ largeTargets: v })}
        />
        <Toggle
          label={t('settings.oneHanded')}
          value={settings.oneHanded}
          onChange={(v) => void f.updateSettings({ oneHanded: v })}
        />
        <Toggle
          label={t('settings.battery')}
          value={settings.batterySaver}
          onChange={(v) => void f.updateSettings({ batterySaver: v })}
        />
        {checkIn ? (
          <Toggle
            label={t('settings.location')}
            value={checkIn.locationSharing}
            onChange={(v) => void f.setSharing(v)}
          />
        ) : null}
        <Body muted>{t('settings.policy', { reason: policy.reason.replace(/_/g, ' ') })}</Body>
      </Card>
      {checkIn ? (
        <Card label={t('settings.checkout')}>
          <Body>{t('settings.checkoutBody')}</Body>
          <Button
            kind="secondary"
            label={t('settings.checkout')}
            onPress={() => void f.checkOut()}
          />
        </Card>
      ) : null}
      <Button kind="secondary" label={t('settings.signout')} onPress={() => void f.signOut()} />
      <NavBar current="settings" />
    </Page>
  );
}

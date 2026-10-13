/**
 * Field UI primitives (FLD-15, WCAG 2.2 AA, ACC-07): every control has a role,
 * a name and a visible focus; targets are at least 48 px (64 px with "large
 * buttons for gloves", WCAG 2.5.8 exceeded); status is never colour alone;
 * text scales with the setting. The help bar is on every signed-in screen
 * (FLD-16) and the one-handed layout keeps the main actions at the bottom.
 */
import { Fragment, useId, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { router } from 'expo-router';
import Head from 'expo-router/head';
import { useField } from './field';

export function Page({
  title,
  children,
  actions,
  showHelp = true,
}: {
  title: string;
  children: ReactNode;
  /** Main actions: at the bottom in the one-handed layout, after the content otherwise. */
  actions?: ReactNode;
  showHelp?: boolean;
}) {
  const { theme, t, config, phase } = useField();
  return (
    <View style={[styles.fill, { backgroundColor: theme.bg }]}>
      <Head>
        <title>{`${title} — ${t('app.title')}${config?.countyName ? ` — ${config.countyName}` : ''}`}</title>
      </Head>
      <ScrollView
        contentContainerStyle={[styles.content, { gap: theme.gap }]}
        role="main"
        keyboardShouldPersistTaps="handled"
      >
        <Heading level={1}>{title}</Heading>
        {children}
        {!theme.oneHanded && actions ? <View style={{ gap: theme.gap }}>{actions}</View> : null}
      </ScrollView>
      {theme.oneHanded && actions ? (
        <View
          style={[
            styles.bottom,
            { gap: theme.gap, borderColor: theme.border, backgroundColor: theme.surface },
          ]}
        >
          {actions}
        </View>
      ) : null}
      {showHelp && phase === 'ready' ? <HelpBar /> : null}
    </View>
  );
}

export function Heading({ level, children }: { level: 1 | 2 | 3; children: ReactNode }) {
  const { theme } = useField();
  const size = level === 1 ? theme.font + 9 : level === 2 ? theme.font + 4 : theme.font + 1;
  return (
    <Text
      role="heading"
      aria-level={level}
      style={{ color: theme.text, fontSize: size, fontWeight: '700' }}
    >
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted,
  live,
}: {
  children: ReactNode;
  muted?: boolean;
  live?: boolean;
}) {
  const { theme } = useField();
  return (
    <Text
      style={{
        color: muted ? theme.muted : theme.text,
        fontSize: theme.font,
        lineHeight: theme.font * 1.4,
      }}
      {...(live ? { role: 'status' as const, 'aria-live': 'polite' as const } : {})}
    >
      {children}
    </Text>
  );
}

export function Alert({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warn' | 'danger';
}) {
  const { theme } = useField();
  const color = tone === 'danger' ? theme.danger : tone === 'warn' ? theme.warn : theme.primary;
  return (
    <View
      role={tone === 'info' ? 'status' : 'alert'}
      style={[
        styles.card,
        { borderColor: color, borderLeftWidth: 6, backgroundColor: theme.surface },
      ]}
    >
      <Text style={{ color: theme.text, fontSize: theme.font, lineHeight: theme.font * 1.4 }}>
        {children}
      </Text>
    </View>
  );
}

export function Card({ children, label }: { children: ReactNode; label?: string }) {
  const { theme } = useField();
  return (
    <View
      style={[
        styles.card,
        { borderColor: theme.border, backgroundColor: theme.surface, gap: theme.gap / 2 },
      ]}
      {...(label ? { role: 'region' as const, 'aria-label': label } : {})}
    >
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  hint,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  hint?: string;
}) {
  const { theme } = useField();
  const bg = kind === 'primary' ? theme.primary : kind === 'danger' ? theme.danger : theme.surface;
  const fg = kind === 'primary' ? theme.onPrimary : kind === 'danger' ? theme.onDanger : theme.text;
  return (
    <Pressable
      role="button"
      aria-disabled={disabled}
      {...(hint ? { accessibilityHint: hint } : {})}
      disabled={disabled}
      onPress={onPress}
      style={(state) => {
        const focused = (state as { focused?: boolean }).focused;
        const s: ViewStyle = {
          minHeight: theme.target,
          minWidth: theme.target,
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 10,
          backgroundColor: bg,
          borderWidth: 2,
          borderColor: kind === 'secondary' ? theme.border : bg,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.55 : state.pressed ? 0.8 : 1,
        };
        if (focused)
          Object.assign(s, {
            outlineColor: theme.focus,
            outlineWidth: 3,
            outlineStyle: 'solid',
            outlineOffset: 2,
          });
        return s;
      }}
    >
      <Text style={{ color: fg, fontSize: theme.font, fontWeight: '700', textAlign: 'center' }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChange,
  hint,
  secure,
  numeric,
  multiline,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  secure?: boolean;
  numeric?: boolean;
  /** Free text the volunteer may dictate with the keyboard's microphone (FLD-09). */
  multiline?: boolean;
  autoComplete?: 'off' | 'one-time-code' | 'organization' | 'new-password' | 'current-password';
}) {
  const { theme } = useField();
  const id = useId().replace(/:/g, '');
  return (
    <View style={{ gap: 6 }}>
      <Text
        nativeID={`${id}-l`}
        style={{ color: theme.text, fontSize: theme.font, fontWeight: '600' }}
      >
        {label}
      </Text>
      {hint ? (
        <Text nativeID={`${id}-h`} style={{ color: theme.muted, fontSize: theme.font - 2 }}>
          {hint}
        </Text>
      ) : null}
      <TextInput
        aria-labelledby={`${id}-l`}
        {...(hint ? { 'aria-describedby': `${id}-h` } : {})}
        value={value}
        onChangeText={onChange}
        secureTextEntry={!!secure}
        keyboardType={numeric ? 'number-pad' : 'default'}
        autoCapitalize={multiline ? 'sentences' : 'none'}
        autoCorrect={!!multiline}
        {...(multiline
          ? { multiline: true, numberOfLines: 4, textAlignVertical: 'top' as const }
          : {})}
        {...(autoComplete ? { autoComplete } : {})}
        style={{
          minHeight: multiline ? theme.target * 2 : theme.target,
          borderWidth: 2,
          borderColor: theme.border,
          borderRadius: 8,
          paddingHorizontal: 12,
          ...(multiline ? { paddingVertical: 8 } : {}),
          fontSize: theme.font + 2,
          color: theme.text,
          backgroundColor: theme.surface,
        }}
      />
    </View>
  );
}

export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const { theme, t } = useField();
  return (
    <Pressable
      role="switch"
      aria-checked={value}
      onPress={() => onChange(!value)}
      style={(state) => {
        const s: ViewStyle = {
          minHeight: theme.target,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 6,
        };
        if ((state as { focused?: boolean }).focused)
          Object.assign(s, { outlineColor: theme.focus, outlineWidth: 3, outlineStyle: 'solid' });
        return s;
      }}
    >
      <View
        style={{
          width: 52,
          height: 30,
          borderRadius: 15,
          borderWidth: 2,
          borderColor: theme.border,
          backgroundColor: value ? theme.primary : theme.surface,
          justifyContent: 'center',
          paddingHorizontal: 3,
        }}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: value ? theme.onPrimary : theme.muted,
            alignSelf: value ? 'flex-end' : 'flex-start',
          }}
        />
      </View>
      <Text style={{ color: theme.text, fontSize: theme.font, flex: 1 }}>
        {label}{' '}
        <Text style={{ fontWeight: '700' }}>({value ? t('common.yes') : t('common.no')})</Text>
      </Text>
    </Pressable>
  );
}

export function SyncBadge({ state }: { state: string | undefined }) {
  const { theme, t } = useField();
  const key = (
    state === 'sending' || state === 'conflict' || state === 'rejected' || state === 'on_this_phone'
      ? state
      : 'received'
  ) as 'sending' | 'conflict' | 'rejected' | 'on_this_phone' | 'received';
  const color =
    key === 'received'
      ? theme.ok
      : key === 'conflict' || key === 'rejected'
        ? theme.danger
        : theme.warn;
  return (
    <Text style={{ color, fontSize: theme.font - 2, fontWeight: '700' }}>
      {key === 'received' ? '✓ ' : key === 'sending' ? '↑ ' : key === 'on_this_phone' ? '• ' : '! '}
      {t(`sync.status.${key}`)}
    </Text>
  );
}

export function NavBar({ current }: { current: 'home' | 'messages' | 'sync' | 'settings' }) {
  const { theme, t } = useField();
  const items: { key: typeof current; label: string; href: string }[] = [
    { key: 'home', label: t('nav.home'), href: '/home' },
    { key: 'messages', label: t('nav.messages'), href: '/messages' },
    { key: 'sync', label: t('nav.sync'), href: '/sync' },
    { key: 'settings', label: t('nav.settings'), href: '/settings' },
  ];
  return (
    <View
      role="navigation"
      aria-label={t('app.title')}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
    >
      {items.map((i) => (
        <Fragment key={i.key}>
          <Pressable
            role="link"
            {...(i.key === current ? { 'aria-current': 'page' as const } : {})}
            onPress={() => router.replace(i.href)}
            style={(state) => {
              const s: ViewStyle = {
                minHeight: theme.target,
                paddingHorizontal: 12,
                justifyContent: 'center',
                borderBottomWidth: 3,
                borderColor: i.key === current ? theme.primary : 'transparent',
              };
              if ((state as { focused?: boolean }).focused)
                Object.assign(s, {
                  outlineColor: theme.focus,
                  outlineWidth: 3,
                  outlineStyle: 'solid',
                });
              return s;
            }}
          >
            <Text
              style={{
                color: theme.text,
                fontSize: theme.font,
                fontWeight: i.key === current ? '700' : '400',
              }}
            >
              {i.label}
            </Text>
          </Pressable>
        </Fragment>
      ))}
    </View>
  );
}

/** FLD-16: always one tap away; a second, explicit tap sends (no accidental alerts). */
export function HelpBar() {
  const { theme, t } = useField();
  return (
    <View style={[styles.help, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Button label={t('help.button')} kind="danger" onPress={() => router.push('/need-help')} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: '100%' as unknown as number },
  content: { padding: 16, paddingBottom: 24, maxWidth: 720, width: '100%', alignSelf: 'center' },
  card: { borderWidth: 1, borderRadius: 10, padding: 14 },
  bottom: { padding: 12, borderTopWidth: 1 },
  help: { padding: 12, borderTopWidth: 1 },
});

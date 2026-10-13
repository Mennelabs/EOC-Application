/**
 * Form controls for the field modules (FLD-15, WCAG 2.2 AA): large targets,
 * radio and checkbox roles with their state, a stepper whose value is
 * announced, and a yes / no / not-applicable row for checklists. Every
 * control has a visible label; the group's name comes from it.
 */
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { useField } from './field';
import { Body, Heading } from './ui';

function useChoiceStyle() {
  const { theme } = useField();
  return (selected: boolean): ViewStyle => ({
    minHeight: theme.target,
    minWidth: theme.target,
    borderWidth: selected ? 4 : 2,
    borderColor: selected ? theme.primary : theme.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: 'center',
    backgroundColor: theme.surface,
  });
}

export function RadioGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string | null;
  onChange: (v: string) => void;
}) {
  const { theme } = useField();
  const style = useChoiceStyle();
  return (
    <View style={{ gap: 6 }}>
      <Heading level={3}>{label}</Heading>
      <View
        role="radiogroup"
        aria-label={label}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
      >
        {options.map((o) => (
          <Pressable
            key={o.value}
            role="radio"
            aria-checked={o.value === value}
            onPress={() => onChange(o.value)}
            style={style(o.value === value)}
          >
            <Text style={{ color: theme.text, fontSize: theme.font }}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function CheckGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const { theme } = useField();
  const style = useChoiceStyle();
  return (
    <View style={{ gap: 6 }}>
      <Heading level={3}>{label}</Heading>
      <View
        role="group"
        aria-label={label}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
      >
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <Pressable
              key={o.value}
              role="checkbox"
              aria-checked={on}
              onPress={() =>
                onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])
              }
              style={style(on)}
            >
              <Text style={{ color: theme.text, fontSize: theme.font }}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const { t, theme } = useField();
  const style = useChoiceStyle();
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <View style={{ gap: 6 }}>
      <Heading level={3}>{label}</Heading>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable
          role="button"
          aria-label={t('controls.less', { label })}
          onPress={() => set(value - 1)}
          style={style(false)}
        >
          <Text style={{ color: theme.text, fontSize: theme.font + 4, textAlign: 'center' }}>
            −
          </Text>
        </Pressable>
        <Body live>{String(value)}</Body>
        <Pressable
          role="button"
          aria-label={t('controls.more', { label })}
          onPress={() => set(value + 1)}
          style={style(false)}
        >
          <Text style={{ color: theme.text, fontSize: theme.font + 4, textAlign: 'center' }}>
            +
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function ChecklistRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: 'yes' | 'no' | 'na' | undefined;
  onChange: (v: 'yes' | 'no' | 'na') => void;
}) {
  const { t, theme } = useField();
  const style = useChoiceStyle();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.text, fontSize: theme.font, fontWeight: '600' }}>{label}</Text>
      <View
        role="radiogroup"
        aria-label={label}
        style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}
      >
        {(['yes', 'no', 'na'] as const).map((v) => (
          <Pressable
            key={v}
            role="radio"
            aria-checked={value === v}
            onPress={() => onChange(v)}
            style={style(value === v)}
          >
            <Text style={{ color: theme.text, fontSize: theme.font }}>{t(`controls.${v}`)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

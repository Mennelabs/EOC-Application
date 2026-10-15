/**
 * The FEMA details card on the assessment screen (DCL:DEC-17, FLD-08,
 * FLD-15): optional questions that fit the home type, large targets, each
 * group named for screen readers, depth in feet and inches side by side.
 * The rules for what is asked and what is saved are in fema.ts.
 */
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import {
  FLOOD_LOCATIONS,
  INSURANCE_TYPES,
  OCCUPANCIES,
  TRIBAL_OWNERSHIP,
  YES_NO_UNKNOWN,
} from '@cg/field-core';
import type { Structure } from './assessment';
import { femaQuestions, toggleInsurance, type FemaState } from './fema';
import { useField } from './field';
import type { MessageKey } from './i18n';
import { Body, Card, Field, Heading } from './ui';

function Choices<T extends string>({
  label,
  values,
  selected,
  onPick,
  text,
  multi,
}: {
  label: string;
  values: readonly T[];
  selected: (v: T) => boolean;
  onPick: (v: T) => void;
  text: (v: T) => string;
  multi?: boolean;
}) {
  const { theme } = useField();
  const style = (on: boolean): ViewStyle => ({
    minHeight: theme.target,
    borderWidth: on ? 4 : 2,
    borderColor: on ? theme.primary : theme.border,
    borderRadius: 10,
    padding: 10,
    backgroundColor: theme.surface,
    justifyContent: 'center',
  });
  return (
    <View style={{ gap: 6 }}>
      <Heading level={3}>{label}</Heading>
      <View
        role={multi ? 'group' : 'radiogroup'}
        aria-label={label}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
      >
        {values.map((v) => (
          <Pressable
            key={v}
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={selected(v)}
            onPress={() => onPick(v)}
            style={style(selected(v))}
          >
            <Text style={{ color: theme.text, fontSize: theme.font }}>{text(v)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function FemaCard({
  value,
  onChange,
  structure,
  tribalOwnership,
}: {
  value: FemaState;
  onChange: (next: FemaState) => void;
  structure: Structure;
  tribalOwnership: boolean;
}) {
  const { t } = useField();
  const q = femaQuestions(structure, tribalOwnership);
  const set = <K extends keyof FemaState>(k: K, v: FemaState[K]) => onChange({ ...value, [k]: v });
  // Tapping the chosen answer again clears it: blank is "not recorded".
  const one = <T extends string>(current: T | null, v: T): T | null => (current === v ? null : v);
  return (
    <Card label={t('fema.heading')}>
      <Heading level={2}>{t('fema.heading')}</Heading>
      <Body muted>{t('fema.hint')}</Body>
      <Heading level={3}>{t('fema.depth')}</Heading>
      {FLOOD_LOCATIONS.map((l) => {
        const where = t(`fema.depth.${l}`);
        return (
          <View key={l} style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field
                numeric
                label={t('fema.feet', { where })}
                value={value.depth[l].feet}
                onChange={(v) =>
                  set('depth', { ...value.depth, [l]: { ...value.depth[l], feet: v } })
                }
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                numeric
                label={t('fema.inches', { where })}
                value={value.depth[l].inches}
                onChange={(v) =>
                  set('depth', { ...value.depth, [l]: { ...value.depth[l], inches: v } })
                }
              />
            </View>
          </View>
        );
      })}
      {q.units ? (
        <Field
          numeric
          label={t('fema.units')}
          value={value.units}
          onChange={(v) => set('units', v)}
        />
      ) : null}
      {q.household ? (
        <>
          <Choices
            label={t('fema.occupancy')}
            values={OCCUPANCIES}
            selected={(v) => value.occupancy === v}
            onPick={(v) => set('occupancy', one(value.occupancy, v))}
            text={(v) => t(`fema.occupancy.${v}` as MessageKey)}
          />
          <Choices
            multi
            label={t('fema.insurance')}
            values={INSURANCE_TYPES}
            selected={(v) => value.insurance.includes(v)}
            onPick={(v) => set('insurance', toggleInsurance(value.insurance, v))}
            text={(v) => t(`fema.insurance.${v}` as MessageKey)}
          />
        </>
      ) : null}
      <Choices
        label={t('fema.utilities')}
        values={YES_NO_UNKNOWN}
        selected={(v) => value.utilitiesOut === v}
        onPick={(v) => set('utilitiesOut', one(value.utilitiesOut, v))}
        text={(v) => t(`fema.answer.${v}` as MessageKey)}
      />
      {q.tribal ? (
        <Choices
          label={t('fema.tribal')}
          values={TRIBAL_OWNERSHIP}
          selected={(v) => value.tribal === v}
          onPick={(v) => set('tribal', one(value.tribal, v))}
          text={(v) => t(`fema.tribal.${v}` as MessageKey)}
        />
      ) : null}
      {q.business ? (
        <>
          <Field
            numeric
            label={t('fema.employees')}
            value={value.employees}
            onChange={(v) => set('employees', v)}
          />
          <Field
            numeric
            label={t('fema.daysClosed')}
            value={value.daysClosed}
            onChange={(v) => set('daysClosed', v)}
          />
        </>
      ) : null}
    </Card>
  );
}

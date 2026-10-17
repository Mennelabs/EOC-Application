/** Form fields on React Aria: text, text area, search, checkbox, radio group, switch. */
import type { ReactNode } from 'react';
import {
  Checkbox as AriaCheckbox,
  CheckboxGroup as AriaCheckboxGroup,
  FieldError,
  Input,
  Label,
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  SearchField as AriaSearchField,
  Switch as AriaSwitch,
  Text,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  type CheckboxGroupProps as AriaCheckboxGroupProps,
  type CheckboxProps as AriaCheckboxProps,
  type RadioGroupProps as AriaRadioGroupProps,
  type RadioProps as AriaRadioProps,
  type SearchFieldProps as AriaSearchFieldProps,
  type SwitchProps as AriaSwitchProps,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import { Check } from 'lucide-react';

interface FieldText {
  label: string;
  description?: string;
  errorMessage?: string;
}

export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  ...props
}: Omit<AriaTextFieldProps, 'className'> & FieldText & { placeholder?: string }) {
  return (
    <AriaTextField {...props} className="cg-field">
      <Label className="cg-field__label">{label}</Label>
      {description ? (
        <Text slot="description" className="cg-field__description">
          {description}
        </Text>
      ) : null}
      <Input className="cg-input" {...(placeholder ? { placeholder } : {})} />
      <FieldError className="cg-field__error">{errorMessage}</FieldError>
    </AriaTextField>
  );
}

export function TextArea({
  label,
  description,
  errorMessage,
  rows = 4,
  ...props
}: Omit<AriaTextFieldProps, 'className'> & FieldText & { rows?: number }) {
  return (
    <AriaTextField {...props} className="cg-field">
      <Label className="cg-field__label">{label}</Label>
      {description ? (
        <Text slot="description" className="cg-field__description">
          {description}
        </Text>
      ) : null}
      <AriaTextArea className="cg-input" rows={rows} />
      <FieldError className="cg-field__error">{errorMessage}</FieldError>
    </AriaTextField>
  );
}

export function SearchField({
  label,
  placeholder,
  ...props
}: Omit<AriaSearchFieldProps, 'className'> & { label: string; placeholder?: string }) {
  return (
    <AriaSearchField {...props} className="cg-field">
      <Label className="cg-field__label">{label}</Label>
      <Input className="cg-input" {...(placeholder ? { placeholder } : {})} />
    </AriaSearchField>
  );
}

export function Checkbox({
  children,
  ...props
}: Omit<AriaCheckboxProps, 'className'> & { children: ReactNode }) {
  return (
    <AriaCheckbox {...props} className="cg-check">
      <span className="cg-check__box" aria-hidden="true">
        <Check />
      </span>
      <span>{children}</span>
    </AriaCheckbox>
  );
}

export function CheckboxGroup({
  label,
  description,
  errorMessage,
  children,
  ...props
}: Omit<AriaCheckboxGroupProps, 'className'> & FieldText & { children: ReactNode }) {
  return (
    <AriaCheckboxGroup {...props} className="cg-radio-group">
      <Label className="cg-radio-group__label">{label}</Label>
      {description ? (
        <Text slot="description" className="cg-field__description">
          {description}
        </Text>
      ) : null}
      {children}
      <FieldError className="cg-field__error">{errorMessage}</FieldError>
    </AriaCheckboxGroup>
  );
}

export function RadioGroup({
  label,
  description,
  errorMessage,
  children,
  ...props
}: Omit<AriaRadioGroupProps, 'className'> & FieldText & { children: ReactNode }) {
  return (
    <AriaRadioGroup {...props} className="cg-radio-group">
      <Label className="cg-radio-group__label">{label}</Label>
      {description ? (
        <Text slot="description" className="cg-field__description">
          {description}
        </Text>
      ) : null}
      {children}
      <FieldError className="cg-field__error">{errorMessage}</FieldError>
    </AriaRadioGroup>
  );
}

export function Radio({
  children,
  ...props
}: Omit<AriaRadioProps, 'className'> & { children: ReactNode }) {
  return (
    <AriaRadio {...props} className="cg-check cg-check--radio">
      <span className="cg-check__box" aria-hidden="true">
        <span className="cg-pill__dot" />
      </span>
      <span>{children}</span>
    </AriaRadio>
  );
}

export function Switch({
  children,
  ...props
}: Omit<AriaSwitchProps, 'className'> & { children: ReactNode }) {
  return (
    <AriaSwitch {...props} className="cg-switch">
      <span className="cg-switch__track" aria-hidden="true" />
      <span>{children}</span>
    </AriaSwitch>
  );
}

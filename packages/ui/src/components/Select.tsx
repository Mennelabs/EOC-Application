/** A select on React Aria: styled like the inputs, keyboard and screen-reader complete. */
import type { ReactNode } from 'react';
import {
  Button,
  FieldError,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  type ListBoxItemProps,
  type SelectProps as AriaSelectProps,
} from 'react-aria-components';
import { ChevronDown } from 'lucide-react';

export function Select<T extends object>({
  label,
  description,
  errorMessage,
  children,
  items,
  ...props
}: Omit<AriaSelectProps<T>, 'className' | 'children'> & {
  label: string;
  description?: string;
  errorMessage?: string;
  items?: Iterable<T>;
  children: ReactNode | ((item: T) => ReactNode);
}) {
  return (
    <AriaSelect {...props} className="cg-select">
      <Label className="cg-field__label">{label}</Label>
      <Button className="cg-select__button">
        <SelectValue />
        <ChevronDown aria-hidden="true" />
      </Button>
      {description ? (
        <Text slot="description" className="cg-field__description">
          {description}
        </Text>
      ) : null}
      <FieldError className="cg-field__error">{errorMessage}</FieldError>
      <Popover className="cg-popover">
        <ListBox className="cg-listbox" {...(items ? { items } : {})}>
          {children}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

export function Option(props: Omit<ListBoxItemProps, 'className'>) {
  return <ListBoxItem {...props} className="cg-option" />;
}

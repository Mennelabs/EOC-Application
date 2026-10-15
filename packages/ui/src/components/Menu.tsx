/** Menus on React Aria: a trigger button, a popover, items with keyboard navigation. */
import type { ReactNode } from 'react';
import {
  Header,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  MenuTrigger,
  Popover,
  type Key,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
} from 'react-aria-components';
import type { LucideIcon } from 'lucide-react';

export function Menu<T extends object>({
  trigger,
  children,
  label,
  placement = 'bottom end',
  ...props
}: Omit<AriaMenuProps<T>, 'className'> & {
  /** The button that opens the menu (any Button). */
  trigger: ReactNode;
  children: ReactNode;
  label?: string;
  placement?: 'bottom end' | 'bottom start' | 'bottom';
}) {
  return (
    <MenuTrigger>
      {trigger}
      <Popover className="cg-popover" placement={placement}>
        <AriaMenu {...props} className="cg-menu" {...(label ? { 'aria-label': label } : {})}>
          {children}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}

export function MenuItem({
  icon: Icon,
  children,
  shortcut,
  ...props
}: Omit<AriaMenuItemProps, 'className' | 'children'> & {
  icon?: LucideIcon;
  children: ReactNode;
  shortcut?: string;
}) {
  return (
    <AriaMenuItem {...props} className="cg-menu__item">
      {Icon ? <Icon aria-hidden="true" /> : null}
      <span>{children}</span>
      {shortcut ? <kbd className="cg-kbd">{shortcut}</kbd> : null}
    </AriaMenuItem>
  );
}

export function MenuSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <AriaMenuSection className="cg-menu__section">
      {title ? <Header className="cg-menu__header">{title}</Header> : null}
      {children}
    </AriaMenuSection>
  );
}

export type { Key };

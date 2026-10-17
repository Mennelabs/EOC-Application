/**
 * Buttons on React Aria (ADR-0045): keyboard and pointer handling, pressed and
 * disabled states as data attributes, 44 px targets (ACC-12). A button always
 * has words; an icon is decoration beside them, or the button carries an
 * aria-label and a tooltip (users-and-needs §2.7).
 */
import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Link as AriaLink,
  type ButtonProps as AriaButtonProps,
  type LinkProps as AriaLinkProps,
} from 'react-aria-components';
import type { LucideIcon } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'link' | 'danger';
export type ButtonSize = 'md' | 'lg';

function classes(
  variant: ButtonVariant,
  size: ButtonSize,
  iconOnly: boolean,
  extra: string | undefined,
): string {
  return [
    'cg-button',
    variant === 'secondary' ? '' : `cg-button--${variant}`,
    size === 'lg' ? 'cg-button--lg' : '',
    iconOnly ? 'cg-button--icon' : '',
    extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends Omit<AriaButtonProps, 'className' | 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Drawn before the words. */
  icon?: LucideIcon;
  /** The words. Required unless the button is icon-only with an aria-label. */
  children?: ReactNode;
  className?: string;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  children,
  className,
  ...rest
}: ButtonProps) {
  const iconOnly = !children;
  return (
    <AriaButton {...rest} className={classes(variant, size, iconOnly, className)}>
      {Icon ? <Icon className="cg-button__icon" aria-hidden="true" /> : null}
      {children}
    </AriaButton>
  );
}

export interface LinkButtonProps extends Omit<AriaLinkProps, 'className' | 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  children?: ReactNode;
  className?: string;
}

/** A link that looks like a button: navigation, never an action (WAI-ARIA: links go somewhere). */
export function LinkButton({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  children,
  className,
  ...rest
}: LinkButtonProps) {
  return (
    <AriaLink {...rest} className={classes(variant, size, !children, className)}>
      {Icon ? <Icon className="cg-button__icon" aria-hidden="true" /> : null}
      {children}
    </AriaLink>
  );
}

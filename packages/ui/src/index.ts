/**
 * @cg/ui: the shared design foundation (ADR-0045). Import the stylesheet once
 * per app (`@cg/ui/styles.css` plus `@cg/ui/fonts/staff.css` or
 * `@cg/ui/fonts/public.css`), then the components from here.
 */
export { Button, LinkButton, type ButtonProps, type ButtonVariant } from './components/Button.tsx';
export {
  Card,
  DecisionCard,
  DecisionList,
  EmptyState,
  Kbd,
  Notice,
  PageHeader,
  Pill,
  Skeleton,
  StatTile,
  Tiles,
  Timeline,
  Toolbar,
  VisuallyHidden,
  type TimelineEntry,
  type Tone,
} from './components/display.tsx';
export { Menu, MenuItem, MenuSection } from './components/Menu.tsx';
export { Option, Select } from './components/Select.tsx';
export {
  Checkbox,
  CheckboxGroup,
  Radio,
  RadioGroup,
  SearchField,
  Switch,
  TextArea,
  TextField,
} from './components/fields.tsx';
export { Dialog, DialogTrigger } from './components/Dialog.tsx';
export { Tab, TabList, TabPanel, Tabs } from './components/Tabs.tsx';
export { Tooltip } from './components/Tooltip.tsx';
export { Disclosure } from './components/Disclosure.tsx';
export { TopBar } from './components/shell/TopBar.tsx';
export { EventChip } from './components/shell/EventChip.tsx';
export { PersonMenu } from './components/shell/PersonMenu.tsx';
export { SideNav, type NavGroup, type NavItem } from './components/shell/SideNav.tsx';
export { Shell, NavToggle } from './components/shell/Shell.tsx';
export * from './theme.ts';
export * from './format.ts';
export * as icons from './icons.ts';
export type { LucideIcon } from './icons.ts';

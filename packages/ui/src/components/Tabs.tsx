/** Tabs on React Aria. */
import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  type TabListProps,
  type TabPanelProps,
  type TabProps,
  type TabsProps,
} from 'react-aria-components';

export function Tabs(props: Omit<TabsProps, 'className'>) {
  return <AriaTabs {...props} className="cg-tabs" />;
}
export function TabList<T extends object>(props: Omit<TabListProps<T>, 'className'>) {
  return <AriaTabList {...props} className="cg-tablist" />;
}
export function Tab(props: Omit<TabProps, 'className'>) {
  return <AriaTab {...props} className="cg-tab" />;
}
export function TabPanel(props: Omit<TabPanelProps, 'className'>) {
  return <AriaTabPanel {...props} className="cg-tabpanel" />;
}

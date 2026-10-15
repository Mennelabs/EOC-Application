/** The frame: top bar, optional banner, side navigation and the main region. */
import { useContext, useMemo, useState, type ReactNode } from 'react';
import { Menu as MenuIcon } from 'lucide-react';
import { Button } from '../Button.tsx';
import { ShellNavContext } from './context.ts';

/**
 * The "Workspaces" button that opens the drawer on narrow screens. The TopBar
 * renders it, so it sits in the sticky bar and stays reachable, and nothing
 * can scroll over it (WCAG 2.5.8; ACC-07). Renders nothing outside a Shell
 * and nothing on wide screens (CSS).
 */
export function NavToggle() {
  const nav = useContext(ShellNavContext);
  if (!nav) return null;
  return (
    <Button
      variant="quiet"
      icon={MenuIcon}
      className="cg-nav-toggle"
      aria-expanded={nav.open}
      aria-controls={nav.id}
      onPress={nav.toggle}
    >
      Workspaces
    </Button>
  );
}

export function Shell({
  topBar,
  banner,
  nav,
  children,
  mainId = 'main',
}: {
  /** A TopBar (it carries the NavToggle), or any header that renders NavToggle itself. */
  topBar: ReactNode;
  banner?: ReactNode;
  /** A SideNav; on narrow screens the toggle opens the drawer and `close` shuts it after a move. */
  nav: (navProps: { id: string; open: boolean; close: () => void }) => ReactNode;
  children: ReactNode;
  mainId?: string;
}) {
  const [open, setOpen] = useState(false);
  const navId = 'cg-workspaces';
  const shellNav = useMemo(() => ({ id: navId, open, toggle: () => setOpen((o) => !o) }), [open]);
  return (
    <ShellNavContext.Provider value={shellNav}>
      <div className="cg-shell">
        {topBar}
        {banner}
        <div className="cg-body">
          {nav({ id: navId, open, close: () => setOpen(false) })}
          <main id={mainId} tabIndex={-1} className="cg-main">
            {children}
          </main>
        </div>
      </div>
    </ShellNavContext.Provider>
  );
}

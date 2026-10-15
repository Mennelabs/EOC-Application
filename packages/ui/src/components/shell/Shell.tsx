/** The frame: top bar, optional banner, side navigation and the main region. */
import { useState, type ReactNode } from 'react';
import { Menu as MenuIcon } from 'lucide-react';
import { Button } from '../Button.tsx';

export function Shell({
  topBar,
  banner,
  nav,
  children,
  mainId = 'main',
}: {
  topBar: ReactNode;
  banner?: ReactNode;
  /** A SideNav; on narrow screens the toggle opens and closes it. */
  nav: (navProps: { id: string; open: boolean }) => ReactNode;
  children: ReactNode;
  mainId?: string;
}) {
  const [open, setOpen] = useState(false);
  const navId = 'cg-workspaces';
  return (
    <div className="cg-shell">
      {topBar}
      {banner}
      <div className="cg-body">
        <div className="cg-nav-toggle-row">
          <Button
            variant="quiet"
            icon={MenuIcon}
            className="cg-nav-toggle"
            aria-expanded={open}
            aria-controls={navId}
            onPress={() => setOpen((o) => !o)}
          >
            Workspaces
          </Button>
        </div>
        {nav({ id: navId, open })}
        <main id={mainId} tabIndex={-1} className="cg-main">
          {children}
        </main>
      </div>
    </div>
  );
}

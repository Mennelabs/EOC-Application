/**
 * The top bar (mockups/console/Main.dc.html; CON-01): the product and the
 * county, the event chip, the command bar, the person. Dark in both themes so
 * the frame reads the same on a wall display and a laptop. On a narrow screen
 * it also holds the "Workspaces" button that opens the navigation drawer.
 */
import type { ReactNode } from 'react';
import { Home } from 'lucide-react';
import { NavToggle } from './Shell.tsx';

export function TopBar({
  product,
  county,
  homeHref = '/',
  onNavigate,
  children,
  end,
}: {
  product: string;
  county?: string;
  homeHref?: string;
  onNavigate?: (href: string) => void;
  /** The middle: the event chip, the command bar. */
  children?: ReactNode;
  /** The end: the person, sign out. */
  end?: ReactNode;
}) {
  return (
    <header className="cg-topbar">
      <a
        className="cg-topbar__brand"
        href={homeHref}
        onClick={(e) => {
          if (!onNavigate) return;
          e.preventDefault();
          onNavigate(homeHref);
        }}
      >
        <span className="cg-topbar__mark" aria-hidden="true">
          <Home width={16} height={16} />
        </span>
        <span className="cg-topbar__product">{product}</span>
        {county ? <span className="cg-topbar__county">{county}</span> : null}
      </a>
      <NavToggle />
      {children}
      <div className="cg-topbar__end">{end}</div>
    </header>
  );
}

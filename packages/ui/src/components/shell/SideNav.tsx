/**
 * Workspaces down the side, grouped, each with a visible label and an optional
 * live count beside the link (outside the link's name, so a test or a screen
 * reader finds "Review queue" and then hears "874 waiting"). The current
 * workspace is marked with aria-current.
 */
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  path: string;
  label: string;
  icon?: LucideIcon;
  count?: number | null;
  countLabel?: string;
  countTone?: 'warn' | 'danger';
}
export interface NavGroup {
  title: string;
  items: NavItem[];
}

export function SideNav({
  groups,
  currentPath,
  onNavigate,
  id,
  open = true,
  label = 'Workspaces',
}: {
  groups: NavGroup[];
  currentPath: string;
  onNavigate: (path: string) => void;
  id?: string;
  /** Narrow screens only: the drawer's state. Wide screens always show the navigation. */
  open?: boolean;
  label?: string;
}) {
  const normal = (p: string) => p.replace(/\/$/, '') || '/';
  return (
    <nav className="cg-sidenav" aria-label={label} id={id} data-open={open ? 'true' : 'false'}>
      {groups.map((g) => (
        <div className="cg-nav-group" key={g.title}>
          <h2 className="cg-nav-group__title">{g.title}</h2>
          <ul>
            {g.items.map((item) => {
              const Icon = item.icon;
              const current = normal(item.path) === normal(currentPath);
              return (
                <li className="cg-nav-item" key={item.path}>
                  <a
                    href={item.path}
                    aria-current={current ? 'page' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate(item.path);
                    }}
                  >
                    {Icon ? <Icon aria-hidden="true" /> : null}
                    <span>{item.label}</span>
                  </a>
                  {typeof item.count === 'number' && item.count > 0 ? (
                    <span
                      className={[
                        'cg-nav-count',
                        item.countTone ? `cg-nav-count--${item.countTone}` : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-label={`${item.count.toLocaleString()} ${item.countLabel ?? 'waiting'}`}
                    >
                      {item.count > 999 ? '999+' : item.count}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

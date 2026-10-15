/**
 * The signed-in person and the device's display choices: theme, density,
 * briefing mode, then sign out. The name and role are visible beside the
 * avatar on wide screens; the button's accessible name carries both always.
 */
import { LogOut, Monitor, Moon, Rows3, Sun, Tv } from 'lucide-react';
import { Button } from '../Button.tsx';
import { Menu, MenuItem, MenuSection } from '../Menu.tsx';
import { initials } from '../../format.ts';
import type { Density, ThemePreference } from '../../theme.ts';

export function PersonMenu({
  name,
  role,
  theme,
  density,
  briefing,
  onTheme,
  onDensity,
  onBriefing,
  onSignOut,
}: {
  name: string;
  role?: string;
  theme: ThemePreference;
  density: Density;
  briefing?: boolean;
  onTheme: (t: ThemePreference) => void;
  onDensity: (d: Density) => void;
  onBriefing?: (on: boolean) => void;
  onSignOut: () => void;
}) {
  return (
    <Menu
      label="Account and display"
      trigger={
        <Button
          variant="quiet"
          className="cg-person"
          aria-label={`${name}${role ? `, ${role}` : ''}: account and display menu`}
        >
          <span className="cg-person__text" aria-hidden="true">
            <span className="cg-person__name">{name}</span>
            {role ? <span className="cg-person__role">{role}</span> : null}
          </span>
          <span className="cg-avatar" aria-hidden="true">
            {initials(name)}
          </span>
        </Button>
      }
    >
      <MenuSection title="Theme">
        <MenuItem icon={Monitor} onAction={() => onTheme('auto')} aria-checked={theme === 'auto'}>
          Follow the device
        </MenuItem>
        <MenuItem icon={Sun} onAction={() => onTheme('light')} aria-checked={theme === 'light'}>
          Light
        </MenuItem>
        <MenuItem icon={Moon} onAction={() => onTheme('dark')} aria-checked={theme === 'dark'}>
          Dark
        </MenuItem>
      </MenuSection>
      <MenuSection title="Density">
        <MenuItem
          icon={Rows3}
          onAction={() => onDensity('comfortable')}
          aria-checked={density === 'comfortable'}
        >
          Comfortable
        </MenuItem>
        <MenuItem
          icon={Rows3}
          onAction={() => onDensity('compact')}
          aria-checked={density === 'compact'}
        >
          Compact
        </MenuItem>
      </MenuSection>
      {onBriefing ? (
        <MenuSection title="Display">
          <MenuItem
            icon={Tv}
            onAction={() => onBriefing(!briefing)}
            aria-checked={briefing === true}
          >
            Briefing mode (wall display)
          </MenuItem>
        </MenuSection>
      ) : null}
      <MenuSection>
        <MenuItem icon={LogOut} onAction={onSignOut}>
          Sign out
        </MenuItem>
      </MenuSection>
    </Menu>
  );
}

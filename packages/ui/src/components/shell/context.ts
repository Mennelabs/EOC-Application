/** What the frame tells its top bar: the narrow-screen drawer's state and the button that opens it. */
import { createContext } from 'react';

export interface ShellNav {
  /** The navigation element's id (the toggle's aria-controls). */
  id: string;
  open: boolean;
  toggle: () => void;
}

export const ShellNavContext = createContext<ShellNav | null>(null);

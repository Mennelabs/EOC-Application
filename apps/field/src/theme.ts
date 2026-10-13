/**
 * Field-use theme (FLD-15, WCAG 2.2 AA): normal and high-contrast palettes for
 * sunlight, targets of at least 48 px (64 px with "large buttons for gloves"),
 * and a one-handed layout that keeps the main actions at the bottom. Colour
 * never carries meaning alone: every status also has words (ACC-07).
 */
export interface Settings {
  highContrast: boolean;
  largeTargets: boolean;
  oneHanded: boolean;
  batterySaver: boolean;
}

export const defaultSettings: Settings = {
  highContrast: false,
  largeTargets: false,
  oneHanded: false,
  batterySaver: false,
};

export interface Theme {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  danger: string;
  onDanger: string;
  ok: string;
  warn: string;
  focus: string;
  target: number;
  font: number;
  gap: number;
  oneHanded: boolean;
}

/** Contrast ratios checked against WCAG 2.2: text ≥ 4.5:1 on its background, high contrast ≥ 7:1. */
export function themeFor(s: Settings): Theme {
  const base = s.highContrast
    ? {
        bg: '#000000',
        surface: '#000000',
        text: '#ffffff',
        muted: '#f2f2f2',
        border: '#ffffff',
        primary: '#ffd60a',
        onPrimary: '#000000',
        danger: '#ff5c5c',
        onDanger: '#000000',
        ok: '#7cff7c',
        warn: '#ffd60a',
        focus: '#00e5ff',
      }
    : {
        bg: '#f6f7f9',
        surface: '#ffffff',
        text: '#14171c',
        muted: '#4a5260',
        border: '#8a93a3',
        primary: '#0b5cad',
        onPrimary: '#ffffff',
        danger: '#b3261e',
        onDanger: '#ffffff',
        ok: '#1d6b33',
        warn: '#7a4d00',
        focus: '#7a2bc4',
      };
  return {
    ...base,
    target: s.largeTargets ? 64 : 48,
    font: s.largeTargets ? 20 : 17,
    gap: s.largeTargets ? 16 : 12,
    oneHanded: s.oneHanded,
  };
}

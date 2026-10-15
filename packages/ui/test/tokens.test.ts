/**
 * Every colour pair the stylesheet relies on keeps its contrast in both themes
 * (ACC-08; WCAG 1.4.3, 1.4.6, 1.4.11; docs/design/users-and-needs.md): body ink
 * 7:1, other text 4.5:1, lines, focus rings and fills 3:1.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

function block(re: RegExp): Record<string, string> {
  const m = css.match(re);
  if (!m?.[1]) throw new Error(`block not found: ${re}`);
  return Object.fromEntries(
    [...m[1].matchAll(/--cg-([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((x) => [x[1], x[2]]),
  );
}
const light = block(/:root \{([\s\S]*?)\n\}/);
const dark = block(/:root\[data-theme='dark'\] \{([\s\S]*?)\n\}/);
const auto = block(/:root:not\(\[data-theme='light'\]\) \{([\s\S]*?)\n {2}\}/);

function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
}

const pairs: [string, string, number][] = [
  ['ink', 'surface', 7],
  ['ink', 'bg', 7],
  ['ink', 'surface-2', 7],
  ['ink-2', 'surface', 4.5],
  ['ink-2', 'bg', 4.5],
  ['ink-2', 'surface-2', 4.5],
  ['ink-3', 'surface', 4.5],
  ['ink-3', 'surface-2', 4.5],
  ['accent', 'surface', 4.5],
  ['accent', 'bg', 4.5],
  ['accent', 'surface-2', 4.5],
  ['accent-ink', 'accent', 4.5],
  ['accent-hover', 'surface', 4.5],
  ['accent', 'accent-soft', 4.5],
  ['ink', 'accent-soft', 4.5],
  ['ink', 'selection', 4.5],
  ['focus', 'surface', 3],
  ['focus', 'bg', 3],
  ['line-strong', 'surface', 3],
  ['line-strong', 'bg', 3],
  ['ok-ink', 'ok-bg', 4.5],
  ['warn-ink', 'warn-bg', 4.5],
  ['danger-ink', 'danger-bg', 4.5],
  ['info-ink', 'info-bg', 4.5],
  ['ai-ink', 'ai-bg', 4.5],
  ['neutral-ink', 'neutral-bg', 4.5],
  ['ok-ink', 'surface', 4.5],
  ['warn-ink', 'surface', 4.5],
  ['danger-ink', 'surface', 4.5],
  ['info-ink', 'surface', 4.5],
  ['ai-ink', 'surface', 4.5],
  ['ok-line', 'surface', 3],
  ['warn-line', 'surface', 3],
  ['danger-line', 'surface', 3],
  ['info-line', 'surface', 3],
  ['ai-line', 'surface', 3],
  ['neutral-line', 'surface', 3],
  ['fill-ink', 'ok-fill', 4.5],
  ['fill-ink', 'warn-fill', 4.5],
  ['fill-ink', 'danger-fill', 4.5],
  ['fill-ink', 'info-fill', 4.5],
  ['ok-fill', 'surface', 3],
  ['warn-fill', 'surface', 3],
  ['danger-fill', 'surface', 3],
  ['info-fill', 'surface', 3],
  ['header-ink', 'header-bg', 7],
  ['header-ink-2', 'header-bg', 4.5],
  ['header-focus', 'header-bg', 3],
  ['header-ink', 'header-chip', 7],
  ['header-ink-2', 'header-chip', 4.5],
];

describe('design tokens', () => {
  for (const [name, theme] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    describe(`${name} theme`, () => {
      for (const [a, b, min] of pairs) {
        it(`${a} on ${b} is at least ${min}:1`, () => {
          const A = theme[a] ?? light[a];
          const B = theme[b] ?? light[b];
          expect(A, a).toBeDefined();
          expect(B, b).toBeDefined();
          expect(contrast(A as string, B as string)).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }

  it('the device-preference dark block and the chosen dark block are the same palette', () => {
    expect(auto).toEqual(dark);
  });

  it('names the fonts the apps load', () => {
    expect(css).toContain("'IBM Plex Sans Variable'");
    expect(css).toContain("'Atkinson Hyperlegible Next Variable'");
  });
});

import { defineConfig, devices } from '@playwright/test';

/**
 * Accessibility and visual checks of the showcase (ADR-0045, GATE-03): axe at
 * WCAG 2.2 AA in both themes, reflow at phone width, and a screenshot of each
 * state for review. Needs no stack: `pnpm --filter @cg/ui test:showcase`.
 */
const executablePath = process.env['PW_CHROMIUM_PATH'];

export default defineConfig({
  testDir: 'test',
  testMatch: /.*\.spec\.ts/,
  outputDir: 'test-results',
  reporter: [['list']],
  webServer: {
    command: 'pnpm vite preview --config showcase.vite.config.ts',
    url: 'http://localhost:4318/',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://localhost:4318',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});

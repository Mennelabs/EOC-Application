import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end and accessibility tests against the running stack
 * (`docker compose up`). BASE_URL defaults to the local gateway.
 * PW_CHROMIUM_PATH lets a machine use a preinstalled Chromium.
 */
const executablePath = process.env['PW_CHROMIUM_PATH'];

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  // The journeys share one county: a help alert raised by the field journey takes over every
  // dispatcher's board (FLD-16), so in CI the files run one at a time to keep each journey's
  // screen its own. Locally the default parallelism stays.
  ...(process.env['CI'] ? { workers: 1 } : {}),
  use: {
    baseURL: process.env['BASE_URL'] ?? 'https://localhost',
    ignoreHTTPSErrors: true, // Caddy's local CA in development.
    trace: 'retain-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // CHN-02 / ACC-07: small phone viewport, reflow without horizontal scroll.
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});

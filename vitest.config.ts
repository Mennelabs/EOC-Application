import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{packages,services,tools}/**/test/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.int.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.int.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});

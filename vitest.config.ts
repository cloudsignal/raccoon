import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __RACCOON_BUILD_ID__: JSON.stringify('dev') },
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'examples/*/src/**/*.test.ts', 'adapters/*/src/**/*.test.ts'],
    testTimeout: 10_000,
    globals: true,
  },
});

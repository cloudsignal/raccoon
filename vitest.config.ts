import { defineConfig } from 'vitest/config';

// Internal dev resolution (v0.1 packaging): published packages point `main`/
// `exports` at built `dist/`, but tests run against SOURCE so `npm test` needs
// no build step. These aliases are INTERNAL only — the published tarballs and
// the consumer fixture never see them (the release neutrality gate enforces
// that consumers resolve package roots, never `/src`).
const src = (p: string) => new URL(`./${p}`, import.meta.url).pathname;

export default defineConfig({
  define: { __RACCOON_BUILD_ID__: JSON.stringify('dev') },
  resolve: {
    alias: {
      '@raccoon/protocol': src('packages/protocol/src/index.ts'),
      '@raccoon/bridge': src('packages/bridge/src/index.ts'),
      '@raccoon/pairing': src('packages/pairing/src/index.ts'),
      '@raccoon/transport-ws': src('packages/transport-ws/src/index.ts'),
      '@raccoon/push': src('packages/push/src/index.ts'),
      '@raccoon/app': src('packages/app/src/lib.ts'),
      '@raccoon/connector-openclaw': src('adapters/connector-openclaw/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'examples/*/src/**/*.test.ts', 'adapters/*/src/**/*.test.ts'],
    testTimeout: 10_000,
    globals: true,
  },
});

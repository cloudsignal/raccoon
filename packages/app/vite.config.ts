import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { buildManifest, stampBuildId, versionJson } from './src/build/meta.ts';
import { appConfig } from './src/config.ts';

const buildId = process.env.BUILD_ID || 'dev';

function raccoonAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'raccoon-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolve(outDir, 'version.json'), versionJson(buildId));
      writeFileSync(resolve(outDir, 'manifest.webmanifest'), buildManifest(appConfig));
      const swSource = readFileSync(fileURLToPath(new URL('sw/service-worker.js', import.meta.url)), 'utf8');
      writeFileSync(resolve(outDir, 'service-worker.js'), stampBuildId(swSource, buildId));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), raccoonAssets()],
  define: { __RACCOON_BUILD_ID__: JSON.stringify(buildId) },
  resolve: {
    // Resolve workspace deps to SOURCE so `npm run build:app` is self-contained
    // on a clean clone (no prior `npm run build` / dist required — the DoD lists
    // build:app as a standalone post-`npm ci` command).
    alias: {
      '@raccoon/protocol': new URL('../protocol/src/index.ts', import.meta.url).pathname,
      // The transport-ws barrel re-exports server-only modules (credential-store, hub).
      // Point the browser build at the browser-safe client entry only.
      '@raccoon/transport-ws': new URL('../transport-ws/src/client.ts', import.meta.url).pathname,
    },
  },
});

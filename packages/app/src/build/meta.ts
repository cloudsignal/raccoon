import type { RaccoonConfig } from '../config.js';

export function buildManifest(cfg: RaccoonConfig): string {
  return JSON.stringify(
    {
      name: cfg.name,
      short_name: cfg.shortName,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: cfg.themeColor,
      theme_color: cfg.themeColor,
      icons: [
        { src: cfg.icons.icon192, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: cfg.icons.icon512, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
    null,
    2,
  );
}

export function stampBuildId(source: string, buildId: string): string {
  return source.replaceAll('__RACCOON_BUILD_ID__', buildId);
}

export function versionJson(buildId: string): string {
  return JSON.stringify({ buildId });
}

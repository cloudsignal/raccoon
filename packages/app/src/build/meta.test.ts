import { describe, expect, it } from 'vitest';
import { buildManifest, stampBuildId, versionJson } from './meta.js';
import { appConfig } from '../config.js';

describe('build meta', () => {
  it('builds a valid webmanifest from the brand config', () => {
    const manifest = JSON.parse(buildManifest(appConfig));
    expect(manifest.name).toBe('Raccoon');
    expect(manifest.short_name).toBe('Raccoon');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.theme_color).toBe(appConfig.themeColor);
    expect(manifest.icons).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ]);
  });

  it('stamps build ids into worker source', () => {
    expect(stampBuildId('const B = "__RACCOON_BUILD_ID__";', 'abc1')).toBe('const B = "abc1";');
  });

  it('emits version json', () => {
    expect(JSON.parse(versionJson('abc1'))).toEqual({ buildId: 'abc1' });
  });
});

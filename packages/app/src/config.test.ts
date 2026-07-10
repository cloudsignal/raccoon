import { describe, expect, it } from 'vitest';
import { appConfig, channelMeta } from './config.js';

describe('brand config', () => {
  it('parses the default Raccoon brand', () => {
    expect(appConfig.name).toBe('Raccoon');
    expect(appConfig.wallpaper).toBe('#EDE6DA');
    expect(appConfig.outgoing).toBe('#D9FDD3');
  });

  it('resolves channel meta with config overrides', () => {
    const meta = channelMeta('coordinator');
    expect(meta.label).toBe('Coordinator');
    expect(meta.blurb).toBe('Your single point of contact');
    expect(meta.tone).toBe('navy');
  });

  it('derives deterministic defaults for unknown channels', () => {
    const a = channelMeta('assistant');
    const b = channelMeta('assistant');
    expect(a.label).toBe('Assistant');
    expect(a.tone).toBe(b.tone);
  });
});

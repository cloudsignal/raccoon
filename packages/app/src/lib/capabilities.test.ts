// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://hub.example.com/app"}
import { describe, expect, it } from 'vitest';
import { servesThisApp } from './capabilities.js';

describe('servesThisApp', () => {
  it('is true for a host-transport pairing (the serving process itself), url or not', () => {
    expect(servesThisApp({ transportKind: 'host' })).toBe(true);
    expect(servesThisApp({ url: 'wss://elsewhere.example.com/ws', transportKind: 'host' })).toBe(true);
  });

  it('is true when the pairing url host matches the host serving the app (ws scheme parses fine)', () => {
    expect(servesThisApp({ url: 'wss://hub.example.com/ws', transportKind: 'ws' })).toBe(true);
    expect(servesThisApp({ url: 'ws://hub.example.com/', transportKind: 'ws' })).toBe(true);
  });

  it('is false when the pairing url points at a different host', () => {
    expect(servesThisApp({ url: 'wss://other.example.com/ws', transportKind: 'ws' })).toBe(false);
    // host includes the port — same hostname on another port is a different origin
    expect(servesThisApp({ url: 'wss://hub.example.com:8443/ws', transportKind: 'ws' })).toBe(false);
  });

  it('is false with no url', () => {
    expect(servesThisApp({ transportKind: 'ws' })).toBe(false);
  });

  it('is false when the url does not parse', () => {
    expect(servesThisApp({ url: 'not a url', transportKind: 'ws' })).toBe(false);
  });
});

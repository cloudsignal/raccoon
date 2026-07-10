import { describe, it, expect } from 'vitest';
import { isSafeWebPushEndpoint } from './endpoint-guard.js';

describe('isSafeWebPushEndpoint', () => {
  it('accepts normal public https push endpoints', () => {
    expect(isSafeWebPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isSafeWebPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/xyz')).toBe(true);
    expect(isSafeWebPushEndpoint('https://8.8.8.8/x')).toBe(true);
  });

  it('rejects non-https schemes', () => {
    expect(isSafeWebPushEndpoint('http://example.com/x')).toBe(false);
    expect(isSafeWebPushEndpoint('file:///etc/passwd')).toBe(false);
    expect(isSafeWebPushEndpoint('ftp://example.com/')).toBe(false);
  });

  it('rejects localhost and .local hosts', () => {
    expect(isSafeWebPushEndpoint('https://localhost/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://foo.local/x')).toBe(false);
  });

  it('rejects private / loopback / link-local / metadata IPv4', () => {
    expect(isSafeWebPushEndpoint('https://127.0.0.1/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://10.0.0.5/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://172.16.0.1/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://172.31.255.255/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://192.168.1.1/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSafeWebPushEndpoint('https://100.64.0.1/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://0.0.0.0/x')).toBe(false);
  });

  it('rejects loopback / ULA / link-local IPv6', () => {
    expect(isSafeWebPushEndpoint('https://[::1]/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://[fd00::1]/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://[fe80::1]/x')).toBe(false);
    expect(isSafeWebPushEndpoint('https://[::ffff:127.0.0.1]/x')).toBe(false);
  });

  it('allows public IPs just outside the private ranges', () => {
    expect(isSafeWebPushEndpoint('https://172.15.0.1/x')).toBe(true);
    expect(isSafeWebPushEndpoint('https://172.32.0.1/x')).toBe(true);
    expect(isSafeWebPushEndpoint('https://11.0.0.1/x')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isSafeWebPushEndpoint('not a url')).toBe(false);
    expect(isSafeWebPushEndpoint('')).toBe(false);
  });
});

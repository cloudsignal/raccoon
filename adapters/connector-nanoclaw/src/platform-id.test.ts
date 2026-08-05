import { describe, expect, it } from 'vitest';
import { fromPlatformId, toPlatformId } from './platform-id.js';

describe('platform-id', () => {
  it('round-trips', () => {
    expect(fromPlatformId(toPlatformId('assistant', 'user-1'))).toEqual({ channel: 'assistant', userId: 'user-1' });
  });
  it('splits on the FIRST colon so userIds may contain colons', () => {
    expect(fromPlatformId('assistant:u:2')).toEqual({ channel: 'assistant', userId: 'u:2' });
  });
  it('rejects malformed ids', () => {
    expect(fromPlatformId('no-colon')).toBeNull();
    expect(fromPlatformId(':user')).toBeNull();
    expect(fromPlatformId('chan:')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { MEDIA_PATH_RE, PROTOCOL_VERSION, attachmentSchema, createEnvelope, parseEnvelope, tryParseEnvelope } from './envelope.js';

describe('envelope', () => {
  it('creates a msg envelope with protocol version, ulid id and ISO ts', () => {
    const env = createEnvelope('msg', {
      from: 'user:u1',
      to: 'agent:coordinator',
      channel: 'coordinator',
      payload: { text: 'hello' },
    });
    expect(env.raccoon).toBe(PROTOCOL_VERSION);
    expect(env.kind).toBe('msg');
    expect(env.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Number.isNaN(Date.parse(env.ts))).toBe(false);
  });

  it('round-trips through JSON + parseEnvelope', () => {
    const env = createEnvelope('ack', {
      from: 'agent:coordinator',
      to: 'user:u1',
      channel: 'coordinator',
      payload: { refId: 'abc', status: 'delivered' },
    });
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(env)));
    expect(parsed).toEqual(env);
  });

  it('accepts a stalled ack status (#P1-A) and a pair.confirm envelope (#P1-C)', () => {
    const stalled = createEnvelope('ack', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'abc', status: 'stalled' },
    });
    expect(parseEnvelope(JSON.parse(JSON.stringify(stalled))).payload).toEqual({ refId: 'abc', status: 'stalled' });

    const confirm = createEnvelope('pair.confirm', {
      from: 'system', to: 'system', channel: 'pairing',
      payload: { sessionToken: 'sess-1' },
    });
    expect(confirm.kind).toBe('pair.confirm');
    expect(parseEnvelope(JSON.parse(JSON.stringify(confirm)))).toEqual(confirm);
    // pair.confirm requires a non-empty sessionToken.
    expect(tryParseEnvelope({ ...confirm, payload: { sessionToken: '' } })).toBeNull();
  });

  it('rejects unknown kind', () => {
    expect(() =>
      parseEnvelope({ raccoon: '0.1', id: 'x', kind: 'nope', from: 'system', to: 'user:u1', channel: 'c', ts: new Date().toISOString(), payload: {} }),
    ).toThrow();
  });

  it('rejects msg without text', () => {
    const env = createEnvelope('msg', {
      from: 'user:u1', to: 'agent:a', channel: 'c', payload: { text: 'x' },
    });
    const bad = { ...env, payload: {} };
    expect(tryParseEnvelope(bad)).toBeNull();
  });

  it('rejects bad address', () => {
    const env = createEnvelope('typing', {
      from: 'user:u1', to: 'agent:a', channel: 'c', payload: { state: 'start' },
    });
    expect(tryParseEnvelope({ ...env, from: 'robot:u1' })).toBeNull();
  });
});

describe('msg attachments (media upload)', () => {
  const A_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'; // 26 chars, ulid alphabet
  const okAttachment = { url: `/media/${A_ID}/photo.jpg`, mime: 'image/jpeg', name: 'photo.jpg', size: 1234 };

  it('accepts a hub-issued media path and round-trips through createEnvelope', () => {
    const env = createEnvelope('msg', {
      from: 'user:u1', to: 'agent:atlas', channel: 'atlas',
      payload: { text: 'look at this', attachments: [okAttachment] },
    });
    expect(env.payload.attachments?.[0]).toEqual(okAttachment);
  });

  it('rejects absolute URLs, localhost, traversal, meta.json-less ids, and overlong names', () => {
    for (const url of [
      'https://evil.example/x.png',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost:8790/media/x/y',
      `/media/${A_ID}/../../etc/passwd`,
      '/media/short/x.png',
      `/media/${A_ID}/${'a'.repeat(81)}`,
      `/media/${A_ID}/`,
    ]) {
      expect(attachmentSchema.safeParse({ url, mime: 'image/png' }).success).toBe(false);
    }
  });

  it('allows empty text WITH attachments, rejects empty text WITHOUT', () => {
    expect(() => createEnvelope('msg', {
      from: 'user:u1', to: 'agent:atlas', channel: 'atlas',
      payload: { text: '', attachments: [okAttachment] },
    })).not.toThrow();
    expect(() => createEnvelope('msg', {
      from: 'user:u1', to: 'agent:atlas', channel: 'atlas',
      payload: { text: '' },
    })).toThrow();
  });

  it('caps attachments at 4', () => {
    expect(() => createEnvelope('msg', {
      from: 'user:u1', to: 'agent:atlas', channel: 'atlas',
      payload: { text: 'x', attachments: [okAttachment, okAttachment, okAttachment, okAttachment, okAttachment] },
    })).toThrow();
  });

  it('HistoryMessage round-trips attachments', () => {
    const env = createEnvelope('history.page', {
      from: 'system', to: 'user:u1', channel: 'atlas',
      payload: {
        channel: 'atlas',
        messages: [{ id: 'm1', role: 'user', text: '', ts: new Date().toISOString(), attachments: [okAttachment] }],
      },
    });
    expect(env.payload.messages[0]!.attachments?.[0]?.url).toBe(okAttachment.url);
  });
});

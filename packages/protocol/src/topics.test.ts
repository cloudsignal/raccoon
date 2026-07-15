import { describe, expect, it } from 'vitest';
import { agentAddress, parseAddress, topicUserInbox, topicUserOutbox, userAddress } from './topics.js';

describe('addresses and topics', () => {
  it('builds and parses addresses', () => {
    expect(userAddress('u1')).toBe('user:u1');
    expect(agentAddress('coordinator')).toBe('agent:coordinator');
    expect(parseAddress('user:u1')).toEqual({ type: 'user', id: 'u1' });
    expect(parseAddress('system')).toEqual({ type: 'system', id: null });
  });

  it('formats topics per spec', () => {
    expect(topicUserInbox('acme', 'u1')).toBe('raccoon/acme/users/u1/inbox');
    expect(topicUserOutbox('acme', 'u1')).toBe('raccoon/acme/users/u1/outbox');
  });

  it('rejects ids with topic-breaking characters', () => {
    expect(() => topicUserInbox('acme', 'a/b')).toThrow();
    expect(() => topicUserInbox('a+b', 'u1')).toThrow();
  });
});

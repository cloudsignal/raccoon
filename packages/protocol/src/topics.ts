import type { Address } from './envelope.js';

// MQTT-unsafe characters in a single topic level.
const SAFE_SEGMENT = /^[^\s/+#]+$/;

function assertSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} contains characters not allowed in a topic segment: ${value}`);
  }
}

export function userAddress(id: string): Address {
  return `user:${id}`;
}

export function agentAddress(id: string): Address {
  return `agent:${id}`;
}

export function parseAddress(a: Address): { type: 'user' | 'agent' | 'system'; id: string | null } {
  if (a === 'system') return { type: 'system', id: null };
  const [type, ...rest] = a.split(':');
  return { type: type as 'user' | 'agent', id: rest.join(':') };
}

export function topicUserInbox(instance: string, userId: string): string {
  assertSegment(instance, 'instance');
  assertSegment(userId, 'userId');
  return `raccoon/${instance}/users/${userId}/inbox`;
}

export function topicUserOutbox(instance: string, userId: string): string {
  assertSegment(instance, 'instance');
  assertSegment(userId, 'userId');
  return `raccoon/${instance}/users/${userId}/outbox`;
}

export function topicUserPresence(instance: string, userId: string): string {
  assertSegment(instance, 'instance');
  assertSegment(userId, 'userId');
  return `raccoon/${instance}/users/${userId}/presence`;
}

import { describe, expect, it } from 'vitest';
import { createEnvelope } from '@raccoon/protocol';
import { chatReducer, emptyChatState, type ChatMessage, type ChatState } from './messages.js';

const agentMsg = (text: string) => createEnvelope('msg', {
  from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text },
});

const optimistic = (id: string, text: string, ts: string): ChatMessage => ({
  id, channel: 'coordinator', role: 'user', sender: 'you', kind: 'text', text, ts, delivery: 'pending',
});

describe('chatReducer', () => {
  it('hydrates history with unread computed from lastRead', () => {
    const state = chatReducer(emptyChatState, {
      type: 'history',
      channel: 'coordinator',
      agentId: 'coordinator',
      messages: [
        { id: 'h1', role: 'agent', text: 'old', ts: '2026-07-04T08:00:00.000Z' },
        { id: 'h2', role: 'user', text: 'mine', ts: '2026-07-04T08:30:00.000Z' },
        { id: 'h3', role: 'agent', text: 'new', ts: '2026-07-04T09:00:00.000Z' },
      ],
      nextBefore: 'h1',
      lastRead: '2026-07-04T08:45:00.000Z',
    });
    expect(state.messages['coordinator']!.map((m) => m.id)).toEqual(['h1', 'h2', 'h3']);
    expect(state.messages['coordinator']![0]!.sender).toBe('coordinator');
    expect(state.unread['coordinator']).toBe(1);
    expect(state.nextBefore['coordinator']).toBe('h1');
    expect(state.historyLoaded['coordinator']).toBe(true);
  });

  it('bumps unread for agent messages caught up on a background reconnect, not while viewing (#4/#10)', () => {
    // First load while active: establishes the channel with no unread.
    let state = chatReducer(emptyChatState, {
      type: 'history', channel: 'coordinator', agentId: 'coordinator',
      messages: [{ id: 'h1', role: 'agent', text: 'seen', ts: '2026-07-04T08:00:00.000Z' }],
      lastRead: '2026-07-04T08:00:00.000Z', active: true,
    });
    expect(state.unread['coordinator'] ?? 0).toBe(0);

    // Reconnect catch-up on a BACKGROUND channel surfaces a newer agent message
    // that was missed while offline -> it counts toward the unread badge.
    state = chatReducer(state, {
      type: 'history', channel: 'coordinator', agentId: 'coordinator',
      messages: [
        { id: 'h1', role: 'agent', text: 'seen', ts: '2026-07-04T08:00:00.000Z' }, // deduped
        { id: 'h2', role: 'agent', text: 'missed', ts: '2026-07-04T09:00:00.000Z' },
      ],
      lastRead: '2026-07-04T08:00:00.000Z', active: false,
    });
    expect(state.unread['coordinator']).toBe(1);

    // The same catch-up while the channel is ACTIVE (being viewed) must not bump.
    state = chatReducer(state, {
      type: 'history', channel: 'coordinator', agentId: 'coordinator',
      messages: [{ id: 'h3', role: 'agent', text: 'while-viewing', ts: '2026-07-04T09:30:00.000Z' }],
      lastRead: '2026-07-04T08:00:00.000Z', active: true,
    });
    expect(state.unread['coordinator']).toBe(1);
  });

  it('appends live agent messages, dedupes, clears typing, counts unread when inactive', () => {
    const env = agentMsg('hello');
    let state: ChatState = { ...emptyChatState, typing: { coordinator: true } };
    state = chatReducer(state, { type: 'message', env, active: false });
    state = chatReducer(state, { type: 'message', env, active: false });
    expect(state.messages['coordinator']).toHaveLength(1);
    expect(state.typing['coordinator']).toBe(false);
    expect(state.unread['coordinator']).toBe(1);
    state = chatReducer(state, { type: 'read-channel', channel: 'coordinator' });
    expect(state.unread['coordinator']).toBe(0);
  });

  it('tracks optimistic sends through ack to delivery', () => {
    let state = chatReducer(emptyChatState, { type: 'optimistic', msg: optimistic('m1', 'hi', '2026-07-04T09:12:00.000Z') });
    expect(state.messages['coordinator']![0]!.delivery).toBe('pending');
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'm1', status: 'received' });
    expect(state.messages['coordinator']![0]!.delivery).toBe('sent');
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'm1', status: 'read' });
    expect(state.messages['coordinator']![0]!.delivery).toBe('read');
  });

  it('stores approval requests as approval messages and records responses', () => {
    const env = createEnvelope('approval.request', {
      from: 'agent:assistant', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-9', title: 'Draft reply', description: 'We run Raccoon...', options: ['approve', 'edit', 'skip'] },
    });
    let state = chatReducer(emptyChatState, { type: 'approval', env, active: true });
    const msg = state.messages['coordinator']![0]!;
    expect(msg.kind).toBe('approval');
    expect(msg.sender).toBe('assistant');
    expect(msg.approval!.options).toEqual(['approve', 'edit', 'skip']);
    expect(state.unread['coordinator'] ?? 0).toBe(0);
    state = chatReducer(state, { type: 'responded', channel: 'coordinator', refId: 'task-9', choice: 'approve', responseId: 'resp-1' });
    expect(state.messages['coordinator']![0]!.respondedChoice).toBe('approve');
  });

  it('tracks approval-response delivery via responseEnvId through ack and failure (#R2-5)', () => {
    const env = createEnvelope('approval.request', {
      from: 'agent:assistant', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-9', title: 'Draft reply', description: 'We run Raccoon...', options: ['approve', 'edit', 'skip'] },
    });
    let state = chatReducer(emptyChatState, { type: 'approval', env, active: true });
    state = chatReducer(state, { type: 'responded', channel: 'coordinator', refId: 'task-9', choice: 'approve', responseId: 'resp-1' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('pending');
    expect(state.messages['coordinator']![0]!.responseEnvId).toBe('resp-1');

    // An ack whose refId is the RESPONSE envelope's id (not the original
    // approval.request's refId) must resolve to 'delivered' via responseEnvId.
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'received' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('sent');

    // A delivery-failed event keyed by the same response envelope id marks it failed.
    state = chatReducer(state, { type: 'delivery', channel: 'coordinator', id: 'resp-1', delivery: 'failed' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('failed');
  });

  it('sorts merged history + live by ts', () => {
    let state = chatReducer(emptyChatState, { type: 'message', env: agentMsg('live'), active: true });
    state = chatReducer(state, {
      type: 'history', channel: 'coordinator', agentId: 'coordinator',
      messages: [{ id: 'h1', role: 'agent', text: 'older', ts: '2020-01-01T00:00:00.000Z' }],
    });
    expect(state.messages['coordinator']![0]!.id).toBe('h1');
  });

  it('drops intra-batch duplicate ids in one history page', () => {
    const state = chatReducer(emptyChatState, {
      type: 'history', channel: 'coordinator', agentId: 'coordinator',
      messages: [
        { id: 'dup', role: 'agent', text: 'one', ts: '2026-07-04T08:00:00.000Z' },
        { id: 'dup', role: 'agent', text: 'one', ts: '2026-07-04T08:00:00.000Z' },
      ],
    });
    expect(state.messages['coordinator']).toHaveLength(1);
  });
});

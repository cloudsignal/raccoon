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

  it('reconcile-responses rehydrates a failed response onto a history-loaded approval, but never clobbers live state (#R7-2)', () => {
    // Simulate a reload: history brings back the approval REQUEST with no
    // local response state.
    const env = createEnvelope('approval.request', {
      from: 'agent:assistant', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-9', title: 'Draft', description: 'body', options: ['approve', 'edit'] },
    });
    let state = chatReducer(emptyChatState, { type: 'approval', env, active: false });
    expect(state.messages['coordinator']![0]!.respondedChoice).toBeUndefined();

    // A durable failed outbox row rehydrates the responded/failed state → the
    // retry card can render.
    state = chatReducer(state, {
      type: 'reconcile-responses',
      channel: 'coordinator',
      responses: [{ refId: 'task-9', choice: 'edit', responseId: 'resp-1', editedText: 'my draft', delivery: 'failed' }],
    });
    const m = state.messages['coordinator']![0]!;
    expect(m.respondedChoice).toBe('edit');
    expect(m.respondedDelivery).toBe('failed');
    expect(m.responseEnvId).toBe('resp-1');
    expect(m.respondedEditedText).toBe('my draft');

    // A second reconcile must NOT clobber the (now live) response state.
    state = chatReducer(state, {
      type: 'reconcile-responses',
      channel: 'coordinator',
      responses: [{ refId: 'task-9', choice: 'approve', responseId: 'resp-2', delivery: 'sent' }],
    });
    expect(state.messages['coordinator']![0]!.respondedChoice).toBe('edit'); // unchanged
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

  it('a stale received ack does not un-fail a failed response, but a real delivered still recovers it (#R8-2)', () => {
    const env = createEnvelope('approval.request', {
      from: 'agent:assistant', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-9', title: 'Draft', description: 'x', options: ['approve'] },
    });
    let state = chatReducer(emptyChatState, { type: 'approval', env, active: true });
    state = chatReducer(state, { type: 'responded', channel: 'coordinator', refId: 'task-9', choice: 'approve', responseId: 'resp-1' });
    // Terminal failure (server or client processing-timeout).
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'failed' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('failed');

    // A DELAYED 'received' ack (reordered from the original send) must not
    // flip failed back to sent and hide the retry affordance.
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'received' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('failed');

    // A genuine 'delivered' (the turn actually succeeded) has higher rank and
    // still recovers the row out of failed.
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'delivered' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('delivered');

    // A late 'failed' can no longer regress a real 'delivered'.
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'failed' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('delivered');
  });

  it('a stalled ack is terminal-non-retryable: a stale received cannot un-stall it, delivered still recovers (#P1-A)', () => {
    const env = createEnvelope('approval.request', {
      from: 'agent:assistant', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-9', title: 'Draft', description: 'x', options: ['approve'] },
    });
    let state = chatReducer(emptyChatState, { type: 'approval', env, active: true });
    state = chatReducer(state, { type: 'responded', channel: 'coordinator', refId: 'task-9', choice: 'approve', responseId: 'resp-1' });
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'stalled' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('stalled');
    // A delayed 'received' must NOT downgrade a stalled row back to 'sent'
    // (which would re-arm the auto-retry the client suppresses for stalled).
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'received' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('stalled');
    // But a genuine 'delivered' (higher rank) still recovers a stalled row.
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'delivered' });
    expect(state.messages['coordinator']![0]!.respondedDelivery).toBe('delivered');
  });

  it('a late timeout-failure regresses delivered via the UNGATED delivery path but not via the monotonic ack path (#P1-E4)', () => {
    const env = createEnvelope('approval.request', {
      from: 'agent:assistant', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-9', title: 'Draft', description: 'x', options: ['approve'] },
    });
    let base = chatReducer(emptyChatState, { type: 'approval', env, active: true });
    base = chatReducer(base, { type: 'responded', channel: 'coordinator', refId: 'task-9', choice: 'approve', responseId: 'resp-1' });
    base = chatReducer(base, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'delivered' });
    expect(base.messages['coordinator']![0]!.respondedDelivery).toBe('delivered');

    // The OLD routing dispatched the processing-timeout failure through the
    // UNGATED 'delivery' action, which regresses a real 'delivered' → 'failed'
    // (a false retry). This is the hazard #P1-E4 removes:
    const viaDelivery = chatReducer(base, { type: 'delivery', channel: 'coordinator', id: 'resp-1', delivery: 'failed' });
    expect(viaDelivery.messages['coordinator']![0]!.respondedDelivery).toBe('failed');

    // The NEW routing goes through the MONOTONIC 'ack' path, where a late
    // 'failed' (rank 2) cannot regress a genuine 'delivered' (rank 3):
    const viaAck = chatReducer(base, { type: 'ack', channel: 'coordinator', refId: 'resp-1', status: 'failed' });
    expect(viaAck.messages['coordinator']![0]!.respondedDelivery).toBe('delivered');
  });

  it('retry (delivery reset) re-opens the monotonic gate so a fresh received advances again (#R8-2)', () => {
    const id = 'out-1';
    let state = chatReducer(emptyChatState, { type: 'optimistic', msg: optimistic(id, 'hi', '2020-01-01T00:00:00.000Z') });
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: id, status: 'failed' });
    expect(state.messages['coordinator']![0]!.delivery).toBe('failed');
    // User retry uses the 'delivery' action (ungated) to reset to pending...
    state = chatReducer(state, { type: 'delivery', channel: 'coordinator', id, delivery: 'pending' });
    expect(state.messages['coordinator']![0]!.delivery).toBe('pending');
    // ...and the resend's fresh 'received' legitimately advances pending→sent.
    state = chatReducer(state, { type: 'ack', channel: 'coordinator', refId: id, status: 'received' });
    expect(state.messages['coordinator']![0]!.delivery).toBe('sent');
  });

  it('reconcile-approvals replaces a history text row with the interactive card (#R8-1)', () => {
    const env = createEnvelope('approval.request', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-9', title: 'Draft', description: 'approve this?', options: ['approve', 'skip'] },
    });
    // Reload: history reconstructed the approval only as a text row (same id).
    let state = chatReducer(emptyChatState, {
      type: 'history', channel: 'coordinator', agentId: 'coordinator',
      messages: [{ id: env.id, role: 'agent', text: 'approve this?', ts: env.ts }],
    });
    expect(state.messages['coordinator']![0]!.kind).toBe('text');

    state = chatReducer(state, { type: 'reconcile-approvals', channel: 'coordinator', approvals: [env] });
    const m = state.messages['coordinator']![0]!;
    expect(m.kind).toBe('approval');
    expect(m.approval?.refId).toBe('task-9');
    expect(m.approval?.options).toEqual(['approve', 'skip']);
    // No duplicate row for the same id.
    expect(state.messages['coordinator']).toHaveLength(1);
  });

  it('reconcile-approvals does NOT clobber a live approval card with response state (#R8-1)', () => {
    const env = createEnvelope('approval.request', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-9', title: 'Draft', description: 'x', options: ['approve'] },
    });
    let state = chatReducer(emptyChatState, { type: 'approval', env, active: true });
    state = chatReducer(state, { type: 'responded', channel: 'coordinator', refId: 'task-9', choice: 'approve', responseId: 'resp-1' });
    // A reconnect re-runs reconcile-approvals; the live card's in-memory
    // response state must survive.
    state = chatReducer(state, { type: 'reconcile-approvals', channel: 'coordinator', approvals: [env] });
    expect(state.messages['coordinator']![0]!.respondedChoice).toBe('approve');
    expect(state.messages['coordinator']![0]!.responseEnvId).toBe('resp-1');
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

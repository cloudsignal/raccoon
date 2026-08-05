import { describe, expect, it } from 'vitest';
import { buildApprovalEnvelope, createApprovalValueStore, extractQuestionCard } from './approvals.js';
import type { OutboundMessage } from './nanoclaw-types.js';

const CARD: OutboundMessage = {
  kind: 'chat',
  content: {
    type: 'ask_question',
    questionId: 'q-123',
    title: 'Deploy?',
    question: 'Deploy v2 to prod now?',
    options: [
      { label: 'Yes', selectedLabel: 'Yes', value: 'deploy-now' },
      { label: 'No', selectedLabel: 'No', value: 'abort' },
    ],
  },
};

describe('extractQuestionCard', () => {
  it('extracts a full card', () => {
    const card = extractQuestionCard(CARD)!;
    expect(card.questionId).toBe('q-123');
    expect(card.title).toBe('Deploy?');
    expect(card.question).toBe('Deploy v2 to prod now?');
    expect(card.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('defaults a missing option value to its label', () => {
    const msg: OutboundMessage = {
      kind: 'chat',
      content: { type: 'ask_question', questionId: 'q-1', title: 'T', question: '', options: [{ label: 'OK' }] },
    };
    expect(extractQuestionCard(msg)!.options[0]).toMatchObject({ label: 'OK', value: 'OK' });
  });

  it('returns null for non-cards and defective cards', () => {
    expect(extractQuestionCard({ kind: 'chat', content: { text: 'plain' } })).toBeNull();
    expect(extractQuestionCard({ kind: 'chat', content: null })).toBeNull();
    expect(extractQuestionCard({ kind: 'chat', content: { type: 'ask_question', title: 'T', options: [{ label: 'A' }] } })).toBeNull(); // no questionId
    expect(extractQuestionCard({ kind: 'chat', content: { type: 'ask_question', questionId: 'q', options: [{ label: 'A' }] } })).toBeNull(); // no title
    expect(extractQuestionCard({ kind: 'chat', content: { type: 'ask_question', questionId: 'q', title: 'T', options: [] } })).toBeNull();
  });

  it('rejects duplicate labels (label-addressed buttons cannot disambiguate)', () => {
    expect(extractQuestionCard({
      kind: 'chat',
      content: {
        type: 'ask_question', questionId: 'q', title: 'T', question: '',
        options: [{ label: 'Yes', value: 'a' }, { label: 'Yes', value: 'b' }],
      },
    })).toBeNull();
  });
});

describe('buildApprovalEnvelope', () => {
  it('builds a valid approval.request: refId = questionId, options = labels', () => {
    const env = buildApprovalEnvelope('assistant', 'u1', extractQuestionCard(CARD)!);
    expect(env.kind).toBe('approval.request');
    expect(env.channel).toBe('assistant');
    expect(env.payload).toEqual({
      refId: 'q-123',
      title: 'Deploy?',
      description: 'Deploy v2 to prod now?',
      options: ['Yes', 'No'],
    });
  });
});

describe('ApprovalValueStore', () => {
  it('maps a chosen label back to the option value', () => {
    const store = createApprovalValueStore();
    store.remember('q-123', extractQuestionCard(CARD)!.options);
    expect(store.resolveValue('q-123', 'Yes')).toBe('deploy-now');
    expect(store.resolveValue('q-123', 'No')).toBe('abort');
  });

  it('fails closed on unknown refIds or labels', () => {
    const store = createApprovalValueStore();
    expect(store.resolveValue('nope', 'Yes')).toBeNull();
    store.remember('q-1', [{ label: 'A', selectedLabel: 'A', value: 'a-value' }]);
    expect(store.resolveValue('q-1', 'B')).toBeNull();
  });

  it('evicts oldest entries past the cap; evicted entries fail closed', () => {
    const store = createApprovalValueStore(2);
    store.remember('q-1', [{ label: 'A', selectedLabel: 'A', value: 'v1' }]);
    store.remember('q-2', [{ label: 'A', selectedLabel: 'A', value: 'v2' }]);
    store.remember('q-3', [{ label: 'A', selectedLabel: 'A', value: 'v3' }]);
    expect(store.resolveValue('q-1', 'A')).toBeNull(); // evicted
    expect(store.resolveValue('q-3', 'A')).toBe('v3');
  });
});

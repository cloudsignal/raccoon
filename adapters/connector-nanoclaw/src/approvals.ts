import { agentAddress, createEnvelope, userAddress, type Envelope } from '@raccoon/protocol';
import type { AskQuestionContent, NormalizedOption, OutboundMessage } from './nanoclaw-types.js';

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** Null unless this OutboundMessage carries a well-formed ask_user_question
 *  card. Shape per their ask-question.ts (normalized before delivery):
 *  content = { type:'ask_question', questionId, title, question, options }. */
export function extractQuestionCard(msg: OutboundMessage): AskQuestionContent | null {
  const c = msg.content;
  if (c === null || typeof c !== 'object') return null;
  const raw = c as Record<string, unknown>;
  if (raw['type'] !== 'ask_question') return null;
  const questionId = nonEmpty(raw['questionId']);
  const title = nonEmpty(raw['title']);
  if (!questionId || !title) return null;
  const options: NormalizedOption[] = (Array.isArray(raw['options']) ? raw['options'] : [])
    .map((o): NormalizedOption | null => {
      if (o === null || typeof o !== 'object') return null;
      const opt = o as Record<string, unknown>;
      const label = nonEmpty(opt['label']);
      if (!label) return null;
      return {
        label,
        selectedLabel: nonEmpty(opt['selectedLabel']) ?? label,
        value: nonEmpty(opt['value']) ?? label,
      };
    })
    .filter((o): o is NormalizedOption => o !== null);
  if (options.length === 0) return null;
  // Raccoon approval buttons are label-addressed: duplicate labels cannot be
  // disambiguated on the way back. Fail closed — reject the whole card.
  if (new Set(options.map((o) => o.label)).size !== options.length) {
    console.error(`raccoon: rejecting ask_question ${questionId} — duplicate option labels`);
    return null;
  }
  return { type: 'ask_question', questionId, title, question: nonEmpty(raw['question']) ?? '', options };
}

/** refId = NanoClaw questionId: the approval.response comes back with the
 *  same refId in ctx.approval; the runner answers via onAction(refId,
 *  <option VALUE resolved from the chosen label>, userId). */
export function buildApprovalEnvelope(
  channel: string,
  userId: string,
  card: AskQuestionContent,
): Envelope<'approval.request'> {
  return createEnvelope('approval.request', {
    from: agentAddress(channel),
    to: userAddress(userId),
    channel,
    payload: {
      refId: card.questionId,
      title: card.title,
      description: card.question,
      options: card.options.map((o) => o.label),
    },
  });
}

/** Label→value correlation for in-flight cards. Raccoon buttons carry labels;
 *  NanoClaw's onAction consumes values (the host forwards selectedOption
 *  verbatim as the response value). Bounded FIFO. FAIL CLOSED on a miss
 *  (evicted refId, post-restart response, unknown label): answering with a
 *  guessed value could silently pick the wrong action on cards whose values
 *  differ from their labels — the runner refuses to answer instead. */
export interface ApprovalValueStore {
  remember(refId: string, options: NormalizedOption[]): void;
  resolveValue(refId: string, chosenLabel: string): string | null;
}

export function createApprovalValueStore(cap = 200): ApprovalValueStore {
  const entries = new Map<string, Map<string, string>>();
  return {
    remember(refId, options) {
      if (entries.size >= cap) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(refId, new Map(options.map((o) => [o.label, o.value])));
    },
    resolveValue(refId, chosenLabel) {
      return entries.get(refId)?.get(chosenLabel) ?? null;
    },
  };
}

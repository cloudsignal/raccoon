import type { InboundMessage } from '../nanoclaw-types.js';
import type { HostCallbacks } from '../runner.js';

export interface FakeHost {
  callbacks: HostCallbacks;
  inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }>;
  actions: Array<{ questionId: string; selectedOption: string; userId: string }>;
}

export function createFakeHost(): FakeHost {
  const inbound: FakeHost['inbound'] = [];
  const actions: FakeHost['actions'] = [];
  const callbacks: HostCallbacks = {
    onInbound: (platformId, threadId, message) => { inbound.push({ platformId, threadId, message }); },
    onAction: (questionId, selectedOption, userId) => { actions.push({ questionId, selectedOption, userId }); },
  };
  return { callbacks, inbound, actions };
}

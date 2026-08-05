import { describe, expect, it } from 'vitest';
import type { AgentContext } from '@raccoon/bridge';
import { buildNanoClawRunner } from './runner.js';
import { createTurnStore } from './turns.js';
import { createApprovalValueStore } from './approvals.js';
import { createFakeHost } from './test-helpers/fake-host.js';
import type { InboundChatContent } from './nanoclaw-types.js';

const ORIGIN = 'http://host.docker.internal:8790';

function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
  return { userId: 'u1', channel: 'assistant', text: 'hello', messageId: 'm1', ...overrides };
}

function deps(host: ReturnType<typeof createFakeHost>, turnTimeoutMs = 1000) {
  const turns = createTurnStore();
  const approvalValues = createApprovalValueStore();
  return {
    turns,
    approvalValues,
    runner: buildNanoClawRunner({ host: () => host.callbacks, turns, approvalValues, publicOrigin: ORIGIN, turnTimeoutMs }),
  };
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('buildNanoClawRunner', () => {
  it('forwards a complete NanoClaw InboundMessage and yields the settled reply', async () => {
    const host = createFakeHost();
    const d = deps(host);
    const iterP = collect(d.runner.run(ctx()));
    await tick();
    expect(host.inbound).toHaveLength(1);
    const m = host.inbound[0]!;
    expect(m.platformId).toBe('assistant:u1');
    expect(m.threadId).toBeNull();
    expect(m.message.id).toBe('m1');
    expect(m.message.kind).toBe('chat');
    expect(m.message.isMention).toBe(true);   // required for router auto-create
    expect(m.message.isGroup).toBe(false);
    expect(typeof m.message.timestamp).toBe('string');
    const content = m.message.content as InboundChatContent;
    expect(content).toMatchObject({ senderId: 'u1', text: 'hello', isFromMe: false });
    expect(content.attachments).toBeUndefined();
    expect(d.turns.settle('assistant:u1', 'hi there')).toBe(true);
    await expect(iterP).resolves.toEqual(['hi there']);
  });

  it('serializes turns per conversation: second turn forwards only after the first settles', async () => {
    const host = createFakeHost();
    const d = deps(host);
    const first = collect(d.runner.run(ctx({ text: 'one', messageId: 'm1' })));
    const second = collect(d.runner.run(ctx({ text: 'two', messageId: 'm2' })));
    await tick();
    expect(host.inbound).toHaveLength(1); // second is queued, not forwarded
    d.turns.settle('assistant:u1', 'reply-one');
    await expect(first).resolves.toEqual(['reply-one']);
    await tick();
    expect(host.inbound).toHaveLength(2); // now the second went out
    d.turns.settle('assistant:u1', 'reply-two');
    await expect(second).resolves.toEqual(['reply-two']);
  });

  it('does not serialize across different conversations', async () => {
    const host = createFakeHost();
    const d = deps(host);
    const a = collect(d.runner.run(ctx({ userId: 'u1' })));
    const b = collect(d.runner.run(ctx({ userId: 'u2' })));
    await tick();
    expect(host.inbound).toHaveLength(2);
    d.turns.settle('assistant:u1', 'ra');
    d.turns.settle('assistant:u2', 'rb');
    await expect(a).resolves.toEqual(['ra']);
    await expect(b).resolves.toEqual(['rb']);
  });

  it('routes an approval turn to onAction with the option VALUE', async () => {
    const host = createFakeHost();
    const d = deps(host);
    d.approvalValues.remember('q-1', [{ label: 'Yes', selectedLabel: 'Yes', value: 'deploy-now' }]);
    const iterP = collect(d.runner.run(ctx({ text: 'Yes', approval: { refId: 'q-1', choice: 'Yes' } })));
    await tick();
    expect(host.actions).toEqual([{ questionId: 'q-1', selectedOption: 'deploy-now', userId: 'u1' }]);
    expect(host.inbound).toHaveLength(0);
    d.turns.settle('assistant:u1', 'deployed');
    await expect(iterP).resolves.toEqual(['deployed']);
  });

  it('maps attachments and absolutizes media paths in text', async () => {
    const host = createFakeHost();
    const d = deps(host, 50);
    await collect(d.runner.run(ctx({
      text: 'see /media/01A/x.png',
      attachments: [{ url: '/media/01A/x.png', mime: 'image/png' }],
    })));
    const content = host.inbound[0]!.message.content as InboundChatContent;
    expect(content.text).toBe(`see ${ORIGIN}/media/01A/x.png`);
    expect(content.attachments).toEqual([{ type: 'image', url: `${ORIGIN}/media/01A/x.png` }]);
  });

  it('yields nothing on timeout and releases the conversation chain', async () => {
    const host = createFakeHost();
    const d = deps(host, 20);
    await expect(collect(d.runner.run(ctx({ messageId: 'm1' })))).resolves.toEqual([]);
    const next = collect(d.runner.run(ctx({ messageId: 'm2' })));
    await tick();
    expect(host.inbound).toHaveLength(2); // chain not stuck after a timeout
    d.turns.settle('assistant:u1', 'ok');
    await expect(next).resolves.toEqual(['ok']);
  });

  it('fails closed when the approval value mapping is absent, but tells the user', async () => {
    const host = createFakeHost();
    const d = deps(host, 50);
    // nothing remembered for q-gone — restart/eviction scenario. A silent
    // empty iterator would be acked 'delivered' by the bridge; the runner
    // must yield a visible failure instead of pretending the tap applied.
    await expect(collect(d.runner.run(ctx({ text: 'Yes', approval: { refId: 'q-gone', choice: 'Yes' } }))))
      .resolves.toEqual([
        'This approval could not be applied - the connector lost the option mapping (it may have restarted). Ask the agent to send the question again.',
      ]);
    expect(host.actions).toHaveLength(0); // onAction NOT called with a guessed value
  });

  it('a queued turn re-resolves the host after the mutex — teardown ends it, no stale host', async () => {
    const fake = createFakeHost();
    let live: typeof fake.callbacks | null = fake.callbacks;
    const turns = createTurnStore();
    const runner = buildNanoClawRunner({
      host: () => live, turns, approvalValues: createApprovalValueStore(), publicOrigin: ORIGIN, turnTimeoutMs: 5000,
    });
    const first = collect(runner.run(ctx({ messageId: 'm1' })));
    const queued = collect(runner.run(ctx({ messageId: 'm2' })));
    await tick();
    expect(fake.inbound).toHaveLength(1);
    // teardown: host gone, open turns cancelled
    live = null;
    turns.cancelAll();
    await expect(first).resolves.toEqual([]);           // cancelled turn yields nothing
    await expect(queued).rejects.toThrow(/not set up/); // queued turn sees the CURRENT (null) host
    expect(fake.inbound).toHaveLength(1);               // never forwarded to the stale host
  });

  it('throws before setup', async () => {
    const turns = createTurnStore();
    const runner = buildNanoClawRunner({
      host: () => null, turns, approvalValues: createApprovalValueStore(), publicOrigin: ORIGIN, turnTimeoutMs: 20,
    });
    await expect(collect(runner.run(ctx()))).rejects.toThrow(/not set up/);
  });
});

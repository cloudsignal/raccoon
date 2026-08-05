import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEnvelope, agentAddress, userAddress } from '@raccoon/protocol';
import type { AgentRunner } from '@raccoon/bridge';
import { FileCredentialStore } from '@raccoon/transport-ws';
import { createRaccoonEndpoint } from './endpoint.js';

const echoRunner: AgentRunner = {
  async *run(ctx) { yield `echo: ${ctx.text}`; },
};

function msgEnv(text: string) {
  return createEnvelope('msg', {
    from: agentAddress('assistant'),
    to: userAddress('u1'),
    channel: 'assistant',
    payload: { text },
  });
}

describe('createRaccoonEndpoint', () => {
  it('starts on an ephemeral port, pairs, revokes, stops', async () => {
    const ep = createRaccoonEndpoint({
      instance: 'test', instanceUrl: 'ws://localhost', port: 0,
      channels: ['assistant'], runner: echoRunner,
    });
    const { port } = await ep.start();
    expect(port).toBeGreaterThan(0);
    const pairing = await ep.pair('u1');
    expect(pairing.token.length).toBeGreaterThan(0);
    await ep.revoke('u1'); // must not throw
    await ep.stop();
  });

  it('sendAgentEnvelope records history and reports offline sends', async () => {
    const ep = createRaccoonEndpoint({
      instance: 'test', instanceUrl: 'ws://localhost', port: 0,
      channels: ['assistant'], runner: echoRunner,
    });
    await ep.start();
    const delivered = await ep.sendAgentEnvelope('u1', msgEnv('while you were away'));
    expect(delivered).toBe(false); // no socket connected
    // the message must still be in history (the endpoint's own store), not dropped
    const page = await ep.store.page('assistant', { userId: 'u1', limit: 10 });
    expect(page.messages.some((m) => m.text === 'while you were away')).toBe(true);
    await ep.stop();
  });

  it('releases a FileCredentialStore lock on stop so a restart can reacquire', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-ep-'));
    const mk = () => createRaccoonEndpoint({
      instance: 'test', instanceUrl: 'ws://localhost', port: 0,
      channels: ['assistant'], runner: echoRunner,
      sessionStore: new FileCredentialStore({ path: join(dir, 'sessions.json') }),
    });
    const first = mk();
    await first.start();
    await first.stop();
    const second = mk(); // would throw "already locked" if stop leaked the lock
    await second.start();
    await second.stop();
  });
});

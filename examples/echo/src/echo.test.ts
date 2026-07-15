import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope, parsePairingPayload, type AnyEnvelope } from '@raccoon/protocol';
import { WsClientTransport } from '@raccoon/transport-ws';
import { startDemo } from './echo.js';

let demo: Awaited<ReturnType<typeof startDemo>>;
let staticDir: string;

beforeEach(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'raccoon-demo-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>raccoon</title>');
  writeFileSync(join(staticDir, 'version.json'), '{"buildId":"demo"}');
  demo = await startDemo({ port: 0, staticDir });
});

afterEach(async () => {
  await demo.stop();
  rmSync(staticDir, { recursive: true, force: true });
});

async function connect(userId: string) {
  const { payload } = await demo.pair(userId);
  const parsed = parsePairingPayload(payload);
  const client = new WsClientTransport({ url: parsed.instanceUrl, pairingToken: parsed.token, device: 'e2e' });
  const received: AnyEnvelope[] = [];
  client.onEnvelope((env) => received.push(env));
  await client.connect();
  return { client, received };
}

const until = async (predicate: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('echo demo (Plan C e2e)', () => {
  it('serves the app and version.json on the hub port', async () => {
    const res = await fetch(`http://127.0.0.1:${demo.port}/version.json`);
    expect(await res.json()).toEqual({ buildId: 'demo' });
    const index = await fetch(`http://127.0.0.1:${demo.port}/`);
    expect(await index.text()).toContain('raccoon');
  });

  it('runs the full msg → ack → typing → reply flow and serves history', async () => {
    const { client, received } = await connect('u1');
    await client.send(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:echo', channel: 'echo', payload: { text: 'hi' },
    }));
    await until(() => received.some((e) => e.kind === 'msg'));
    const kinds = received.map((e) => e.kind);
    expect(kinds).toContain('ack');
    expect(kinds).toContain('typing');
    const reply = received.find((e) => e.kind === 'msg');
    expect(reply && reply.kind === 'msg' && reply.payload.text).toBe('echo: hi');

    await client.send(createEnvelope('history.request', {
      from: 'user:u1', to: 'agent:echo', channel: 'echo', payload: { channel: 'echo', limit: 50 },
    }));
    await until(() => received.some((e) => e.kind === 'history.page'));
    const page = received.find((e) => e.kind === 'history.page');
    expect(page && page.kind === 'history.page' && page.payload.messages.map((m) => m.text)).toEqual(['hi', 'echo: hi']);
    await client.close();
  });

  it('serves the approval demo round-trip with editedText', async () => {
    const { client, received } = await connect('u2');
    await client.send(createEnvelope('msg', {
      from: 'user:u2', to: 'agent:echo', channel: 'echo', payload: { text: '/draft' },
    }));
    await until(() => received.some((e) => e.kind === 'approval.request'));
    const request = received.find((e) => e.kind === 'approval.request');
    if (!request || request.kind !== 'approval.request') throw new Error('no approval');
    expect(request.payload.options).toEqual(['approve', 'edit', 'skip']);

    await client.send(createEnvelope('approval.response', {
      from: 'user:u2', to: 'agent:echo', channel: 'echo',
      payload: { refId: request.payload.refId, choice: 'edit', editedText: 'better' },
    }));
    await until(() => received.some((e) => e.kind === 'msg' && e.payload.text === 'Edited: better'));
    await client.close();
  });
});

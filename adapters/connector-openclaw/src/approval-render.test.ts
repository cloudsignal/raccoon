// adapters/openclaw/src/approval-render.test.ts
//
// Unit tests for the exec-approval → Raccoon card renderer (issue #4).
// Uses the REAL openclaw/plugin-sdk/approval-runtime helpers (no mocks):
// what these tests pin down is the ReplyPayload SHAPE the exec-approval
// forwarder hands to outbound.ts — title/text/context blocks and the
// /approve command buttons that deliverPresentation turns into a card.

import { describe, expect, it } from 'vitest';
import type { ExecApprovalRequest, ExecApprovalResolved } from 'openclaw/plugin-sdk/approval-runtime';
import type { MessagePresentation, MessagePresentationButton } from 'openclaw/plugin-sdk/interactive-runtime';
import {
  buildRaccoonExecPendingPayload,
  buildRaccoonExecResolvedPayload,
  createRaccoonApprovalCapability,
  formatExpiresIn,
} from './approval-render.js';

const NOW = 1_700_000_000_000;

function makeRequest(overrides: Partial<ExecApprovalRequest['request']> = {}): ExecApprovalRequest {
  return {
    id: 'apr-123',
    createdAtMs: NOW,
    expiresAtMs: NOW + 30 * 60_000,
    request: {
      command: 'rm -rf ./build && npm run dist',
      agentId: 'main',
      host: 'gateway',
      cwd: '/work',
      ...overrides,
    },
  };
}

function presentationOf(payload: { presentation?: unknown }): MessagePresentation {
  const p = payload.presentation as MessagePresentation;
  expect(Array.isArray(p?.blocks)).toBe(true);
  return p;
}

function buttonsOf(p: MessagePresentation): MessagePresentationButton[] {
  const block = p.blocks.find((b) => b.type === 'buttons');
  expect(block).toBeDefined();
  return (block as { type: 'buttons'; buttons: MessagePresentationButton[] }).buttons;
}

describe('buildRaccoonExecPendingPayload', () => {
  it('renders a titled presentation with the FULL command and /approve command buttons', () => {
    const payload = buildRaccoonExecPendingPayload({ request: makeRequest(), nowMs: NOW });
    const p = presentationOf(payload);

    expect(p.title).toBe('Exec approval required');

    // Full, untruncated command in a text block (an approval card that hides
    // part of the command it approves would be a security bug).
    const texts = p.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    expect(texts).toContain('rm -rf ./build && npm run dist');

    // Compact metadata row.
    const ctxBlock = p.blocks.find((b) => b.type === 'context') as { text: string };
    expect(ctxBlock.text).toContain('Agent: main');
    expect(ctxBlock.text).toContain('Host: gateway');
    expect(ctxBlock.text).toContain('CWD: /work');
    expect(ctxBlock.text).toContain('Expires in 30m');

    // Buttons carry the REAL native slash command per decision — this is the
    // exact action shape outbound.ts resolves to {isCommand: true} choices,
    // which inbound.ts then sends back as a standalone /approve message.
    const buttons = buttonsOf(p);
    expect(buttons.map((b) => b.label)).toEqual(['Allow Once', 'Allow Always', 'Deny']);
    expect(buttons.map((b) => b.action)).toEqual([
      { type: 'command', command: '/approve apr-123 allow-once' },
      { type: 'command', command: '/approve apr-123 allow-always' },
      { type: 'command', command: '/approve apr-123 deny' },
    ]);
  });

  it('omits allow-always when the effective policy disallows it', () => {
    const payload = buildRaccoonExecPendingPayload({
      request: makeRequest({ ask: 'always' }),
      nowMs: NOW,
    });
    const labels = buttonsOf(presentationOf(payload)).map((b) => b.label);
    expect(labels).toEqual(['Allow Once', 'Deny']);
  });

  it('includes the warning text as a leading text block when present', () => {
    const payload = buildRaccoonExecPendingPayload({
      request: makeRequest({ warningText: 'This command deletes files.' }),
      nowMs: NOW,
    });
    const p = presentationOf(payload);
    const firstText = p.blocks.find((b) => b.type === 'text') as { text: string };
    expect(firstText.text).toBe('This command deletes files.');
  });

  it('carries a degraded text fallback with the command and a typable /approve line', () => {
    const payload = buildRaccoonExecPendingPayload({ request: makeRequest(), nowMs: NOW });
    expect(payload.text).toContain('rm -rf ./build && npm run dist');
    expect(payload.text).toContain('/approve apr-123 allow-once|allow-always|deny');
  });

  it('stows the request absolute expiry in channelData for the outbound to align the value-store TTL', () => {
    const request = makeRequest();
    const payload = buildRaccoonExecPendingPayload({ request, nowMs: NOW });
    expect(payload.channelData).toEqual({ raccoonApproval: { expiresAtMs: request.expiresAtMs } });
  });
});

describe('buildRaccoonExecResolvedPayload', () => {
  it.each([
    ['allow-once', 'Exec approval allowed once by demo.'],
    ['allow-always', 'Exec approval allowed always by demo.'],
    ['deny', 'Exec approval denied by demo.'],
  ] as const)('renders %s', (decision, expected) => {
    const resolved: ExecApprovalResolved = { id: 'apr-123', decision, resolvedBy: 'demo', ts: NOW };
    expect(buildRaccoonExecResolvedPayload({ resolved }).text).toBe(expected);
  });

  it('omits the resolver clause when resolvedBy is absent', () => {
    const resolved: ExecApprovalResolved = { id: 'apr-123', decision: 'deny', ts: NOW };
    expect(buildRaccoonExecResolvedPayload({ resolved }).text).toBe('Exec approval denied.');
  });
});

describe('formatExpiresIn', () => {
  it.each([
    [NOW - 1, 'now'],
    [NOW + 30_000, 'in 1m'],
    [NOW + 59 * 60_000, 'in 59m'],
    [NOW + 60 * 60_000, 'in 1h'],
    [NOW + 90 * 60_000, 'in 1h 30m'],
  ])('formats %d as %s', (expiresAtMs, expected) => {
    expect(formatExpiresIn(expiresAtMs, NOW)).toBe(expected);
  });
});

describe('createRaccoonApprovalCapability', () => {
  it('is render-only: exec pending/resolved hooks and NO auth/delivery/native surfaces', () => {
    const cap = createRaccoonApprovalCapability();
    expect(cap.render?.exec?.buildPendingPayload).toBeTypeOf('function');
    expect(cap.render?.exec?.buildResolvedPayload).toBeTypeOf('function');
    // 1:1 paired DM channel: the pairing/allowFrom gate IS the approval
    // authorization — registering authorizeActorAction would ADD a gate the
    // channel doesn't want (OpenClaw defaults to authorized without it).
    expect(cap.authorizeActorAction).toBeUndefined();
    expect(cap.delivery).toBeUndefined();
    expect(cap.nativeRuntime).toBeUndefined();
    expect(cap.native).toBeUndefined();
  });

  it('the capability render hooks produce the same payloads as the direct builders', () => {
    const cap = createRaccoonApprovalCapability();
    const request = makeRequest();
    const viaCap = cap.render!.exec!.buildPendingPayload!({
      cfg: {} as never,
      request,
      target: { channel: 'raccoon', to: 'user:demo' } as never,
      nowMs: NOW,
    });
    expect(viaCap).toEqual(buildRaccoonExecPendingPayload({ request, nowMs: NOW }));

    const resolved: ExecApprovalResolved = { id: 'apr-123', decision: 'allow-once', ts: NOW };
    const viaCapResolved = cap.render!.exec!.buildResolvedPayload!({
      cfg: {} as never,
      resolved,
      target: { channel: 'raccoon', to: 'user:demo' } as never,
    });
    expect(viaCapResolved).toEqual(buildRaccoonExecResolvedPayload({ resolved }));
  });
});

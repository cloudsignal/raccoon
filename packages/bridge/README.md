# @raccoon/bridge

`RaccoonBridge` wires a [Raccoon](https://github.com/cloudsignal/raccoon) hub
to an agent framework. You implement one port — **`AgentRunner`**: run one
user turn, yield the reply as text deltas. The bridge owns everything else:
typing indicators, delivery acks/ticks, failure and stall signaling, dedup,
turn deadlines, and history limits.

```bash
npm install @raccoon/bridge
```

```ts
import { RaccoonBridge, InMemoryMessageStore, type AgentRunner } from '@raccoon/bridge';

const runner: AgentRunner = {
  async *run(ctx) {
    // ctx.text, ctx.userId, ctx.channel, ctx.messageId (+ ctx.approval on approval responses)
    yield `You said: ${ctx.text}`;
  },
};

const bridge = new RaccoonBridge({ hub, runner, store: new InMemoryMessageStore() });
const stop = bridge.start();
```

This is the same port the first-party OpenClaw connector implements — a
second connector (or a managed transport) plugs into core through it without
touching core. See
[connector-authoring.md](https://github.com/cloudsignal/raccoon/blob/main/docs/connector-authoring.md)
for the full port surface and package-boundary diagram.

`MessageStore` is pluggable (`InMemoryMessageStore` ships in the box) for
durable per-conversation history.

MIT © the Raccoon contributors.

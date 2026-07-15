# The Raccoon Protocol v0.1

The Raccoon protocol is a minimal, versioned envelope protocol for conversations between
humans and AI agents. It defines address formats, envelope shapes, and a topic
hierarchy for transport-layer routing. Transports are pluggable; this document covers
the built-in WebSocket transport.

---

## Envelope Fields

Every Raccoon envelope is a JSON object with the following top-level fields:

| Field     | Type                              | Required | Description                                            |
|-----------|-----------------------------------|----------|--------------------------------------------------------|
| `raccoon` | `"0.1"`                           | yes      | Protocol version. Must be the literal string `"0.1"`. |
| `id`      | string (ULID)                     | yes      | Unique envelope identifier. Monotonically sortable.   |
| `kind`    | string (enum, see Kinds below)    | yes      | Discriminates the payload shape.                       |
| `from`    | Address                           | yes      | Sender address (`user:<id>`, `agent:<id>`, `system`). |
| `to`      | Address                           | yes      | Recipient address.                                     |
| `channel` | string                            | yes      | Logical channel name (non-empty).                      |
| `ts`      | ISO 8601 datetime                 | yes      | Send timestamp (UTC, millisecond precision).           |
| `payload` | object                            | yes      | Kind-specific payload; see examples below.             |

**Address format:** `user:<id>` · `agent:<id>` · `system`

---

## Envelope Kinds

Ten kinds are defined in v0.1. Each section shows the payload schema and a complete
valid JSON example (all field names and enum values match the Zod schemas in
`packages/protocol/src/envelope.ts`).

---

### `msg`: Chat message

Payload fields:

| Field         | Type                                                  | Required |
|---------------|-------------------------------------------------------|----------|
| `text`        | string (non-empty)                                    | yes      |
| `attachments` | `Array<{ url: string (url); mime: string }>` | no       |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0AB",
  "kind": "msg",
  "from": "user:u1",
  "to": "agent:coordinator",
  "channel": "coordinator",
  "ts": "2026-07-04T10:15:00.000Z",
  "payload": { "text": "hello" }
}
```

---

### `ack`: Delivery acknowledgement

Payload fields:

| Field    | Type                                         | Required |
|----------|----------------------------------------------|----------|
| `refId`  | string (non-empty); id of the acked envelope  | yes      |
| `status` | `"received"` \| `"delivered"` \| `"read"`   | yes      |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0CD",
  "kind": "ack",
  "from": "agent:coordinator",
  "to": "user:u1",
  "channel": "coordinator",
  "ts": "2026-07-04T10:15:00.100Z",
  "payload": { "refId": "01J1F3ZK9GQ4S8B2VYQ2M5X0AB", "status": "received" }
}
```

---

### `typing`: Typing indicator

Payload fields:

| Field   | Type                       | Required |
|---------|----------------------------|----------|
| `state` | `"start"` \| `"stop"` | yes      |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0EF",
  "kind": "typing",
  "from": "agent:coordinator",
  "to": "user:u1",
  "channel": "coordinator",
  "ts": "2026-07-04T10:15:01.000Z",
  "payload": { "state": "start" }
}
```

---

### `presence`: Online/offline status

Payload fields:

| Field   | Type                            | Required |
|---------|---------------------------------|----------|
| `state` | `"online"` \| `"offline"` | yes      |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0GH",
  "kind": "presence",
  "from": "user:u1",
  "to": "agent:coordinator",
  "channel": "coordinator",
  "ts": "2026-07-04T10:14:59.000Z",
  "payload": { "state": "online" }
}
```

---

### `approval.request`: Agent requests a human decision

Payload fields:

| Field         | Type                    | Required |
|---------------|-------------------------|----------|
| `refId`       | string (non-empty)      | yes      |
| `title`       | string (non-empty)      | yes      |
| `description` | string                  | yes      |
| `options`     | `string[]` (min 1 item) | yes      |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0IJ",
  "kind": "approval.request",
  "from": "agent:coordinator",
  "to": "user:u1",
  "channel": "coordinator",
  "ts": "2026-07-04T10:15:05.000Z",
  "payload": {
    "refId": "01J1F3ZK9GQ4S8B2VYQ2M5X0AB",
    "title": "Post draft to LinkedIn?",
    "description": "The creator agent produced a 280-char post. Approve to publish.",
    "options": ["approve", "reject", "edit"]
  }
}
```

---

### `approval.response`: Human answers an approval request

Payload fields:

| Field    | Type               | Required |
|----------|--------------------|----------|
| `refId`  | string (non-empty); id of the `approval.request` envelope  | yes |
| `choice` | string (non-empty); one of the offered options              | yes |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0KL",
  "kind": "approval.response",
  "from": "user:u1",
  "to": "agent:coordinator",
  "channel": "coordinator",
  "ts": "2026-07-04T10:15:12.000Z",
  "payload": { "refId": "01J1F3ZK9GQ4S8B2VYQ2M5X0IJ", "choice": "approve" }
}
```

---

### `history.request`: Client requests message history

Payload fields:

| Field     | Type                          | Required |
|-----------|-------------------------------|----------|
| `channel` | string (non-empty)            | yes      |
| `before`  | string (cursor, envelope id)  | no       |
| `limit`   | integer 1–200                 | yes      |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0MN",
  "kind": "history.request",
  "from": "user:u1",
  "to": "agent:coordinator",
  "channel": "coordinator",
  "ts": "2026-07-04T10:16:00.000Z",
  "payload": { "channel": "coordinator", "limit": 50 }
}
```

---

### `history.page`: Server returns a page of history

Payload fields:

| Field        | Type                                                                        | Required |
|--------------|-----------------------------------------------------------------------------|----------|
| `channel`    | string (non-empty)                                                          | yes      |
| `messages`   | `Array<{ id: string; role: "user"\|"agent"; text: string; ts: datetime }>` | yes      |
| `nextBefore` | string (cursor for next page)                                               | no       |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0OP",
  "kind": "history.page",
  "from": "agent:coordinator",
  "to": "user:u1",
  "channel": "coordinator",
  "ts": "2026-07-04T10:16:00.050Z",
  "payload": {
    "channel": "coordinator",
    "messages": [
      { "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0AB", "role": "user", "text": "hello", "ts": "2026-07-04T10:15:00.000Z" },
      { "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0QR", "role": "agent", "text": "Hi! How can I help?", "ts": "2026-07-04T10:15:01.500Z" }
    ]
  }
}
```

---

### `pair.request`: Client requests a WebSocket session

Sent as the first message over a new WebSocket connection. Payload fields:

| Field    | Type               | Required |
|----------|--------------------|----------|
| `token`  | string (non-empty); short-lived pairing token  | yes |
| `device` | string (non-empty); client device label        | yes |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0ST",
  "kind": "pair.request",
  "from": "system",
  "to": "system",
  "channel": "pairing",
  "ts": "2026-07-04T10:14:58.000Z",
  "payload": { "token": "dGhpcyBpcyBhIHRva2VuCg", "device": "mobile-safari" }
}
```

---

### `pair.grant`: Server confirms a session

Sent by the hub after a successful `pair.request`. The client stores `sessionToken`
for reconnects. Payload fields:

| Field          | Type               | Required |
|----------------|--------------------|----------|
| `sessionToken` | string (non-empty) | yes      |
| `userId`       | string (non-empty) | yes      |
| `instance`     | string (non-empty) | yes      |
| `channels`     | `string[]`         | yes      |

```json
{
  "raccoon": "0.1",
  "id": "01J1F3ZK9GQ4S8B2VYQ2M5X0UV",
  "kind": "pair.grant",
  "from": "system",
  "to": "user:u1",
  "channel": "pairing",
  "ts": "2026-07-04T10:14:58.050Z",
  "payload": {
    "sessionToken": "sess_abc123xyz",
    "userId": "u1",
    "instance": "echo-example",
    "channels": ["coordinator"]
  }
}
```

---

## Topic Mapping

Raccoon protocol topics follow this hierarchy (used natively over MQTT; the WS transport uses them
as logical routing keys for future bridging):

```
raccoon/{instance}/users/{userId}/inbox    hub → client (agent outbound to user)
raccoon/{instance}/users/{userId}/outbox   client → hub (user inbound to agent)
```

`instance` and `userId` must not contain MQTT wildcard characters (`+`, `#`) or `/`.

---

## WebSocket Transport: Handshake Sequence

The built-in WS transport (`@raccoon/transport-ws`) uses a handshake before envelope
routing begins:

```
Client                              Hub
  |                                  |
  |--- TCP + WS upgrade ----------->|
  |--- pair.request (JSON) -------->|   first message on the socket
  |                                  |
  |<-- { session: "<token>" } ------|   or close 4401/4403/4429 (see below)
  |--- { ok: true, userId: "..." } ->|
  |                                  |
  |<--> envelopes (bidirectional)    |
```

**Pairing tokens** are single-use, short-TTL (default 5 minutes), rate-limited to
10 attempts per minute per IP. The hub issues them out-of-band via
`hub.issuePairingToken(userId)`.

**Session tokens** (returned in `pair.grant`) are long-lived and may be reused for
reconnects, skipping the pairing step.

### Close Codes

| Code   | Meaning                                              |
|--------|------------------------------------------------------|
| `4401` | Unauthorized: pairing token missing, expired, or already used |
| `4403` | Forbidden: user has been revoked                             |
| `4429` | Too Many Requests: rate limit exceeded                       |

---

## Out-of-Band Pairing

Transports MAY substitute the `pair.request` / `pair.grant` envelope exchange with an
out-of-band pairing mechanism. For example, a managed transport can authenticate
users through its own identity/claims API; the session credential is obtained
before the transport connection opens, and the WS handshake is bypassed entirely.

---

## push.subscribe (v0.1 addition)

A client registers a Web Push subscription for offline delivery. Servers
that support push advertise a VAPID public key in `pair.grant`
(`payload.vapidPublicKey`, optional). Clients that subscribe send:

    kind: "push.subscribe"
    payload: { subscription: { endpoint, keys: { p256dh, auth } } }

Servers without push support ignore the kind.

---

## approval.response.editedText (v0.1 addition)

When the chosen option edits the proposed content (e.g. `choice: "edit"`),
the full edited text rides in optional `payload.editedText`.

---

## Pairing QR payload

The QR encodes a JSON string:

    { "v": 1, "instanceUrl": "ws://host:port/", "transport": "ws", "token": "<single-use>" }

Parse with `parsePairingPayload` from `@raccoon/protocol`.

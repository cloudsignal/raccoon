# Security model

Read this before deploying Raccoon anywhere real. It states plainly what
Raccoon protects, what it does not, and who can read message content.

## Transport security — you must terminate TLS

Raccoon's WebSocket hub speaks **plain `ws://` in development**. In production
you **must** put it behind TLS (`wss://`), for example by terminating HTTPS at a
reverse proxy (nginx, Caddy, a cloud load balancer) and forwarding to the hub on
the loopback interface. The pairing payload encodes the public URL clients dial;
set it to your `wss://` origin.

Without TLS:

- pairing tokens and session tokens cross the network in cleartext,
- message content crosses in cleartext,
- there is no protection against a network attacker.

**Do not expose the hub directly on a public interface over `ws://`.**

## What Raccoon protects

With TLS in front of the hub:

- **Authenticated sessions.** A client pairs once (QR, single-use token) and
  then holds a bearer session token. The hub validates every connection against
  its `CredentialStore`; an unknown or revoked token is rejected (close code
  `4401`). Pairing is rate-limited per IP and bounded by pending-connection and
  frame-size caps.
- **Encrypted in transit.** Under `wss://`, traffic between the client and the
  hub is encrypted by TLS, like any HTTPS service.
- **Revocation.** Unpairing a user closes their live sockets and invalidates
  their session immediately; a subsequent reconnect with the old session is
  rejected.
- **DM gating (OpenClaw connector).** The connector enforces an allowlist /
  DM policy before an agent turn runs.

## What Raccoon does NOT provide

- **This is not end-to-end encryption.** Raccoon is **not** WhatsApp/Signal-style
  E2EE. "Encrypted in transit" means TLS between client and hub — the same
  guarantee as visiting an HTTPS website. It is **not** a guarantee that only
  the two human/agent endpoints can read the content.
- **The server sees plaintext.** The hub, the bridge, and — critically — the
  **agent framework (OpenClaw) and the model provider** all receive message
  content as **plaintext**. Your prompts and the agent's replies are visible to:
  - the process running the hub/connector,
  - the OpenClaw runtime handling the turn,
  - the model provider you configured (e.g. your LLM vendor), under their data
    policies.

  Treat message content accordingly. Do not send anything through Raccoon you
  are unwilling to expose to those parties.
- **No message-content encryption at rest.** A `MessageStore` persists history
  as plaintext unless you implement encryption in your own store.
- **Cross-restart exactly-once is not claimed.** The bridge dedups turns
  process-locally; see [connector-authoring.md](connector-authoring.md). A
  redelivery after a restart with a non-durable store can re-run a turn.

## Deployment checklist

- [ ] Hub is behind `wss://` (TLS terminated by a proxy); the hub itself binds
      loopback or a private interface.
- [ ] `instanceUrl` in pairing points at the public `wss://` origin.
- [ ] A **persistent `CredentialStore`** is supplied if sessions must survive a
      restart (the default is in-memory).
- [ ] A **durable `MessageStore`** is supplied if history must survive a restart.
- [ ] The model provider's data-handling policy is acceptable for the content
      users will send (they receive plaintext).
- [ ] Push (if enabled) uses your own VAPID keys; keep the private key secret.

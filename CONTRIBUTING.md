# Contributing to Raccoon

Thanks for helping build the messenger for AI agents.

## Setup

Node `^20.19.0 || >=22.12.0`. Then:

```bash
git clone https://github.com/cloudsignal/raccoon && cd raccoon
npm ci
npm test              # vitest, whole workspace
npm run typecheck     # every package
npm run build:app     # the PWA (needed once for the demo)
npm run demo          # echo hub + PWA on http://127.0.0.1:8790/
```

## Repo layout

- `packages/` core: protocol, transport-ws, bridge, pairing, push, app
- `adapters/` framework connectors (OpenClaw is first-party)
- `examples/` echo demo and hosting walkthroughs
- `docs/` quickstart, connector authoring, compatibility, security
- `website/` the raccoonchat.im landing page

## Before you open a PR

All of these must pass; CI runs them on every PR:

```bash
npm run typecheck
npm test
npm run gate:neutrality   # core and public docs name no vendor
npm run gate:deps         # every bare import in dist is declared
```

For release-facing changes, `npm run release:verify` runs the full packed-
tarball acceptance gates.

House rules:

- The core stays vendor-neutral. No vendor or company names in core source
  or public docs; integrations plug in through the documented seams
  ([docs/connector-authoring.md](docs/connector-authoring.md)).
- Import package roots (`@raccoon/bridge`), never `/src` deep paths.
- New tools or wire changes need tests plus a PROTOCOL.md update.
- Plain writing in docs: no em-dashes, no marketing filler.

## Adding a connector

The public ports and a worked second-connector example are in
[docs/connector-authoring.md](docs/connector-authoring.md). Connectors live in
their own package (or repo) with the framework as a peer dependency; nothing
about a framework enters core.

## Reporting bugs and requesting features

Use the issue templates. For security problems, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

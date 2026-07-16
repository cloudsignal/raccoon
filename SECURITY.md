# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
private reporting: **Security → Report a vulnerability** on
[github.com/cloudsignal/raccoon](https://github.com/cloudsignal/raccoon/security/advisories/new).

You can expect an acknowledgment within a few days. Please include a
reproduction (or a clear description of the attack path) and the affected
package and version.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## Scope and threat model

What Raccoon does and does not protect is documented in
[docs/security.md](docs/security.md). The short version: transport
encryption over HTTPS/WSS, revocable bearer sessions from QR pairing, and
hub-side gating of unpaired devices. Raccoon is not end-to-end encrypted;
the hub, connector, agent runtime, and model provider handle plaintext.
Reports that assume E2EE guarantees are out of scope; reports that break
the documented guarantees are very much in scope.

# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public
issue for anything security-sensitive.

- Preferred: use GitHub's private vulnerability reporting
  ([Security → Report a vulnerability](https://github.com/alexngai/macro-agent/security/advisories/new))
  on this repository.
- We aim to acknowledge reports within a few business days and to ship a fix or
  mitigation for confirmed, in-scope issues as promptly as is practical.

Please include a description of the issue, affected version, and a minimal
reproduction where possible.

## Supported versions

macro-agent is pre-1.0 and moves quickly. Security fixes are applied to the
latest published `0.x` release. Please upgrade to the latest version before
reporting.

## Security model and trust assumptions

macro-agent orchestrates autonomous coding agents that run as subprocesses with
access to a working tree and git. Understand the following before exposing it
beyond your own machine:

- **Servers are opt-in and loopback-only by default.** The REST API, ACP
  WebSocket server, and MAP WebSocket server are disabled unless enabled in
  config, and each binds to `127.0.0.1` by default.
- **Remote exposure requires a token.** These servers refuse to bind to a
  non-loopback host unless an auth token is configured (`config.serverToken` or
  the `MACRO_SERVER_TOKEN` environment variable). When a token is set it is
  required (bearer token or `?token=` for WebSocket clients) on every request
  except health checks. Do not expose a server without a token, and terminate
  TLS at a trusted reverse proxy — the built-in servers speak plain HTTP/WS.
- **The control socket is local-only.** The UNIX control socket lives under the
  base directory (`~/.macro-agent/…` by default), which is created `0700`, and
  the socket itself is `0600`. It is unauthenticated by design and must never be
  proxied to the network.
- **A connected hub is trusted.** When you connect the MAP sidecar to an
  OpenHive hub, that hub can dispatch work, drive autonomous agents, and supply
  the permission loadout those agents run with. Only connect to hubs you trust.
- **Federation trust is explicit.** Cross-instance federation is gated by an
  `allowedSystems` allowlist. Do not enable federation with an empty/omitted
  trust list.
- **Team templates are code-adjacent.** Team YAML can influence git remotes and
  branches used during landing. Treat shared team templates as you would code
  you run.

## Hardening checklist for operators

- Keep servers on `127.0.0.1` unless you have a specific need to expose them.
- If you must expose a server, set `MACRO_SERVER_TOKEN` to a strong random value
  and put it behind a TLS-terminating reverse proxy.
- Run macro-agent as a dedicated, least-privileged user.
- Keep dependencies up to date (`npm audit`); a Renovate config is included.

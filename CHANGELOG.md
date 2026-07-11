# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project aims
to follow [semantic versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

Pre-public-launch hardening.

### Security

- **Fixed two command-injection vulnerabilities** where hub-supplied values were
  interpolated into shell strings: the dispatch repo-clone path
  (`dispatch/mail-inbound-consumer.ts`) and the cascade push handler
  (`map/cascade-action-handler.ts`). Both now validate inputs and invoke git via
  `execFileSync` array args (no shell). Added `util/git-safety.ts` with shared
  ref/URL/path validators and hardened the `direct-push` landing strategy the
  same way.
- **Added authentication to the network servers.** The REST, ACP WebSocket, and
  MAP servers now enforce a bearer token when `serverToken` /
  `MACRO_SERVER_TOKEN` is set, and **refuse to bind to a non-loopback host
  without a token** (fail-closed). Loopback-only usage is unaffected.
- **Hardened the control socket**: the base directory is created `0700` and the
  UNIX control socket is `0600`.
- Made `secureCompare` constant-time regardless of input length.

### Packaging

- Added a `files` allowlist so `npm publish` ships only `dist/`, `templates/`,
  `README.md`, and `LICENSE` (was accidentally bundling the entire working tree,
  including local reference repos).
- Added `engines` (`node >=20`), `homepage`, and `bugs` fields; expanded
  keywords.
- Stopped tracking local reference repos (`references/`, `vendor/`) and internal
  tool state (`.sudocode/`, `.opentasks/`, `.sessionlog/`, personal
  `.claude/settings.json`); expanded `.gitignore`. Removed a vestigial top-level
  `index.js` placeholder.

### Documentation

- Added `SECURITY.md`, `CONTRIBUTING.md`, and this changelog.
- Fixed the programmatic-API examples: `TeamManagerV2`,
  `DefaultWorkspaceManager`, `createWorkspaceManagerWithAdapter`,
  `createGitCascadeAdapter`, and `MacroAgentBackend` are now exported from the
  package root, and the README imports them accordingly.
- Corrected broken links (ACP repo, issue tracker) and the git-cascade
  dependency description.
- Removed a duplicate doc and moved internal planning/design notes under
  `docs/design/`.

### Internal

- Replaced the stale placeholder metrics implementation in the REST API with the
  real `metrics` module.

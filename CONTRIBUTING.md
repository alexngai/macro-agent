# Contributing to macro-agent

Thanks for your interest in contributing! This guide covers local setup, the
test workflow, and conventions.

## Prerequisites

- **Node.js >= 20** (see `engines` in `package.json`)
- **git** on your `PATH` (macro-agent shells out to git for worktrees and
  landing)

## Local setup

```bash
git clone https://github.com/alexngai/macro-agent.git
cd macro-agent
npm install
npm run build      # tsc -> dist/
```

For iterating, `npm run dev` runs `tsc --watch`.

### Reference repos (optional)

Sibling projects (agent-inbox, opentasks, git-cascade, …) are consumed as
published npm packages. If you keep local checkouts for reference, place them
under `references/` — that directory is git-ignored and never published.

## Tests

```bash
npx vitest run             # unit tests (single run)
npm test                   # unit tests (watch mode)
npm run test:e2e           # e2e tests (gated by RUN_E2E_TESTS)
npm run test:e2e-full-agents  # e2e with real agent spawning
```

- Unit tests are colocated in `__tests__/` next to their source (`*.test.ts`).
- E2E tests live under `src/__tests__/` (`*.e2e.test.ts`) and are gated by
  `RUN_E2E_TESTS` / `RUN_FULL_AGENT_TESTS` environment variables.

Please add or update tests for any behavior change, and make sure
`npx tsc --noEmit` and `npx vitest run` are clean before opening a PR.

## Conventions

- One module per file; export the public surface via `index.ts`.
- `types.ts` holds interface definitions separately from implementation.
- Naming: `camelCase` (functions/vars), `PascalCase` (types/classes),
  `kebab-case` (file names), `SCREAMING_SNAKE` (constants).
- Prefer typed errors with codes and graceful degradation over hard failures.
- **Security:** never build a shell command from untrusted input. Use
  `execFileSync("git", [...])` with array args and validate refs/URLs/paths via
  `src/util/git-safety.ts`.

See `CLAUDE.md` for a deeper tour of the architecture and common tasks.

## Pull requests

1. Fork and branch from `main` (e.g. `feat/…`, `fix/…`, `chore/…`).
2. Keep changes focused; include tests and a clear description.
3. Ensure the build and tests pass.
4. For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of
   opening a public PR/issue.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).

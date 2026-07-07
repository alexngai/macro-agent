<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# macro-agent

Multi-agent orchestration system for spawning and managing hierarchical AI coding agents. Owns agent lifecycle, workspace isolation (git worktrees via `git-cascade`), team topology, and the role/trigger system; delegates messaging to `agent-inbox` and task management to `opentasks`.

## Build & test

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest (watch mode)
npx vitest run        # unit tests, single run
npm run test:e2e      # e2e tests (gated by RUN_E2E_TESTS/RUN_FULL_AGENT_TESTS)
```

## Conventions

- One module per file, exported via `index.ts`; tests colocated in `__tests__/`.
- camelCase functions/vars, PascalCase types/classes, kebab-case filenames, SCREAMING_SNAKE constants.
- Typed errors with codes; prefer graceful degradation (e.g. a missing `opentasks` daemon is non-fatal) over hard failures.
- Team shapes are declarative YAML under `.multiagent/teams/<name>/team.yaml`, not hardcoded per-role logic.

See `CLAUDE.md` for the full architecture guide.

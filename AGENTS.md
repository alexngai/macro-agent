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

<!-- SWARMKIT-WIKI:START -->
## SwarmKit Ecosystem Knowledge Base

This repository participates in the SwarmKit ecosystem. Before changing architecture, package boundaries, cross-repo integrations, protocols, task/dispatch behavior, memory/learning flows, workspace/git behavior, or agent orchestration semantics, query the shared knowledge base:

```sh
node /Users/alexngai/GitHub/swarmkit-wiki/scripts/query-knowledge.mjs context --cwd "$PWD"
node /Users/alexngai/GitHub/swarmkit-wiki/scripts/query-knowledge.mjs repo macro-agent
node /Users/alexngai/GitHub/swarmkit-wiki/scripts/query-knowledge.mjs interactions macro-agent
node /Users/alexngai/GitHub/swarmkit-wiki/scripts/query-knowledge.mjs search "<concept>"
```

Canonical ecosystem memory lives at `/Users/alexngai/GitHub/swarmkit-wiki`.

When this repo changes knowledge that should persist across agents, update the relevant wiki article, semantic model, raw snapshot, graph artifact, or cross-repo interaction data in `swarmkit-wiki`. Do not treat this repo's local `.understand-anything/` cache as canonical; graph artifacts are centralized in `swarmkit-wiki/.understand-anything/graphs/`.
<!-- SWARMKIT-WIKI:END -->

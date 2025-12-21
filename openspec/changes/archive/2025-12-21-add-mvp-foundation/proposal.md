# Change: Add MVP Foundation for Multi-Agent System

## Why

The macro-agent project needs its foundational architecture implemented to enable users to interact with a head manager agent that can spawn and coordinate child agents. This proposal establishes the core capabilities required for the MVP: event sourcing, agent/task management, messaging, MCP tools, and CLI/API interfaces.

## What Changes

- **ADDED** Event Store capability - TinyBase-based append-only event log with materialized views
- **ADDED** Agent Manager capability - Agent lifecycle management (spawn, terminate, query, hierarchy)
- **ADDED** Task Manager capability - First-class task entities with CRUD, assignment, and status tracking
- **ADDED** Message Router capability - Inter-agent messaging with subscription-based routing
- **ADDED** MCP Tools capability - 10 tools exposing multi-agent capabilities to agents
- **ADDED** CLI/API capability - REST API, WebSocket real-time updates, and CLI commands

## Impact

- Affected specs: None (greenfield - all new capabilities)
- Affected code: All new code under `src/`
- Dependencies: TinyBase, Express/Fastify, Commander/Yargs, Claude Code ACP

## Parallelization Strategy

```
Phase 1 (Sequential):
  └── Event Store (foundation)

Phase 2 (Parallel - 3 streams):
  ├── Stream A: Agent Manager
  ├── Stream B: Task Manager
  └── Stream C: Message Router

Phase 3 (Parallel - partial):
  └── MCP Tools (individual tools can parallelize)

Phase 4 (Sequential):
  └── CLI/API (integration layer)
```

## Success Criteria

- [ ] User can start system and interact via CLI
- [ ] Head manager spawns on first interaction
- [ ] Head manager can spawn child agents for subtasks
- [ ] Child agents execute work via Claude Code
- [ ] Status flows from children to parent via messaging
- [ ] Parent can query agent/task state
- [ ] Results flow back to user
- [ ] State persists across sessions

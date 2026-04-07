# Symphony vs macro-agent: Comparative Analysis

## Executive Summary

**OpenAI Symphony** and **macro-agent** both orchestrate AI coding agents, but solve fundamentally different problems at different scales of complexity.

**Symphony** is a *job scheduler* — it polls an issue tracker (Linear), assigns one agent per issue in an isolated workspace, and monitors execution. It is a daemon that turns tickets into autonomous coding runs.

**macro-agent** is a *multi-agent coordination system* — it manages hierarchical agent topologies with inter-agent messaging, role-based capabilities, team templates, and workspace integration strategies. It is a platform for orchestrating agents that collaborate with each other.

| Dimension | Symphony | macro-agent |
|-----------|----------|-------------|
| **Core metaphor** | Issue → Agent → PR | Team of agents collaborating on work |
| **Agent count per task** | 1 agent per issue | N agents in hierarchies (coordinator → workers) |
| **Agent communication** | None (agents are isolated) | Rich messaging (agent-inbox), threading, federation |
| **Task source** | External (Linear issue tracker) | Internal (opentasks graph) + external triggers |
| **Language** | Elixir/OTP | TypeScript/Node.js |
| **Coding agent** | Codex (app-server JSON-RPC) | Claude Code, Codex, Goose (auto-detected) |
| **Configuration** | Single `WORKFLOW.md` per repo | `.multiagent/config.json` + team YAML + role YAML |
| **Persistence** | Stateless (tracker-driven recovery) | SQLite (AgentStore, merge queue) |

---

## Architecture Comparison

### Symphony Architecture

Symphony follows a classic **poll → dispatch → monitor** loop:

```
Linear API  →  Orchestrator (GenServer)  →  AgentRunner  →  Codex subprocess
                    ↑                            ↓
               poll every Nms              isolated workspace
               reconcile states            per-issue directory
               manage retries
```

Key properties:
- **Single orchestrator process** (Elixir GenServer) owns all scheduling state
- **One agent per issue** — no agent-to-agent interaction
- **Stateless recovery** — on restart, re-reads tracker + filesystem; no database needed
- **WORKFLOW.md** is the single source of truth for runtime behavior
- **Codex app-server** protocol over stdio (JSON-RPC 2.0)

### macro-agent Architecture

macro-agent is a **layered system** with multiple interacting subsystems:

```
External clients (CLI, ACP, REST)
        ↓
    boot-v2.ts (wiring)
        ↓
    TeamManagerV2 (multi-team topology)
        ↓
    AgentManagerV2 (lifecycle, spawning)
        ↓
    ┌─────────────┬──────────────┬────────────────┐
    │ agent-inbox  │  opentasks   │  git-cascade   │
    │ (messaging)  │  (tasks)     │  (workspaces)  │
    └─────────────┴──────────────┴────────────────┘
```

Key properties:
- **Hierarchical agents** with parent-child relationships
- **Inter-agent messaging** via agent-inbox (threading, scoped delivery, federation)
- **Role-based capabilities** gate which MCP tools each agent can use
- **Team templates** define declarative multi-agent topologies
- **Multiple integration strategies** for landing code (queue, trunk, optimistic)
- **Control socket** (NDJSON over UNIX socket) for MCP subprocess ↔ main process RPC

---

## Feature-by-Feature Comparison

### 1. Agent Lifecycle

| Aspect | Symphony | macro-agent |
|--------|----------|-------------|
| **Spawn trigger** | Issue appears in tracker poll | Explicit spawn (API/MCP tool/team bootstrap) |
| **Spawn target** | Always Codex app-server | Pluggable (Claude Code, Codex, Goose, etc.) |
| **Multi-turn** | Yes — up to `max_turns` per session | Yes — via `prompt()` and `continue()` |
| **Continuation** | Re-checks issue state between turns; continuation prompt on same thread | Session-based; parent can re-prompt children |
| **Termination** | Orchestrator kills on terminal state / stall / reconciliation | Cascade termination with change consolidation |
| **Fork/branch** | Not supported | Supported (fork agent session) |

**Symphony's approach** is simpler: one issue maps to one agent run. The agent runner loops through turns, checking the tracker between each. If the issue moves to a terminal state, the agent is killed.

**macro-agent's approach** is richer: agents exist in hierarchies, can spawn children, and terminate cascades consolidate changes up the tree.

### 2. Workspace Isolation

| Aspect | Symphony | macro-agent |
|--------|----------|-------------|
| **Strategy** | Directory per issue (`<root>/<sanitized-id>/`) | Git worktrees via git-cascade |
| **Persistence** | Reused across runs for same issue | Allocated per agent, cleaned on termination |
| **Population** | Via hooks (`after_create`, `before_run`) | Automatic worktree creation from repo |
| **Code landing** | Agent handles PRs/commits directly | Integration strategies (queue/trunk/optimistic) |
| **Remote support** | SSH workspace creation + remote Codex launch | Local only |

Symphony takes a **hooks-first** approach to workspace setup — the `after_create` hook in WORKFLOW.md typically runs `git clone`. This is flexible but pushes VCS logic into shell scripts.

macro-agent uses **git worktrees** natively, with a merge queue and pluggable integration strategies for landing changes. This is more opinionated but handles the common case (multiple agents working on the same repo) much better.

### 3. Communication & Coordination

| Aspect | Symphony | macro-agent |
|--------|----------|-------------|
| **Agent-to-agent messaging** | None | Full inbox/outbox with threading |
| **Signal filtering** | N/A | Composite filters per team (AND logic) |
| **Emission validation** | N/A | Per-team validators |
| **Federation** | N/A | Cross-instance messaging (`agentId@systemId`) |
| **Channels** | N/A | Named topic channels with subscriptions |

This is the **biggest architectural difference**. Symphony agents are completely isolated — they know nothing about each other. macro-agent agents can send messages, subscribe to channels, and coordinate work through structured communication topologies.

### 4. Task Management

| Aspect | Symphony | macro-agent |
|--------|----------|-------------|
| **Task source** | External (Linear) | Internal (opentasks) + external triggers |
| **Task model** | Issue = task (1:1 mapping) | Graph-based with dependencies |
| **Claiming** | Orchestrator claims on dispatch | Pull-mode: agents claim tasks |
| **Dependencies** | Blocker detection (blocked_by field) | Full dependency graph in opentasks |
| **Task assignment** | Priority sort → first available slot | Role-based + team routing |

Symphony is **tracker-driven**: Linear is the source of truth, and the orchestrator simply maps issues to agent runs. This is elegant for the "turn tickets into PRs" use case.

macro-agent has its **own task system** (opentasks) with a dependency graph, providers, and pull-mode claiming. This supports more complex workflows where tasks emerge during execution.

### 5. Configuration & Workflow Definition

| Aspect | Symphony | macro-agent |
|--------|----------|-------------|
| **Config format** | Single `WORKFLOW.md` (YAML front matter + Liquid prompt) | JSON config + YAML team manifests + role YAML |
| **Hot reload** | Yes — file watcher with graceful fallback | No built-in hot reload |
| **Prompt template** | Liquid templates with issue variables | Role-based system prompts |
| **Env var support** | `$VAR` expansion in config values | Environment variables injected into subprocesses |
| **Validation** | Dispatch preflight checks every tick | Boot-time validation |

Symphony's **single-file approach** (`WORKFLOW.md`) is notably elegant — one file controls the entire runtime: polling interval, concurrency, workspace setup, agent configuration, and the prompt template. It hot-reloads on change.

macro-agent's configuration is **distributed across multiple files** (project config, team YAML, role definitions, prompt fragments), which provides more flexibility at the cost of complexity.

### 6. Retry & Fault Tolerance

| Aspect | Symphony | macro-agent |
|--------|----------|-------------|
| **Retry strategy** | Exponential backoff (`10s * 2^(attempt-1)`, capped) | Not built-in at orchestrator level |
| **Continuation** | 1-second delay for active-issue continuation | Parent re-prompts child |
| **Stall detection** | Codex activity timeout → kill + retry | Health check heartbeats |
| **Reconciliation** | Every tick: refresh tracker states, kill stale runs | Cascade termination on explicit stop |
| **Startup recovery** | Re-reads tracker + filesystem (no DB) | SQLite-based state recovery |

Symphony has **robust built-in retry logic** with distinct handling for failures (exponential backoff) vs. normal continuations (1-second retry). Its stateless recovery model (tracker + filesystem = truth) is simple and effective.

macro-agent relies more on **explicit lifecycle management** — parents manage children, and the cascade termination system consolidates changes.

### 7. Observability

| Aspect | Symphony | macro-agent |
|--------|----------|-------------|
| **Dashboard** | Phoenix LiveView (real-time browser UI) | None built-in |
| **API** | `/api/v1/state`, `/api/v1/<issue>`, `/api/v1/refresh` | REST API server (agents, tasks, teams, metrics) |
| **Logging** | Structured Elixir Logger + per-issue log files | Standard logging |
| **Metrics** | Token usage, runtime, rate limits (in-memory) | Point-in-time snapshots (agent/task/system) |
| **Live updates** | PubSub-driven (Phoenix.PubSub) | N/A |

Symphony's **LiveView dashboard** is a standout feature — operators see real-time session status, token usage, retry queues, and rate limits in a browser. macro-agent provides a REST API for metrics but no built-in visual dashboard.

### 8. Remote Execution

Symphony supports **SSH-based remote workers**: workspace creation, hook execution, and Codex subprocess launching all happen over SSH. This allows distributing agent workloads across multiple machines with per-host concurrency limits.

macro-agent does not have built-in remote execution but supports **federation** for cross-instance communication, which enables a different model of distribution (multiple macro-agent instances coordinating via federated inboxes).

---

## Design Philosophy

### Symphony: "Turn tickets into autonomous coding runs"

- **Opinionated about the workflow**: Linear → workspace → Codex → PR
- **Single-agent-per-task model** keeps things simple
- **WORKFLOW.md as contract**: teams version-control their agent behavior
- **Stateless orchestrator**: tracker is truth, restart is cheap
- **Elixir/OTP**: leverages BEAM's process supervision, fault tolerance, and concurrency

### macro-agent: "Coordinate teams of AI agents"

- **General-purpose orchestration**: any topology, any workflow
- **Multi-agent collaboration**: agents talk to each other
- **Role-based access control**: fine-grained capability model
- **Pluggable everything**: strategies, roles, routing, integration
- **TypeScript/Node.js**: familiar ecosystem, MCP-native

---

## Where Each Excels

### Symphony is better for:
- **Solo-agent ticket execution** — one agent per issue, no coordination needed
- **Issue-tracker-driven workflows** — Linear integration is first-class
- **Operational simplicity** — one config file, stateless recovery, live dashboard
- **Remote agent execution** — SSH support for distributed workloads
- **Hot-reloading config** — change WORKFLOW.md and behavior updates immediately
- **Retry resilience** — sophisticated backoff and continuation logic

### macro-agent is better for:
- **Multi-agent collaboration** — agents communicating and coordinating
- **Complex task graphs** — dependencies, providers, claiming workflows
- **Hierarchical orchestration** — coordinator → worker topologies
- **Code integration** — merge queues, integration strategies, git worktree isolation
- **Team templates** — declarative multi-agent topologies
- **Cross-instance federation** — multiple orchestrators cooperating
- **Agent diversity** — auto-detects and supports multiple coding agents
- **Protocol interop** — ACP, REST, MCP, MAP protocol support

---

## Potential Cross-Pollination

Ideas from Symphony that could benefit macro-agent:
1. **WORKFLOW.md-style single-file config** with hot reload for simple deployments
2. **Issue tracker integration** (Linear adapter) as a trigger source
3. **LiveView-style real-time dashboard** for operator visibility
4. **Stateless restart recovery** as an alternative to SQLite state
5. **Stall detection with Codex-event-based timeout** (more granular than heartbeats)
6. **SSH remote agent execution** for distributed workloads

Ideas from macro-agent that could benefit Symphony:
1. **Multi-agent topologies** for issues that need coordinated work
2. **Inter-agent messaging** so agents working on related issues can share context
3. **Git worktree isolation** with merge queue for safer code integration
4. **Role-based capabilities** to constrain agent behavior
5. **Federation** for cross-team/cross-instance coordination
6. **Pull-mode task claiming** for self-organizing agent pools

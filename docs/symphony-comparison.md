# Symphony vs macro-agent: Comparative Analysis

## Executive Summary

**Symphony** (OpenAI) and **macro-agent** solve related but fundamentally different problems in multi-agent orchestration. Symphony is a **job scheduler** that polls an issue tracker and dispatches one coding agent per issue. macro-agent is a **hierarchical agent runtime** that manages multi-agent topologies with inter-agent communication, team structures, and workspace isolation.

| Dimension | Symphony | macro-agent |
|-----------|----------|-------------|
| **Core metaphor** | CI/CD-style job runner for coding agents | Hierarchical multi-agent operating system |
| **Language** | Elixir (reference impl) + language-agnostic spec | TypeScript |
| **Agent model** | 1 agent per issue, flat | Hierarchical tree (parent/child), role-based |
| **Work source** | External issue tracker (Linear) | Programmatic spawning, MCP tools, REST API |
| **Communication** | None between agents | Full messaging (agent-inbox), signals, threading |
| **Team support** | None | YAML-defined team topologies with role hierarchies |
| **Codebase size** | ~9.5K lines (37 files) | ~57K lines (202 files) |

## 1. Architecture Comparison

### Symphony: Poll-Dispatch-Reconcile Loop

Symphony follows a straightforward daemon pattern:

```
Issue Tracker (Linear)
       │ poll every N seconds
       ▼
  Orchestrator (single GenServer)
       │ dispatch eligible issues
       ▼
  Agent Runner (one per issue)
       │ workspace + prompt + Codex app-server
       ▼
  Coding Agent (Codex subprocess, JSON-RPC over stdio)
```

Key architectural properties:
- **Single-process orchestrator**: All state lives in one GenServer (Elixir process). No database required for scheduling state.
- **Stateless recovery**: On restart, re-polls the issue tracker and re-dispatches. No persistent queue.
- **Flat agent topology**: Each agent is independent, working on exactly one issue. No parent-child relationships.
- **External work source**: Work comes exclusively from an issue tracker (Linear). Symphony is a "tracker reader and scheduler."
- **Agent = Codex**: Tightly coupled to the Codex app-server protocol (JSON-RPC over stdio).

### macro-agent: Hierarchical Agent Runtime

macro-agent is a multi-layered system with pluggable subsystems:

```
External Clients (CLI, ACP, REST, WebSocket)
       │
  Boot System (wires together ~10 subsystems)
       │
  ┌────┴────┐
  │ Team    │ ← YAML-defined topologies, role hierarchies
  │ Manager │   composite signal filters, emission validators
  └────┬────┘
       │
  Agent Manager ← lifecycle, spawning, workspace allocation
       │
  ┌────┼──────────────┐
  │    │              │
  Control Socket   MCP Server (per agent)
  (UNIX socket)    5-8 tools per agent
  │    │              │
  agent-inbox      opentasks
  (messaging)      (task graph)
```

Key architectural properties:
- **Multi-subsystem composition**: Messaging (agent-inbox), tasks (opentasks), workspaces (git-cascade), roles, teams, triggers, federation — each is a separate subsystem.
- **Hierarchical agents**: Agents form parent-child trees. Children can spawn children. Cascade termination propagates.
- **Role-based capabilities**: Workers, Integrators, Coordinators, Monitors — each with different tool surfaces and permissions.
- **Persistent state**: SQLite-backed AgentStore for agent/session data.
- **Protocol-agnostic agent spawning**: Uses acp-factory (AgentFactory) to spawn agents; supports Claude Code, Codex, and other CLI agents via agent-detection.

## 2. Detailed Feature Comparison

### 2.1 Work Dispatch

| Feature | Symphony | macro-agent |
|---------|----------|-------------|
| Work source | Linear issue tracker (polling) | Programmatic (spawn_agent tool, REST API, ACP) |
| Dispatch model | Poll → filter → sort → dispatch | On-demand spawning by parent agents or external clients |
| Concurrency control | Global limit + per-state limits | Workspace pool size limit |
| Priority | Issue priority field (1-4) + creation date | No built-in priority; task dependencies via opentasks |
| Blocker awareness | Blocks dispatch if non-terminal blockers exist | Task dependency graph via opentasks |
| Retry logic | Exponential backoff with configurable cap | No built-in retry; agents can be re-prompted |
| Dynamic reload | Hot-reloads WORKFLOW.md without restart | Configuration via .multiagent/config.json |

**Analysis**: Symphony's dispatch model is optimized for a specific workflow — pulling work from a tracker board. macro-agent is general-purpose; it doesn't assume where work comes from, but that means it doesn't provide Symphony's built-in polling/retry/reconciliation loop either.

### 2.2 Workspace Isolation

| Feature | Symphony | macro-agent |
|---------|----------|-------------|
| Isolation unit | Directory per issue | Git worktree per agent |
| Creation | `mkdir` + hooks | git-cascade worktree allocation |
| Lifecycle hooks | after_create, before_run, after_run, before_remove | Done handler with change consolidation |
| Change integration | Not managed (agent handles PRs) | Pluggable strategies: queue, trunk, optimistic |
| Merge queue | None | SQLite-backed merge queue |
| Cleanup | Terminal-state workspace removal | Cascade termination with workspace cleanup |

**Analysis**: macro-agent has significantly deeper workspace isolation — each agent gets a full git worktree with automatic branch management and pluggable merge strategies. Symphony creates plain directories and delegates VCS management to hooks and the agent itself. macro-agent's approach enables automated change consolidation when child agents complete, which is critical for multi-agent workflows where multiple agents edit the same codebase.

### 2.3 Agent Communication

| Feature | Symphony | macro-agent |
|---------|----------|-------------|
| Inter-agent messaging | **None** | Full messaging via agent-inbox (send, check, thread) |
| Signal system | **None** | Typed signals with filters and emission validators |
| Communication topology | **N/A** | Channels, subscriptions, peer routing |
| Federation | **None** | Cross-instance communication via federated inboxes |
| Event broadcasting | **None** | Role-based and team-scoped broadcasting |

**Analysis**: This is the starkest difference. Symphony agents are completely independent — they don't know about each other. macro-agent agents communicate constantly through a structured messaging system with threading, signal filtering, and even cross-instance federation. This makes macro-agent suitable for collaborative multi-agent workflows where agents need to coordinate (e.g., a coordinator breaks down work, workers report back, an integrator merges results).

### 2.4 Agent Lifecycle

| Feature | Symphony | macro-agent |
|---------|----------|-------------|
| Spawning | Orchestrator dispatches per issue | Any agent can spawn children via spawn_agent tool |
| Hierarchy | Flat (all agents are peers) | Tree (parent-child with lineage tracking) |
| Roles | None (all agents are equivalent) | Worker, Integrator, Coordinator, Monitor, custom |
| Continuation | Multi-turn within one session, then retry | Session continuation, fork, re-prompt |
| Termination | Normal exit or failure → retry | Cascade termination with change consolidation |
| Health monitoring | Stall detection via event timestamps | Heartbeat health checks via control socket |
| Agent detection | Hardcoded to Codex | Auto-discovers installed CLI agents (Claude Code, Codex, etc.) |

### 2.5 Configuration & Workflow

| Feature | Symphony | macro-agent |
|---------|----------|-------------|
| Config format | WORKFLOW.md (YAML frontmatter + Markdown prompt) | .multiagent/config.json + team YAML files |
| Dynamic reload | File-watch with hot-reload | Static at boot |
| Prompt management | Template with Liquid-style variables (issue, attempt) | System prompt generation per role |
| Team definition | N/A | YAML team manifests with topology and communication rules |
| Role definition | N/A | Built-in roles + custom YAML role extensions |

**Analysis**: Symphony's WORKFLOW.md approach is elegant for its use case — a single file defines both the runtime configuration and the agent prompt, version-controlled with the repo. macro-agent's configuration is more complex but supports much more: team topologies, role hierarchies, communication policies, and custom prompt fragments.

### 2.6 Observability

| Feature | Symphony | macro-agent |
|---------|----------|-------------|
| Logging | Structured logs with issue/session context | Structured logs |
| Dashboard | Optional LiveView dashboard + HTTP status API | REST API with metrics endpoint |
| Token tracking | Per-session and aggregate token accounting | Via agent store |
| Rate limit tracking | Tracks latest Codex rate-limit snapshot | N/A |
| Status API | GET /api/v1/state, per-issue details, POST /refresh | REST API for agents, tasks, teams, metrics |

### 2.7 External Integration

| Feature | Symphony | macro-agent |
|---------|----------|-------------|
| Issue tracker | Linear (first-class, polling-based) | None built-in |
| Agent protocol | Codex app-server (JSON-RPC over stdio) | ACP (WebSocket), MCP (stdio), REST |
| Client protocol | CLI | CLI, ACP stdio, WebSocket, REST API |
| Federation | None | Cross-instance via federated agent-inbox |
| Cognitive backend | None | cognitive-core/OpenHive integration |
| SSH workers | Optional SSH extension for remote execution | N/A |

## 3. Design Philosophy Comparison

### Symphony: "Turn issues into autonomous runs"

Symphony embodies the "harness engineering" philosophy — the idea that coding agents should be managed at the *work* level, not the *agent* level. Key design choices:

1. **Minimal orchestrator**: The orchestrator is deliberately thin. It polls, dispatches, retries, and reconciles. All business logic (how to edit tickets, create PRs, handle reviews) lives in the workflow prompt.
2. **Agent-as-black-box**: Symphony doesn't try to control what the agent does inside its workspace. It starts the agent, streams events, and handles the lifecycle.
3. **Tracker-driven**: The issue tracker is the source of truth. Symphony doesn't maintain its own task database — it reads from Linear and reacts.
4. **Restart-safe without persistence**: Because the tracker is the source of truth, Symphony can restart from scratch by re-polling. No complex state recovery needed.
5. **Single-agent-per-issue**: Deliberate simplicity. No coordination overhead, no merge conflicts between agents.

### macro-agent: "Orchestrate hierarchical agent teams"

macro-agent embodies a "multi-agent operating system" philosophy where the system manages agent collaboration at a structural level:

1. **Rich orchestration**: The system manages agent hierarchies, communication topologies, role-based capabilities, and workspace isolation.
2. **Agent coordination**: Agents are expected to communicate, delegate, and coordinate through structured messaging.
3. **Pluggable everything**: Workspace strategies, routing strategies, role definitions, team topologies — all are pluggable and configurable.
4. **Deep git integration**: Worktrees, merge queues, integration strategies — the system understands and manages git workflow.
5. **Protocol diversity**: Supports multiple agent types, multiple client protocols, and cross-instance federation.

## 4. Where Each System Excels

### Symphony is better for:
- **Issue-driven automation**: Automatically processing a board of tickets
- **Simple deployment**: Single daemon, no database, minimal configuration
- **Operational clarity**: Each agent works on exactly one issue; easy to understand and debug
- **Agent-agnostic workflows**: The WORKFLOW.md prompt + hooks pattern is flexible
- **Hot-reload**: Change the workflow file and behavior updates without restart
- **Remote execution**: SSH worker extension for distributed execution

### macro-agent is better for:
- **Complex multi-agent tasks**: Work that requires agent coordination and communication
- **Hierarchical decomposition**: A coordinator breaks down work, spawns workers, integrates results
- **Code integration**: Automated merge queue, conflict resolution, change consolidation
- **Team workflows**: Predefined team topologies with communication policies
- **Extensibility**: Adding new roles, strategies, tools, and protocols
- **Cross-system integration**: ACP, MCP, REST, federation, cognitive-core backend

## 5. Potential Cross-Pollination

### Ideas macro-agent could adopt from Symphony:
1. **Issue tracker polling**: A trigger source that polls Linear/GitHub Issues and auto-dispatches agents
2. **WORKFLOW.md pattern**: In-repo workflow definitions with hot-reload for simpler team configurations
3. **Continuation retry loop**: Automatic re-dispatch after successful completion to check if more work is needed
4. **Token/rate-limit tracking**: First-class token accounting and rate-limit awareness in the orchestrator
5. **Stall detection**: Timeout-based stall detection with automatic retry (macro-agent has health checks but not stall-based auto-retry)
6. **SSH remote execution**: Executing agents on remote hosts while keeping orchestration local

### Ideas Symphony could adopt from macro-agent:
1. **Inter-agent communication**: Allow agents working on related issues to share context
2. **Hierarchical decomposition**: Break large issues into sub-tasks with child agents
3. **Workspace merge management**: Automated merge queues when multiple agents touch the same codebase
4. **Role-based tool filtering**: Different agent capabilities for different types of work
5. **Team topologies**: Predefined patterns for how agents collaborate
6. **Federation**: Cross-instance coordination for large organizations

## 6. Summary

Symphony and macro-agent represent two distinct approaches to the multi-agent orchestration problem:

- **Symphony** is a focused, opinionated job scheduler. It excels at turning a board of issues into automated coding runs with minimal operational overhead. Its strength is simplicity and operational clarity.

- **macro-agent** is a comprehensive agent runtime. It excels at orchestrating complex multi-agent workflows with communication, hierarchy, and deep git integration. Its strength is flexibility and coordination capabilities.

They are more complementary than competitive. Symphony could be implemented as a trigger source within macro-agent (a "Linear poller" that dispatches to the agent manager), and macro-agent's communication/team features could enhance Symphony's single-agent-per-issue model for cases where issues require coordinated multi-agent effort.

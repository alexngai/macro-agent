# macro-agent vs oh-my-claudecode (OMC): Comparison

## Overview

Both projects enable multi-agent orchestration for Claude Code, but they occupy very different positions in the stack.

| Dimension | **macro-agent** | **oh-my-claudecode (OMC)** |
|---|---|---|
| **Philosophy** | Infrastructure-grade orchestration runtime | Developer productivity layer ("just use it") |
| **Tagline** | Multi-agent orchestration with hierarchical control | "Don't learn Claude Code. Just use OMC." |
| **Language** | TypeScript | TypeScript |
| **Codebase** | ~48.5K LOC, 173 source files | ~93.6K LOC, 2,546 files |
| **License** | — | MIT |
| **GitHub Stars** | — | ~20k+ |

---

## 1. Purpose & Target Audience

**macro-agent** is a **systems-level orchestration framework** — the runtime that manages agent lifecycles, workspaces, messaging, task graphs, and team topologies. It's infrastructure; the "kernel" that higher-level tools could build on top of.

*Target:* Platform builders and teams needing fine-grained control over multi-agent coordination.

**OMC** is a **developer experience layer** on top of Claude Code. It provides magic keywords (`autopilot:`, `ralph:`, `team`), smart defaults, 19 pre-built agent personas, and 31 composable skills so developers can get multi-agent workflows without understanding internals.

*Target:* Individual developers and small teams who want immediate productivity gains.

---

## 2. Architecture

### macro-agent: Adapter-Based Microservices Architecture

Clean separation of concerns with formal adapter boundaries:

```
User → CLI/ACP → boot-v2 → AgentManagerV2
                              ├── InboxAdapter (agent-inbox, embedded)
                              ├── TasksAdapter (opentasks, IPC)
                              ├── ControlServer (NDJSON over UNIX socket)
                              ├── WorkspaceManager (git worktrees via git-cascade)
                              ├── TeamManagerV2 (YAML topologies)
                              ├── TriggerSystem (routing strategies + wake)
                              └── RoleRegistry (capability-based access)
```

- Each subsystem has a defined interface and can be swapped
- NDJSON control socket separates control plane from data plane
- SQLite-backed agent store and merge queue
- MCP subprocesses communicate with main process via IPC

### OMC: Hook-Driven Plugin Architecture

Pipeline-based flow leveraging Claude Code's native hook system:

```
User Input → Hooks (keyword detection, 40+ handlers)
           → Skills (3-layer composition: execution + enhancement + guarantee)
           → Agents (19 specialized, model-routed)
           → State (.omc/ directory, survives compaction)
```

- 11 Claude Code lifecycle events drive the system (UserPromptSubmit, PreToolUse, Stop, etc.)
- State persisted in `.omc/` directory to survive context resets
- tmux used for worker process isolation
- Notepad system for compaction-resistant memory

---

## 3. Multi-Agent Coordination

| Aspect | **macro-agent** | **OMC** |
|---|---|---|
| **Agent types** | 5 built-in roles + custom YAML roles | 19 specialized agent personas in 4 lanes |
| **Team definition** | Declarative YAML manifests with topology, channels, subscriptions | Magic keywords + execution mode selection |
| **Communication** | Structured inbox/outbox with threading, scoped channels, signal filtering, emission validators | Implicit via execution mode pipeline stages |
| **Task management** | Full task graph with dependencies, providers, claiming (via opentasks) | Task decomposition within execution modes |
| **Workspace isolation** | Git worktrees per worker, merge queue, 3 integration strategies | tmux panes per worker |
| **Task modes** | Push (coordinator assigns) and Pull (agents claim) | Push via pipeline stages |
| **Cross-agent messaging** | Federation protocol, topic-based pub/sub | MCP-based inter-agent communication |

**macro-agent** gives you a **programmable communication topology** — you define exactly which agents can talk to which, on what channels, with what signal types. 

**OMC** gives you **pre-baked pipelines** (plan → PRD → execute → verify → fix) that work out of the box.

---

## 4. Execution Modes

### macro-agent

Execution is controlled by **team manifests** (YAML) and **integration strategies**:

- **Queue strategy**: Serialized integration via merge queue
- **Trunk strategy**: Direct push with rebase-retry loop
- **Optimistic strategy**: Push + validation event

The coordinator spawns workers, workers get isolated worktrees, and changes are merged back through the chosen strategy.

### OMC

Multiple named **execution modes**, each with a different orchestration pattern:

| Mode | Purpose |
|------|---------|
| **Team** | Staged pipeline: plan → PRD → exec → verify → fix |
| **Autopilot** | Autonomous single-lead end-to-end execution |
| **Ralph** | Persistent verify/fix loops until completion |
| **Ultrawork** | Maximum parallelism (5+ simultaneous agents) |
| **Pipeline** | Sequential staged processing |
| **Ralplan** | Iterative planning consensus (planner + architect + critic) |
| **CCG** | Tri-model orchestration (Codex + Gemini + Claude synthesis) |

---

## 5. Key Differentiators

### macro-agent has, OMC doesn't

- **Formal merge queue** with conflict resolution strategies (queue, trunk, optimistic)
- **Git worktree-based workspace isolation** per agent (via git-cascade)
- **Structured task graphs** with dependencies and claiming (via opentasks)
- **Control socket** (NDJSON RPC) for subprocess lifecycle management
- **Composite signal filtering** and emission enforcement for multi-team topologies
- **Agent detection system** (discovers Claude Code, Codex, Goose, etc. on PATH)
- **Federation** for cross-instance communication
- **Formal adapter layer** with clean IPC boundaries
- **Role-based capability system** with tool filtering per role

### OMC has, macro-agent doesn't

- **Smart model routing** (Haiku for simple, Sonnet for implementation, Opus for reasoning) — 30-50% cost savings
- **19 pre-built specialized agents** with domain expertise (security reviewer, test engineer, designer, scientist, etc.)
- **31 composable skills** with 3-layer composition (execution + enhancement + guarantee)
- **Magic keyword interface** (`autopilot:`, `ralph:`, `team`, `ulw`, `ccg`, etc.)
- **40+ lifecycle hooks** deeply integrated with Claude Code's event system
- **HUD** with live monitoring and session replay
- **Rate limit detection** and auto-resume daemon
- **Notepad system** that survives context compaction
- **Stop callbacks** to Discord/Telegram/Slack
- **Skills learner** that extracts reusable patterns from past sessions
- **LSP and AST tools** (go-to-definition, find-references, ast-grep)
- **OpenClaw gateway** for external workflow integration
- **Multi-provider support** (Codex CLI, Gemini CLI in addition to Claude)
- **Deep-interview mode** for Socratic requirements clarification

---

## 6. Developer Experience

**macro-agent**: You're working with a **systems toolkit**. Powerful, precise, composable — but you need to understand roles, capabilities, team manifests, adapter interfaces, control sockets, and integration strategies. Configuration is explicit and declarative (YAML manifests, environment variables).

**OMC**: You're using a **smart appliance**. Type `autopilot: build a REST API` and it handles decomposition, agent assignment, verification, and fix loops automatically. The learning curve is intentionally near-zero. Configuration is optional — intelligent defaults handle most cases.

| | **macro-agent** | **OMC** |
|---|---|---|
| Getting started | Define team YAML, configure roles, boot system | `autopilot: do the thing` |
| Customization depth | Full control over topology, communication, strategies | Skills, hooks, model overrides |
| Debugging | Control socket introspection, agent store queries | HUD, session replay, logs |
| Persistence | SQLite stores, agent-inbox threading | `.omc/` state directory, notepad, project memory |

---

## 7. Technical Approach Comparison

| | **macro-agent** | **OMC** |
|---|---|---|
| **Process model** | Main process + MCP subprocesses (NDJSON IPC) | Claude Code hooks + tmux workers |
| **State storage** | SQLite (agent store, merge queue, inbox) | File-based JSON/JSONL in `.omc/` |
| **Agent spawning** | `acp-factory` (AgentFactory) | Claude Code subagents + tmux |
| **Messaging** | agent-inbox (embedded, structured, federated) | Implicit pipeline + MCP |
| **Task management** | opentasks (separate daemon, IPC) | Built into execution modes |
| **Workspace isolation** | git worktrees (git-cascade) | tmux panes |
| **Configuration** | YAML team manifests + env vars | Magic keywords + optional config files |
| **Extension model** | Routing strategies, role YAML, adapters | Skills, hooks, custom agents |

---

## 8. Summary

| | **macro-agent** | **OMC** |
|---|---|---|
| **Strength** | Architectural rigor, composability, fine-grained control, workspace isolation | Accessibility, batteries-included, immediate productivity, cost optimization |
| **Weakness** | Higher learning curve, no pre-built UX layer | Less control over internals, opinionated pipelines |
| **Best for** | Platform teams building custom multi-agent systems | Developers wanting multi-agent power with minimal setup |
| **Analogy** | Kubernetes | Docker Desktop |

The two projects are **complementary rather than directly competitive**. macro-agent provides the low-level orchestration primitives (lifecycle, workspaces, messaging, task graphs, merge strategies) that a tool like OMC could theoretically build its developer experience on top of. OMC provides the user-facing patterns (magic keywords, agent personas, execution modes, cost optimization) that make multi-agent development accessible.

Where they overlap is in **team orchestration** and **agent lifecycle management**, but they approach it from opposite ends: macro-agent from the infrastructure up, OMC from the user experience down.

---

## 9. oh-my-openagent: The Vendor-Neutral Evolution

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (formerly oh-my-opencode) is the **vendor-neutral fork/evolution** of OMC. It runs on OpenCode instead of Claude Code and adds multi-provider model routing (GPT, Gemini, Kimi K2.5, GLM alongside Claude). Same maintainer ecosystem, ~46k GitHub stars.

### Agent Architecture

oh-my-openagent defines **10 built-in agents** with a strict planning/execution separation:

| Agent | Role | Default Model | macro-agent Equivalent |
|---|---|---|---|
| **Sisyphus** | Main orchestrator | Claude Opus 4.6 / Kimi K2.5 / GLM-5 | Coordinator role |
| **Prometheus** | Strategic planner (interview mode) | Claude Opus 4.6 | Custom planner role |
| **Atlas** | Plan executor, wave/parallel management | Claude Opus 4.6 | Custom executor role |
| **Hephaestus** | Autonomous deep worker | GPT-5.4 | Worker role |
| **Oracle** | Verification and QA | — | Monitor role |
| **Librarian** | Knowledge retrieval | — | Custom role |
| **Explore** | Fast codebase search | — | Custom role |
| **Metis** | Gap analysis (planning) | — | Custom role |
| **Momus** | Quality review | — | Custom role |
| **Sisyphus-Junior** | Lightweight category-based delegator | — | Worker role variant |

### Mapping to openteams Configuration

The oh-my-openagent agent topology maps directly to an openteams team manifest:

```yaml
# Hypothetical openteams equivalent of oh-my-openagent's topology
name: sisyphus-team
version: 1
roles: [orchestrator, planner, executor, deep-worker, verifier, librarian, explorer]

topology:
  root:
    role: orchestrator        # Sisyphus
    config:
      model: claude-opus-4-6
  companions:
    - role: planner           # Prometheus
      config:
        model: claude-opus-4-6
  spawn_rules:
    orchestrator: [executor, deep-worker, verifier, librarian, explorer]
    executor: [deep-worker]   # Atlas delegates to Hephaestus

communication:
  channels:
    planning:
      signals: [PLAN_READY, GAP_ANALYSIS, PLAN_APPROVED]
    execution:
      signals: [TASK_ASSIGNED, TASK_COMPLETED, WAVE_COMPLETE]
    verification:
      signals: [VERIFY_REQUEST, VERIFY_PASS, VERIFY_FAIL]
  subscriptions:
    executor:
      - channel: planning
        signals: [PLAN_READY]
    verifier:
      - channel: execution
        signals: [TASK_COMPLETED]
  emissions:
    planner: [PLAN_READY, GAP_ANALYSIS]
    executor: [TASK_ASSIGNED, WAVE_COMPLETE]
    deep-worker: [TASK_COMPLETED]
    verifier: [VERIFY_PASS, VERIFY_FAIL]

macro_agent:
  task_assignment:
    mode: push              # Atlas pushes tasks to workers
  integration:
    strategy: trunk
```

### Category-Based Task Routing

oh-my-openagent routes tasks through **categories** that map to models:

| Category | Purpose | Model | openteams Equivalent |
|---|---|---|---|
| `deep` | Complex architectural work | GPT-5.4 | Role with `model` config |
| `quick` | Simple fast tasks | Claude Sonnet | Role with `model` config |
| `visual-engineering` | UI/UX code | Gemini | Role with `model` config |
| `ultrabrain` | Expert reasoning | GPT-5.4 xhigh | Role with `model` config |
| `research` | Analysis/investigation | — | Role with capabilities |
| `writing` | Documentation | — | Role with capabilities |

This is conceptually equivalent to defining multiple worker roles in openteams, each with a different model and capability set — the "category" is just a role by another name.

### What Maps vs What Doesn't

**Maps cleanly to openteams config:**
- Agent definitions → `roles/*.yaml`
- Agent topology (Prometheus → Atlas → Hephaestus) → `topology` section
- Category-based routing → multiple worker roles with different models
- Delegation triggers → `communication.routing.peers`
- Skill loading → role capabilities
- `oh-my-opencode.json` → `team.yaml` manifest

**Maps to macro-agent runtime (not openteams):**
- Agent lifecycle management → `AgentManagerV2`
- `.sisyphus/plans/` state files → `AgentStore` + `opentasks`
- Background subagent execution → `ControlServer` + health checks
- Circuit breaker for runaway agents → `ControlServer` monitoring
- Session recovery → Agent sessions + continuation

**Unique to oh-my-openagent (no equivalent):**
- **Hash-anchored edit tool** (Hashline) — content-validated line references
- **Multi-provider model routing** — Claude/GPT/Gemini/Kimi/GLM in one config
- **IntentGate** — intent classification before action
- **OpenCode plugin system** — different host platform entirely
- **Magic keywords** — natural language activation

### Layer Model

```
┌────────────────────────────────────────────────┐
│  UX Layer                                      │
│  Magic keywords, HUD, hashline, notepad,       │  ← oh-my-openagent only
│  intent gate, multi-provider model routing      │
├────────────────────────────────────────────────┤
│  Config Layer                                  │
│  Agent definitions, categories, delegation      │  ← openteams YAML equivalent
│  rules, topology, skill composition             │
├────────────────────────────────────────────────┤
│  Runtime Layer                                 │
│  Lifecycle, IPC, workspaces, messaging,         │  ← macro-agent equivalent
│  tasks, triggers, control socket                │
└────────────────────────────────────────────────┘
```

oh-my-openagent is a **vertically integrated stack** spanning all three layers. The config layer is the openteams equivalent. The runtime layer is what macro-agent provides (but oh-my-openagent builds a thinner version since there's no macro-agent underneath). The UX layer is oh-my-openagent's unique contribution.

If oh-my-openagent were rebuilt on macro-agent + openteams, the config layer would become YAML manifests, the runtime layer would be deleted, and only the UX layer would remain as the project's differentiator.

# Macro-Agent Atlas Extension: Design Doc

## Summary

Enable cognitive-core (Atlas) to use macro-agent as a compute backend for its agentic analysis tasks, with a phased progression toward full team-native cognitive operations.

**Phase 1 (Path A):** macro-agent implements cognitive-core's `AgentBackend` interface, providing workers for Atlas's workspace templates (trajectory analysis, playbook extraction, etc.).

**Phase 2 (Path B):** Workers spawn under a persistent `cognitive-ops` team with pull-mode task claiming and inter-worker coordination.

**Phase 3 (Path C):** Full team-native cognitive operations — team config encodes Atlas's orchestration, MAP extensions enable openhive integration, session lifecycle hooks feed trajectories back into learning.

The boundary between phases is **internal to the backend implementation**. cognitive-core's contract (`AgentBackend.spawn() → AgentSession`) stays stable across all three phases.

## Background

**cognitive-core** ([`references/cognitive-core/`](https://github.com/alexngai/cognitive-core)) provides an `Atlas` class that:
- Ingests ReAct-format trajectories (thought → action → observation steps)
- Stores them in an `ExperienceMemory` for retrieval
- Extracts playbooks/skills via `LearningPipeline.runBatchLearning()`
- Prunes stale experiences via `experiences.prune()`
- Runs team learning via `TeamLearningPipeline`
- Queries accumulated knowledge via `memory.queryV2()`
- Supports both heuristic (no LLM) and agentic (LLM-assisted) analysis modes

**Key architectural property:** cognitive-core is **execution-agnostic**. It defines an `AgentBackend` interface and `AgentDelegate` for caller-provided agents but spawns nothing itself. When Atlas needs compute (agentic analysis, playbook extraction), it calls into whatever backend is registered.

**macro-agent** provides multi-agent orchestration with:
- Role-based agents with capability-gated tools
- Team templates for declarative topologies
- Workspace isolation via git worktrees
- Message routing with signal filtering
- EventStore for persistent session tracking
- MAP protocol adapter with extension registry

**openhive** manages swarm lifecycle, syncs resources (memory banks, skill repos) via MAP, and wants to use cognitive-core's capabilities by hosting a dedicated macro-agent swarm with Atlas enabled.

## Integration Architecture

```
┌─────────────────────────────────────────────────────────┐
│  cognitive-core (unchanged across all phases)            │
│                                                         │
│  Atlas                                                  │
│    ├── AgenticTaskRunner (workspace templates)           │
│    │     ├── trajectory analysis                        │
│    │     ├── playbook extraction                        │
│    │     ├── team trajectory analysis                   │
│    │     └── knowledge extraction                       │
│    │                                                    │
│    └── AgentManager → ComputeProvider                   │
│                          ↓                              │
│                    MacroAgentBackend                     │
│                    (AgentBackend interface)              │
└──────────────────────┬──────────────────────────────────┘
                       │ spawn(config)
                       │ getSession(id)
                       ▼
┌──────────────────────────────────────────────────────────┐
│  macro-agent (evolves across phases)                     │
│                                                         │
│  Phase A: agentManager.spawn(worker)                    │
│  Phase B: agentManager.spawn(analyst, parent=team)      │
│  Phase C: TeamRuntime dispatches via task pool + MAP     │
└──────────────────────────────────────────────────────────┘
```

## What Atlas Uses Compute For

Atlas's `AgenticTaskRunner` runs **workspace templates** — structured analysis jobs dispatched to agents. Each template has a complexity assessment that decides heuristic (no agent) vs agentic (spawn agent).

The agentic path:
1. Creates workspace directory (`input/`, `output/`, `skills/`, `resources/`)
2. Populates with trajectory data, playbook guidance, domain resources
3. Builds task prompt from the template
4. Spawns an agent with `cwd` pointing at the workspace
5. Collects structured output from `output/`
6. Feeds the agent's own trajectory back into the learning pipeline (meta-learning)

**Template types:**
| Template | Input | Output |
|----------|-------|--------|
| Trajectory analysis | Single trajectory | Analysis result (key steps, abstractability, error patterns) |
| Playbook extraction | Batch of trajectories | Extracted playbooks |
| Team trajectory analysis | Team trajectory graph | Coordination analysis |
| Team playbook extraction | Batch of team trajectories | Team/role playbooks |
| Knowledge extraction | Domain data | Facts, entities, relationships |

---

## Phase 1: MacroAgentBackend (Path A)

### cognitive-core's AgentBackend Interface

```typescript
interface AgentBackend {
  readonly name: string;
  readonly supportedTypes: string[];
  isAvailable(): Promise<boolean>;
  spawn(config: AgentSpawnConfig): Promise<AgentSession>;
  getSession(sessionId: string): Promise<AgentSession | undefined>;

  // Optional
  sendMessage?(sessionId: string, message: string): Promise<void>;
  pause?(sessionId: string): Promise<void>;
  resume?(sessionId: string): Promise<void>;
  terminate?(sessionId: string): Promise<void>;
  listSessions?(): Promise<AgentSession[]>;
}
```

**AgentSpawnConfig** (what cognitive-core sends):
```typescript
interface AgentSpawnConfig {
  agentType: string;                        // e.g., 'claude-code'
  task: Task;                               // { description, context?, domain? }
  injectedKnowledge?: MemoryQueryResultV2;  // Playbooks + experiences to inject
  systemPromptAdditions?: string;           // Skill context for system prompt
  env?: Record<string, string>;
  cwd?: string;                             // Workspace directory
  timeout?: number;
  captureToolCalls?: boolean;
  onMessage?: (message: AgentMessage) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  backendOptions?: Record<string, unknown>;
  computeRequirements?: ComputeRequirements;
}
```

**AgentSession** (what the backend returns):
```typescript
interface AgentSession {
  id: string;
  agentType: string;
  task: Task;
  state: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  messages: AgentMessage[];
  toolCalls: ToolCall[];
  startTime: Date;
  endTime?: Date;
  result?: unknown;
  error?: string;
  metadata: Record<string, unknown>;
}
```

### Analyst Role

Workspace templates only need file I/O in the workspace — no git, no spawning, no merging. A dedicated `analyst` role with constrained capabilities prevents agents from doing unexpected work.

`MacroAgentBackend` registers this role programmatically at construction (no team YAML needed in Phase 1). In Phase 2, the same role name moves to team YAML — no breaking change.

```typescript
// Registered by MacroAgentBackend constructor
const AnalystRole: RoleDefinition = {
  name: 'analyst',
  displayName: 'Analyst',
  description: 'Cognitive analysis agent for workspace templates',

  capabilities: [
    FILE_CAPABILITIES.READ,
    FILE_CAPABILITIES.WRITE,
    EXEC_CAPABILITIES.COMMAND,    // For validation scripts if needed
    LIFECYCLE_CAPABILITIES.DONE,
  ],

  workspace: { type: 'none' },   // cognitive-core manages its own workspaces

  lifecycle: {
    type: 'ephemeral',
    taskBound: true,
    // maxDurationMs set dynamically from AgentSpawnConfig.timeout
    cascadeTerminate: true,
    selfCleanup: true,
  },

  systemPrompt: `You are an analysis agent. Your workspace contains input/ and output/ directories.
1. Read the input files described in your task
2. Perform the requested analysis
3. Write your results to output/ in the exact JSON schema specified
4. Call done({ status: "completed", summary: "..." })

Do NOT commit, push, or spawn other agents. Focus only on reading input and writing output.`,
};
```

### MacroAgentBackend Implementation

Lives in: **macro-agent** `src/cognitive/macro-agent-backend.ts`

**Bridge types** (structurally compatible with cognitive-core, no import dependency):
```typescript
// src/cognitive/types.ts — local bridge types, no cognitive-core imports
export interface MacroAgentBackendConfig {
  maxFollowUps?: number;        // Default: 1
  softTimeoutRatio?: number;    // Default: 0.8
  useTeam?: boolean;            // Default: false
  coordinatorAgentId?: AgentId;
}

export type CognitiveAgentState = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

export interface CognitiveAgentSession {
  id: string;
  agentType: string;
  task: CognitiveTask;
  state: CognitiveAgentState;
  messages: CognitiveAgentMessage[];
  toolCalls: CognitiveToolCall[];
  startTime: Date;
  endTime?: Date;
  result?: unknown;
  error?: string;
  metadata: Record<string, unknown>;
}
```

**Backend class:**
```typescript
export class MacroAgentBackend {
  readonly name = 'macro-agent';
  readonly supportedTypes = ['claude-code'];

  constructor(agentManager: AgentManager, config?: MacroAgentBackendConfig) {
    // Stores agentManager, merges config defaults
    // Registers AnalystRole via agentManager.getRoleRegistry() if not already present
    //   (try resolveRole('analyst'), register on catch)
  }

  async spawn(config: CognitiveAgentSpawnConfig): Promise<CognitiveAgentSession> {
    // 1. Spawn analyst: parent = useTeam ? coordinatorAgentId : null
    // 2. Create session with unique ID (cognitive_${nanoid(12)})
    // 3. Fire-and-forget runSession() — stored as runPromise
    // 4. Return session immediately (state: 'running')
  }

  async getSession(sessionId: string): Promise<CognitiveAgentSession | undefined>;
  async terminate(sessionId: string): Promise<void>;
  async listSessions(): Promise<CognitiveAgentSession[]>;

  private async runSession(agentId, session, config): Promise<void> {
    // Timeout enforcement: soft nudge at softTimeoutRatio, hard kill at 100%
    // Uses session.state === 'running' guards (not a local flag)
    //   so external terminate() and hard timeout don't race with normal completion
    // Calls promptUntilDone() with streaming onUpdate → updateSessionFromEvent()
    // On completion: sets state based on result.doneCalled
    // Finally: cleans up agent process via terminate()
  }
}

export function createMacroAgentBackend(
  agentManager: AgentManager, config?: MacroAgentBackendConfig
): MacroAgentBackend;
```

### Session Format Conversion

Session data flows between three systems (macro-agent, cognitive-core, openhive) with different event formats.

**Current state (Phase 1):** Conversion logic lives inline in `src/cognitive/session-converter.ts` as a proto-implementation. This provides `convertUpdatesToSession()` (batch) and `updateSessionFromEvent()` (streaming, used by `runSession()`'s `onUpdate` callback).

**Future state:** Extract to [`agent-session-parser`](https://www.npmjs.com/package/agent-session-parser). The published v0.1.0 currently handles transcript file parsing (JSONL from Claude Code/Gemini CLI). The streaming `ExtendedSessionUpdate → CognitiveAgentSession` converter is a complementary module to add.

**Conversion flow:**
```
macro-agent                    session-converter.ts              cognitive-core
ExtendedSessionUpdate  ──────►  CognitiveAgentSession  ────────►  AgentSession
  (streaming via onUpdate)      (structurally compatible)          (identical shape)
```

**Mapping (implemented in `session-converter.ts`):**
| macro-agent event | → | cognitive-core type |
|--------------------|---|---------------------|
| `agent_message_chunk` (role: assistant) | → | `AgentMessage` (role: assistant) |
| `user_message_chunk` | → | `AgentMessage` (role: user) |
| `agent_thought_chunk` | → | `AgentMessage` (role: assistant) |
| `tool_call` | → | `ToolCall` (name from `title`, input from `rawInput`, startTime) |
| `tool_call_update` (status: completed) | → | `ToolCall` update (output from content blocks, endTime) |
| `tool_call_update` (status: failed) | → | `ToolCall` update (error, endTime) |
| `plan` | → | `AgentMessage` (role: assistant, `[Plan]` prefix) |

**Scope boundary:** session-converter handles **session format conversion only** (`ExtendedSessionUpdate[] ↔ CognitiveAgentSession`). Trajectory extraction (`AgentSession → Trajectory`) stays in cognitive-core's `DefaultTrajectoryExtractor`, since trajectories are a learning-specific concern with cognitive-core-specific semantics.

**agent-session-parser extraction plan:**
- Add `ExtendedSessionUpdate → UniversalSession` converter module alongside existing transcript parsers
- Provide `UniversalSession → AgentSession` converter for cognitive-core consumption
- Both macro-agent and cognitive-core depend on agent-session-parser, eliminating format coupling
- `session-converter.ts` becomes a thin wrapper around the library

### ComputeProvider Registration

cognitive-core's `ComputeProvider` resolves agent types to backends. `MacroAgentBackend` registers as a `ComputeSource`:

```typescript
// In cognitive-core setup
import { MacroAgentBackend } from 'macro-agent/cognitive';

const macroBackend = new MacroAgentBackend(agentManager);

atlas.getAgentManager().computeProvider.register({
  name: 'macro-agent',
  backend: macroBackend,
  costTier: 'medium',
  location: 'local',
  priority: 1,           // Preferred over subprocess
});
```

This means Atlas can fall back to `SubprocessBackend` when macro-agent isn't available — the resolution is automatic.

### Phase 1 Deliverables

| Component | Location | Status |
|-----------|----------|--------|
| `MacroAgentBackend` class + factory | `src/cognitive/macro-agent-backend.ts` | Done |
| `AnalystRole` definition | `src/cognitive/analyst-role.ts` | Done |
| Bridge types (no cognitive-core dep) | `src/cognitive/types.ts` | Done |
| Session converter (proto) | `src/cognitive/session-converter.ts` | Done (inline, extraction to agent-session-parser deferred) |
| Module exports | `src/cognitive/index.ts`, `src/index.ts` | Done |
| Unit tests (56 passing) | `src/cognitive/__tests__/` | Done |
| Integration test | `src/cognitive/__tests__/macro-agent-backend.e2e.test.ts` | Done |
| Backend registration | cognitive-core setup code | Pending (cognitive-core side) |
| agent-session-parser extraction | `agent-session-parser` package | Pending (separate repo) |

---

## Phase 2: Team-Integrated Workers (Path B)

Batch learning is the primary use case: `runBatchLearning()` processes accumulated trajectories periodically, dispatching one analysis task per trajectory plus a batch extraction. This means parallel execution is an operational baseline, not a scaling optimization. Phase 2 should follow Phase 1 closely.

### What Changes

The `MacroAgentBackend` spawns workers **under a persistent team coordinator** instead of as standalone agents. This is a config-level change — set `useTeam: true` in `MacroAgentBackendConfig`. The `AgentBackend` interface is unchanged — cognitive-core sees no difference.

```
Phase A:                              Phase B:
                                      ┌─────────────────────────┐
                                      │ TeamRuntime(cognitive-ops)│
                                      │   coordinator (persistent)│
                                      │     │                    │
atlas → MacroAgentBackend             │     ├── analyst-1        │
          ↓                            │     ├── analyst-2        │
  agentManager.spawn(worker)          │     └── analyst-3        │
  (standalone, no parent)             └─────────────────────────┘
                                      atlas → MacroAgentBackend
                                                ↓
                                        agentManager.spawn(analyst,
                                          parent=coordinator)
```

### Team Config

```yaml
# .multiagent/teams/cognitive-ops/team.yaml
name: cognitive-ops
description: Atlas cognitive analysis workers

topology:
  root: coordinator
  roles:
    coordinator:
      extends: coordinator
      max_agents: 1
    analyst:
      extends: worker
      max_agents: 4
      capabilities_remove:
        - agent.spawn.worker
        - workspace.merge
      capabilities_add:
        - cognitive.analyze

macro_agent:
  task_mode: pull
  atlas:
    enabled: true

communication:
  channels:
    analysis_updates:
      signals: [ANALYSIS_COMPLETE, EXTRACTION_COMPLETE]
  subscriptions:
    coordinator: [analysis_updates]
    analyst: [analysis_updates]
```

### Backend Changes

No code changes — set `useTeam: true` and `coordinatorAgentId` in `MacroAgentBackendConfig`. The spawn logic already respects these flags (see Phase 1 implementation). The analyst role definition moves from programmatic registration to team YAML, but the role name and capabilities stay the same.

### What This Enables

- **Parallel analysis:** Multiple workspace templates execute concurrently under the coordinator
- **Pull-mode claiming:** Analysts claim analysis tasks from a pool — cognitive-core pushes tasks, workers self-schedule
- **Signal routing:** Analysis completion signals route through team channels
- **Shared context:** Coordinator can inject cross-cutting context (e.g., "these 3 trajectories are from the same domain")
- **Resource management:** Team controls max concurrent analysts via `max_agents`

### Phase 2 Deliverables

| Component | Location | Effort |
|-----------|----------|--------|
| `cognitive-ops` team config | `.multiagent/teams/cognitive-ops/` | Small |
| `analyst` role (YAML) | `.multiagent/teams/cognitive-ops/roles/analyst.yaml` | Small |
| Coordinator prompt | `.multiagent/teams/cognitive-ops/prompts/coordinator.md` | Small |
| Pull-mode task integration | Backend pushes tasks to pool | Medium |
| Config switch | Set `useTeam: true` + wire coordinator ID | Small |

---

## Phase 3: Team-Native Cognitive Operations (Path C)

### What Changes

The macro-agent team **replaces** cognitive-core's `AgenticTaskRunner` orchestration. The coordinator role takes over batch scheduling, threshold checking, and MAP integration. Atlas's learning pipeline feeds work into the team, and the team produces results that flow back.

```
┌──────────────────────────────────────────────────────────┐
│  openhive                                                │
│    ├── cognitive.command (MAP) ────────────────────┐     │
│    └── session.complete (MAP) ◄───────────────┐    │     │
└───────────────────────────────────────────────┼────┼─────┘
                                                │    │
┌───────────────────────────────────────────────┼────┼─────┐
│  macro-agent TeamRuntime("cognitive-ops")      │    │     │
│                                               │    │     │
│  MAP Adapter                                  │    │     │
│    ├── x-openhive/cognitive.command ───────────┼────┘     │
│    ├── x-openhive/cognitive.result ◄──────────┤          │
│    └── x-openhive/session.complete ───────────┘          │
│                                                          │
│  coordinator (persistent, owns Atlas instance)           │
│    ├── receives cognitive.command via MAP                │
│    ├── manages analysis task pool                        │
│    ├── aggregates results, triggers batch learning       │
│    └── emits cognitive.result                            │
│                                                          │
│  analyst pool (pull-mode)                                │
│    ├── claims analysis/extraction tasks                  │
│    ├── runs workspace templates                          │
│    └── emits WORKER_DONE with structured output          │
│                                                          │
│  Session Lifecycle Hooks                                 │
│    ├── agent done() → trajectory conversion              │
│    ├── ACP events → ReAct trajectory (via agent-session-parser) │
│    └── emit session.complete notification                │
└──────────────────────────────────────────────────────────┘
```

### Atlas Initialization

When the `cognitive-ops` team config has `atlas.enabled`, the coordinator initializes Atlas:

```typescript
// In TeamRuntime or coordinator bootstrap
if (teamConfig.macro_agent?.atlas?.enabled) {
  const { Atlas } = await import('cognitive-core');
  this.atlas = await Atlas.create({
    workDir: path.join(workingDir, '.atlas'),
    learning: {
      minTrajectories: Infinity,       // openhive triggers manually
    },
    teamLearning: {
      enabled: true,
      minTeamTrajectories: Infinity,
    },
    memory: teamConfig.macro_agent.atlas.memory,
    analysis: {
      mode: teamConfig.macro_agent.atlas.analysisMode ?? 'heuristic',
    },
  });
}
```

### MAP Extensions

#### session.complete

Emitted after a macro-agent session reaches a terminal state and trajectory conversion is complete:

```typescript
{
  jsonrpc: '2.0',
  method: 'x-openhive/session.complete',
  params: {
    session_id: string,
    resource_id: string,
    agent_id: string,
    swarm_id: string,
    commit_hash: string,
    summary: {
      message_count: number,
      tool_call_count: number,
      outcome: 'success' | 'failure' | 'partial',
      duration_ms: number,
    },
    timestamp: string,        // ISO 8601
  }
}
```

#### cognitive.command

Incoming from openhive, dispatched to Atlas operations:

```typescript
{
  jsonrpc: '2.0',
  method: 'x-openhive/cognitive.command',
  params: {
    operation: 'extract' | 'prune' | 'team-extract' | 'query',
    config: { /* operation-specific */ },
    job_id: string,
  }
}
```

**Dispatch:**
| Operation | Atlas API | Result |
|-----------|-----------|--------|
| `extract` | `atlas.learning.runBatchLearning()` | `{ playbooks_count }` |
| `prune` | `atlas.memory.experiences.prune(config)` | `{ experiences_pruned }` |
| `team-extract` | `atlas.teamLearning.runBatchLearning()` | `{ team_playbooks_count }` |
| `query` | `atlas.memory.queryV2(query, options)` | `{ playbooks, experiences }` |

#### cognitive.result

Emitted after each operation completes:

```typescript
{
  jsonrpc: '2.0',
  method: 'x-openhive/cognitive.result',
  params: {
    job_id: string,
    operation: string,
    status: 'completed' | 'failed',
    result?: Record<string, unknown>,
    error?: string,
    metrics?: { duration_ms: number, ... },
  }
}
```

### Trajectory Lifecycle

In Phase 3, macro-agent handles the full trajectory lifecycle:

1. **Capture:** Agent runs, ACP events flow through `ExtendedSessionUpdate` stream
2. **Convert:** `agent-session-parser` converts to universal session format, then to ReAct `Trajectory`
3. **Ingest:** `atlas.processTrajectory(trajectory)` stores in `ExperienceMemory`
4. **Emit:** MAP notification `session.complete` tells openhive the trajectory is available
5. **Analyze:** When openhive triggers `cognitive.command(extract)`, Atlas's `AgenticTaskRunner` dispatches analysis to the analyst pool (via the same `MacroAgentBackend` from Phase 1)
6. **Learn:** Extracted playbooks feed back into Atlas's `SkillLibrary`, improving future agent performance

### Phase 3 Deliverables

| Component | Location | Effort |
|-----------|----------|--------|
| Atlas initialization in team bootstrap | `macro-agent/src/teams/team-runtime.ts` | Medium |
| MAP cognitive extensions | `macro-agent/src/map/adapter/extensions/cognitive.ts` | Medium |
| Session lifecycle hooks | `macro-agent/src/lifecycle/handlers/` | Medium |
| Trajectory conversion integration | Uses `agent-session-parser` | Small (reuse) |
| cognitive.command dispatch | `macro-agent/src/cognitive/` | Medium |
| Trajectory ingestion handler | `macro-agent/src/cognitive/` | Small |
| `atlas.close()` on team shutdown | `macro-agent/src/teams/team-runtime.ts` | Small |

---

## Session Identity & Format Conversion

### Session IDs

Session IDs are generated independently by each system:
- **macro-agent:** `session_{12-char-id}` (generated at spawn time)
- **cognitive-core:** Generated by `AgentManager` when tracking sessions
- **openhive:** Uses its own session/job IDs

These IDs are **consistent within their system** and **mapped across systems** via the `MacroAgentBackend`'s session tracking. The backend maintains a bidirectional map:

```typescript
// macro-agent session ID ↔ cognitive-core session ID
Map<CogCoreSessionId, { macroAgentId: AgentId, macroSessionId: SessionId }>
```

Neither system needs to adopt the other's ID format. The mapping is an implementation detail of the backend.

### agent-session-parser

[`agent-session-parser`](https://www.npmjs.com/package/agent-session-parser) is a shared library (we control both macro-agent and cognitive-core, and have write access to agent-session-parser) that provides:

- **Universal session format** — normalized representation of agent sessions across different systems
- **Bidirectional converters** — between macro-agent, cognitive-core, and ACP event formats
- **Trajectory extraction** — from universal sessions to ReAct trajectories
- **ID mapping utilities** — consistent cross-system identifier tracking

This library is the single place where format knowledge lives. When either system's event format changes, only the agent-session-parser converter updates — downstream consumers stay stable.

## Dependencies

### cognitive-core

Optional dependency of macro-agent — only loaded when Atlas is enabled (Phase 3). In Phase 1, cognitive-core depends on macro-agent's backend, not the other way around.

```typescript
// Phase 1: cognitive-core imports from macro-agent
import { MacroAgentBackend } from 'macro-agent/cognitive';

// Phase 3: macro-agent dynamically imports cognitive-core
const { Atlas } = await import('cognitive-core');
```

### agent-session-parser

Dependency of both macro-agent and cognitive-core for session format conversion. Should be a regular (non-optional) dependency since it's lightweight and always useful for trajectory work.

### openhive-types

Wire format types for MAP extensions. Dev/peer dependency for type-checking:

Types to be added:
- `MapSessionCompleteParams`
- `CognitiveCommandParams`
- `CognitiveResultParams`
- `CognitiveOperation` — `'extract' | 'prune' | 'team-extract' | 'query'`

## Summary: Progression Path

```
Phase 1 (Path A)                Phase 2 (Path B)              Phase 3 (Path C)
──────────────────              ──────────────────             ──────────────────
cognitive-core                  cognitive-core                 cognitive-core
  owns orchestration              owns orchestration             Atlas instance
  ↓                               ↓                             hosted in team
MacroAgentBackend               MacroAgentBackend              ↓
  spawns standalone workers       spawns into team             TeamRuntime
  ↓                               ↓                             coordinator owns Atlas
agentManager.spawn(worker)      agentManager.spawn(analyst,     analyst pool
  no parent                       parent=coordinator)            MAP extensions
  no team                         team channels                  session lifecycle
                                  pull-mode                      openhive integration
```

**What stays the same:** `AgentBackend.spawn() → AgentSession` contract, `agent-session-parser` conversion, session ID mapping.

**What evolves:** How macro-agent internally organizes and schedules the workers.

## Design Decisions

### 1. Analyst role from Phase 1

Use a dedicated `analyst` role with restricted capabilities (file read/write, exec, done). No git ops, no spawning, no workspace isolation (cognitive-core manages its own workspaces via `agent-workspace`).

`MacroAgentBackend` registers the role programmatically at construction. In Phase 2, the same role name moves to team YAML with no breaking change.

### 2. promptUntilDone() with configurable retries

Use `promptUntilDone()` for all workspace template execution. The retry count is configurable via `MacroAgentBackendConfig.maxFollowUps` (default: 1). One retry handles the common case where the agent needs a nudge to finalize output. If the agent doesn't complete after retries, the task falls through to cognitive-core's heuristic fallback or error handling.

### 3. Two-tier timeout with configurable ratios

Soft timeout at a configurable ratio (default: 80%) sends a "wrap up" message to give the agent a chance to write partial output. Hard timeout at 100% kills the process. Both thresholds derive from `AgentSpawnConfig.timeout`, which workspace templates set per complexity level (60s lightweight, 120s standard, 240s thorough).

Configurable via `MacroAgentBackendConfig.softTimeoutRatio`.

### 4. agent-session-parser: sessions only

agent-session-parser handles session format conversion (`ExtendedSessionUpdate[] ↔ AgentSession`). Trajectory extraction (`AgentSession → Trajectory`) stays in cognitive-core's `DefaultTrajectoryExtractor`. The boundary: sessions are universal, trajectories are learning artifacts.

### 5. Phase 2 expected from the start

Batch learning is the primary use case — `runBatchLearning()` processes accumulated trajectories periodically. Each batch run dispatches multiple analysis tasks (one per trajectory for analysis, then a batch extraction). This means Phase 2's parallel execution and pull-mode claiming are not a scaling optimization but a **baseline operational requirement**.

Phase 1 still comes first to validate the `AgentBackend` contract, session bridging, and analyst role. But the progression to Phase 2 should be planned from the start rather than treated as a future optimization. The `MacroAgentBackend` should be designed with `{ useTeam: boolean }` as a construction-time flag so the upgrade is a config change, not a refactor.

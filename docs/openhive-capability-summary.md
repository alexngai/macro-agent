# macro-agent: OpenHive Ecosystem Capability Summary

## 1. Architecture Overview

```
                          OpenHive Hub
                     (Fastify + SQLite/PG)
                    /ws/map  /api/v1  /ws
                            |
              MAP (JSON-RPC 2.0 over WebSocket)
                            |
           +----------------+----------------+
           |                                 |
   macro-agent Sidecar              cc-swarm Sidecar
   (AgentConnection outbound)       (AgentConnection outbound)
           |                                 |
   +-------+--------+              +---------+---------+
   | macro-agent     |              | Claude Code       |
   | (boot-v2.ts)    |              | (native teams)    |
   |                 |              |                   |
   | AgentManagerV2  |              | /swarm skill      |
   | InboxAdapter    |              | map-hook.mjs      |
   | TasksAdapter    |              | sidecar-server    |
   | ControlServer   |              | bootstrap.mjs     |
   | TriggerSystem   |              +-------------------+
   | MAP Server      |
   | ACP Server      |
   | REST API        |
   +-------+---------+
           |
     OpenSwarm TUI
     (MAP client, ACP-over-MAP)
```

### Key architectural difference

- **macro-agent** is a standalone orchestration process that spawns Claude Code (or other) agents as subprocesses. It owns agent lifecycle, messaging (agent-inbox), task management (opentasks), workspace isolation (git worktrees), and exposes both a MAP server (inbound) and MAP sidecar (outbound).

- **cc-swarm** is a Claude Code plugin that hooks into an existing Claude Code session. It uses Claude Code's native team features (`TeamCreate`, `SendMessage`, `TaskCreate`) for coordination and provides external observability via a MAP sidecar process.

---

## 2. Core Capabilities

macro-agent is a multi-agent orchestration system that provides:

| Capability | Implementation | Key File |
|---|---|---|
| **Hierarchical agent spawning** | `AgentManagerV2` — spawns Claude Code agents via `acp-factory`, manages parent-child relationships | `src/agent/agent-manager-v2.ts` |
| **Role-based agents** | Worker, Integrator, Coordinator, Monitor + custom YAML roles with capability inheritance | `src/roles/builtin/`, `src/roles/registry.ts` |
| **Team templates** | Declarative YAML topologies with per-team scoped messaging, signal filtering, emission validation | `src/teams/team-runtime-v2.ts`, `src/teams/team-manager-v2.ts` |
| **Messaging** | Embedded agent-inbox with IPC for MCP subprocesses, threading, federation, composite signal filters | `src/adapters/inbox-adapter.ts` |
| **Task management** | opentasks daemon IPC — task graph, dependencies, providers, claiming, pull-mode work | `src/adapters/tasks-adapter.ts` |
| **Workspace isolation** | Git worktrees via git-cascade, merge queue, pluggable integration strategies (queue/trunk/optimistic) | `src/workspace/` |
| **Control socket** | NDJSON-over-UNIX-socket RPC between MCP subprocesses and main process | `src/control/control-server.ts` |
| **Trigger system** | Pluggable routing strategies, WakeManager, SystemEventQueue, CronService, WebhookHandler | `src/trigger/trigger-system-v2.ts` |
| **ACP protocol** | Full Agent Client Protocol implementation with session management, streaming, permissions, extensions | `src/acp/macro-agent.ts` |
| **Health monitoring** | MCP subprocess heartbeat tracking, stale agent detection, parent notification | `src/boot-v2.ts` (lines 277-314) |

### MCP Tool Surface (per agent)

| Source | Tools |
|---|---|
| macro-agent core | `done`, `spawn_agent`, `stop_agent`, `get_hierarchy`, `inject_context` |
| macro-agent pull mode | `claim_task`, `unclaim_task`, `list_claimable_tasks` |
| agent-inbox | `send_message`, `check_inbox`, `read_thread`, `list_agents` |
| opentasks | `task`, `link`, `annotate`, `query` |

### ACP Extension Methods

```
_macro/spawnAgent, _macro/getHierarchy, _macro/getTask,
_macro/mountAgent, _macro/forkAgent, _macro/resume,
_macro/getHistory, _macro/getModels,
_macro/respondToPermission, _macro/cancelPermission, _macro/setPermissionMode
```

Plus stubbed peer extensions: `_macro/listPeers`, `_macro/getPeer`, `_macro/sendToPeer`, etc.

---

## 3. MAP Integration

macro-agent has two MAP components, both optional:

### 3a. MAP Server (inbound connections)

**File**: `src/map/server.ts`
**Config**: `mapServer: { enabled: true, port: 3002, host: "127.0.0.1", path: "/map" }`

Accepts inbound MAP connections from TUI clients and other MAP participants. Built on `MAPServer` from `@multi-agent-protocol/sdk/server`.

| Feature | Implementation |
|---|---|
| Agent discovery | `listAgents` / `subscribe` — synced from AgentManager lifecycle events |
| ACP-over-MAP | Full bridge (`src/map/acp-bridge.ts`) — MAP clients send ACP envelopes, routed to `createMacroAgent()` |
| Extension methods | `_macro/spawnAgent`, `_macro/getHierarchy`, `_macro/forkAgent`, `_macro/resume`, `_macro/task/list`, `_macro/getTask`, `_macro/getHistory`, `ping` |
| Trajectory forwarding | `trajectory/checkpoint` handler receives from child cc-swarm agents, forwards upstream to sidecar |
| ID mapping | Bidirectional `mapIdToLocalId` / `localIdToMapId` for routing between MAP ULIDs and local agent IDs |

### 3b. MAP Sidecar (outbound hub connection)

**File**: `src/map/sidecar.ts`
**Config**: `map: { enabled: true, server: "ws://hub:3000", token: "...", scope: "swarm:macro-agent" }`

Connects outbound to an OpenHive MAP hub via `AgentConnection` from `@multi-agent-protocol/sdk`.

| Sub-module | File | Purpose |
|---|---|---|
| **Lifecycle Bridge** | `src/map/lifecycle-bridge.ts` | Agent spawn → `connection.spawn()`, agent stop → `callExtension("map/agents/unregister")` |
| **Trajectory Reporter** | `src/map/trajectory-reporter.ts` | Sends checkpoints via `callExtension("trajectory/checkpoint")`, handles inbound `trajectory/content.request` |
| **Task Bridge** | `src/map/task-bridge.ts` | Emits `task.created`, `task.status`, `task.assigned`, `task.completed` to MAP scope |
| **Coordination Handler** | `src/map/coordination-handler.ts` | Handles inbound `x-openhive/task.assign`, `x-openhive/task.status`, `x-openhive/context.share`, `x-openhive/message.send`, `x-openhive/learning.workspace.execute` |

**Connection features**:
- Open mode (single call connect+register) and verified mode (connectOnly + authenticate + register)
- SDK-level reconnection (configurable maxRetries, baseDelay, maxDelay)
- Slow reconnection loop after SDK retries exhausted (default 60s interval)
- State change monitoring
- Declared capabilities: `trajectory.canReport: true`, `trajectory.canServeContent: false`, `tasks.canCreate/canAssign/canUpdate/canList: true`

---

## 4. OpenHive Integration

### What macro-agent provides to OpenHive

| Feature | Wire Format | OpenHive Handler |
|---|---|---|
| **Agent registration** | `connection.spawn({ agentId, name, role, scopes, metadata })` | MAP hub agent registry |
| **Agent unregistration** | `callExtension("map/agents/unregister", { agentId, reason })` | MAP hub agent registry |
| **Trajectory checkpoints** | `callExtension("trajectory/checkpoint", { checkpoint, resource_id })` | `src/map/trajectory-handler.ts` — auto-creates session resource, stores checkpoint |
| **Task events** | `connection.send({ scope }, { type: "task.created", task: {...} })` | Scoped MAP message delivery |
| **Content serving response** | `sendNotification("trajectory/content.response", { request_id, transcript })` | `src/map/trajectory-content.ts` |

### What OpenHive sends to macro-agent

| Feature | Wire Format | macro-agent Handler |
|---|---|---|
| **Task assignment** | `x-openhive/task.assign` notification | Creates task in opentasks, notifies assigned agent via inbox |
| **Task status update** | `x-openhive/task.status` notification | Transitions task state in opentasks |
| **Context sharing** | `x-openhive/context.share` notification | Delivers to all running agents via inbox |
| **Cross-swarm messaging** | `x-openhive/message.send` notification | Routes to coordinator or specific agent via inbox |
| **Workspace execution** | `x-openhive/learning.workspace.execute` notification | Delegates to cognitive module workspace handler |
| **Content request** | `trajectory/content.request` notification | Responds with minimal metadata (full transcript serving not yet implemented) |

### Trajectory Wire Format (cc-swarm compatible)

```typescript
interface TrajectoryCheckpointPayload {
  id: string;                    // "<sessionId>-step<N>"
  session_id: string;
  agent: string;
  branch: string | null;
  files_touched: string[];
  checkpoints_count: number;
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_tokens?: number;
    cache_read_tokens?: number;
    api_call_count?: number;
  };
  metadata?: {
    project?: string;
    projectPath?: string;
    firstPrompt?: string;        // Used as session description in OpenHive UI
    phase?: string;
    template?: string;
    [key: string]: unknown;
  };
}
```

---

## 5. OpenSwarm Integration

**Adapter**: `references/openswarm/src/hosting/adapters/macro-agent.ts` (`MacroAgentAdapter`)

OpenSwarm can host macro-agent as a managed swarm. The adapter:

1. Calls `bootV2()` with config derived from `AdapterConfig`
2. Enables ACP WebSocket server on `config.port`
3. Enables MAP server on `config.port + 2`
4. Optionally enables REST API on `config.options.apiPort`
5. Forwards MAP sidecar config from `options.map`
6. Exposes `getConnectionUrl()` returning the MAP server URL (for TUI connections)
7. Provides `getSystem()` for plugin-level access to `MacroAgentSystemV2`

### Bootstrap Token Auto-Wiring

**File**: `references/openswarm/src/hosting/config.ts` (lines 222-239)

When OpenHive spawns a swarm, it provides a base64-encoded `OPENSWARM_BOOTSTRAP_TOKEN`. The config loader automatically populates MAP sidecar config:

```typescript
// From the token:
token.adapter_config.map = {
  enabled: true,
  server: token.openhive_url.replace(/^http/, "ws") + "/ws/map",
  token: token.preauth_key,
  scope: `swarm:${token.swarm_name}`,
  agentName: `${token.swarm_name}-sidecar`,
  trajectorySyncLevel: "metrics",
};
```

This means: when OpenHive spawns a macro-agent swarm, the swarm automatically connects back to the hub with zero manual configuration.

### Default adapter

OpenSwarm's `DEFAULT_CONFIG.adapter.id` is `"macro-agent"` — it is the default hosting adapter.

---

## 6. Parity with cc-swarm (Feature Comparison)

| Feature | cc-swarm | macro-agent | Notes |
|---|---|---|---|
| **Agent spawning** | Claude Code native (`Agent` tool with `team_name`) | `AgentManagerV2.spawn()` via acp-factory | Both spawn Claude Code processes |
| **Team templates** | openteams YAML → `openteams generate all` → AGENT.md | openteams YAML → TeamRuntimeV2 → runtime topology | cc-swarm generates static files; macro-agent uses runtime wiring |
| **Messaging** | Claude Code native `SendMessage` | agent-inbox (embedded, IPC, threading, federation) | macro-agent has richer messaging primitives |
| **Task management** | Claude Code native `TaskCreate`/`TaskUpdate` + optional OpenTasks | opentasks (IPC daemon) + native `claim_task`/`unclaim_task` | Both support OpenTasks; macro-agent adds pull-mode claiming |
| **MAP sidecar** | Persistent Node.js process (`map-sidecar.mjs`) | Embedded in bootV2 (`src/map/sidecar.ts`) | cc-swarm runs a separate process; macro-agent runs in-process |
| **MAP server** | No (client-only) | Yes (`src/map/server.ts`) — accepts inbound MAP connections | Unique to macro-agent |
| **Agent lifecycle → MAP** | `conn.spawn()` / `conn.callExtension("map/agents/unregister")` | Same wire format via lifecycle-bridge | Compatible |
| **Trajectory reporting** | `trajectory/checkpoint` via `callExtension` (with `trajectory.checkpoint` broadcast fallback) | Same wire format via trajectory-reporter | Compatible; macro-agent also reports from ACP prompt handler |
| **Task → MAP bridge** | `bridge-task-created`, `bridge-task-status`, etc. via `conn.send()` | `task.created`, `task.status`, etc. via `conn.send()` | Event type names differ (`bridge-task-*` vs `task.*`); payload structure compatible |
| **Content serving** | Sessionlog transcripts via `trajectory/content.response` | Stub response ("not yet implemented") | Gap — macro-agent cannot serve full transcripts |
| **sessionlog integration** | Full — detects sessions, builds checkpoints from sessionlog state | Via cc-swarm-hooks integration (spawns cc-swarm sidecar per agent) | macro-agent can piggyback on cc-swarm's sessionlog |
| **Workspace isolation** | None (agents share the project directory) | Git worktrees with merge queue and integration strategies | Unique to macro-agent |
| **MeshPeer transport** | Supported (`mesh.enabled`) via agentic-mesh | Not supported | Gap |
| **minimem (memory)** | Supported — MCP server with semantic search | Not supported | Gap |
| **skill-tree (per-role skills)** | Supported — compiled into AGENT.md at generation time | Not supported | Gap |
| **Permission handling** | Not applicable (runs inside Claude Code) | Full ACP permission request/response flow | Unique to macro-agent |
| **ACP protocol** | Not applicable | Full ACP agent implementation with extensions | Unique to macro-agent |
| **Inbound coordination** | Not supported | `x-openhive/*` handlers for task assign, status, context share, messaging | Unique to macro-agent |
| **Federation** | Not supported | agent-inbox federation with peer routing | Unique to macro-agent |
| **OpenHive auto-wiring** | Via `SWARM_MAP_SERVER` env var + config | Via bootstrap token → `BootV2Config.map` | Both work; macro-agent's is more automatic |

---

## 7. Parity with Swarmkit Technologies

Swarmkit is a package manager for the swarm ecosystem. cc-swarm uses it to install global packages. Here is macro-agent's support for each:

| Swarmkit Package | cc-swarm Status | macro-agent Status | Notes |
|---|---|---|---|
| **openteams** | Core dependency — generates AGENT.md artifacts | Core dependency — `TeamRuntimeV2` loads team YAML directly | Both use openteams templates |
| **@multi-agent-protocol/sdk** | MAP connection + hooks | MAP sidecar + server (embedded) | macro-agent uses both client and server SDK |
| **agent-inbox** | Optional — messaging over MAP/mesh | Core dependency — embedded in-process, IPC for subprocesses | macro-agent uses agent-inbox more deeply |
| **opentasks** | Optional — MCP server + daemon IPC | Core dependency — `TasksAdapter` wraps opentasks client | macro-agent uses opentasks more deeply |
| **sessionlog** | Optional — session capture + trajectory sync | Not directly used (piggybacks via cc-swarm-hooks) | Gap — no native sessionlog integration |
| **minimem** | Optional — semantic memory MCP server | Not supported | Gap |
| **skill-tree** | Optional — per-role skill loadouts | Not supported | Gap |
| **agentic-mesh** | Optional — P2P encrypted transport | Not supported | Gap |
| **git-cascade** | Not used | Core dependency — workspace isolation, merge queue | Unique to macro-agent |
| **acp-factory** | Not used | Core dependency — spawns Claude Code via ACP | Unique to macro-agent |

---

## 8. What's Unique to macro-agent

Features that cc-swarm does not have:

1. **MAP Server (inbound connections)** — Accepts MAP client connections, enabling TUI interaction via ACP-over-MAP bridge. cc-swarm is client-only.

2. **ACP-over-MAP Bridge** (`src/map/acp-bridge.ts`) — MAP clients can send ACP envelopes to local agents. In-memory stream pairs wire to `createMacroAgent()`. Enables remote agent interaction through MAP protocol.

3. **Workspace Isolation** — Each worker agent gets an isolated git worktree. Changes are merged via a configurable integration strategy (queue, trunk, optimistic). Prevents agent conflicts.

4. **Merge Queue** — SQLite-backed queue for serialized integration of worker changes.

5. **Control Socket** — NDJSON-over-UNIX-socket RPC for lifecycle operations from MCP subprocesses. Separates control plane from data plane.

6. **Trigger System** — Pluggable routing strategies (direct, role, head, custom), WakeManager with inject/interrupt/prompt fallback chain, CronService, WebhookHandler. Enables event-driven agent activation.

7. **Full ACP Agent** (`src/acp/macro-agent.ts`) — Complete Agent Client Protocol implementation with session management, streaming updates, permission request/response, and 11+ extension methods.

8. **Inbound Coordination** (`src/map/coordination-handler.ts`) — Handles 5 `x-openhive/*` notification types: task assignment, task status, context sharing, messaging, workspace execution. Enables hub-directed orchestration.

9. **Pull-Mode Task Claiming** — Agents can claim tasks from a shared pool via `claim_task`/`unclaim_task`/`list_claimable_tasks` MCP tools (gated by `task.claim` capability).

10. **Agent Detection** — Discovers installed CLI coding agents (Claude Code, Codex, Goose) by scanning PATH, extracting version info, building headless invocation commands.

11. **Federation** — agent-inbox supports cross-instance communication via federation config with peer routing and trust policies.

12. **cc-swarm Hooks Integration** (`src/map/cc-swarm-hooks.ts`) — Can inject cc-swarm's shell hooks (SessionStart, Stop, SubagentStart, SubagentStop, PostToolUse, UserPromptSubmit) into spawned agents via acp-factory's programmatic hooks API. Also supports direct sidecar spawning via `startCCSwarmSidecar()`.

13. **Health Check Escalation** — 30-second health check loop detects stale MCP subprocesses (60s threshold) and notifies parent agents via inbox with `STALE_AGENT` event.

---

## 9. Known Gaps

| Gap | Severity | Details |
|---|---|---|
| **Transcript content serving** | Medium | `trajectory/content.request` handler returns stub response: "Full transcript serving not yet implemented". OpenHive's 5-tier resolution will fall through to tier 3/4/5. |
| **sessionlog native integration** | Low | No direct sessionlog integration. Relies on cc-swarm-hooks to inject sessionlog hooks into spawned agents. If cc-swarm is not installed, no session-level trajectory data beyond what the ACP prompt handler emits. |
| **MeshPeer transport** | Low | No agentic-mesh support. All MAP communication is direct WebSocket. |
| **minimem (agent memory)** | Low | No semantic memory integration. Agents have no persistent memory across sessions. |
| **skill-tree** | Low | No per-role skill loadout compilation. |
| **Task event type names** | Cosmetic | macro-agent emits `task.created`/`task.status`; cc-swarm emits `bridge-task-created`/`bridge-task-status`. Payload structures are compatible but type discriminants differ. OpenHive may need to handle both. |
| **Peer extensions** | Low | `_macro/listPeers`, `_macro/getPeer`, `_macro/sendToPeer`, etc. are declared but stubbed — return `NO_PEER_MANAGER` error. |
| **MAP agent state updates** | Low | The ACP prompt handler updates local MAP server agent state (idle/busy) but upstream sidecar state is not directly updated (commented code in `src/acp/macro-agent.ts` lines 510-517). |

---

## 10. Configuration

### boot-v2 Config (`BootV2Config`)

```typescript
const system = await bootV2({
  // Core
  cwd: "/path/to/project",
  baseDir: "~/.macro-agent",
  defaultPermissionMode: "auto-approve",
  defaultAgentType: "claude-code",

  // Messaging
  inbox: { socketPath: "/path/to/inbox.sock", sqlitePath: "/path/to/inbox.db" },

  // Tasks
  tasks: { /* opentasks client config */ },

  // Trigger system
  trigger: { enableHeartbeat: true, heartbeatIntervalMs: 5000 },

  // Federation
  federation: {
    systemId: "my-system",
    peers: [{ systemId: "peer-1", url: "ws://peer:3000" }],
    trust: { allowedSystems: ["peer-1"] },
  },

  // REST API (optional)
  api: { enabled: true, port: 3001, host: "127.0.0.1" },

  // ACP WebSocket server (optional)
  acp: { enabled: true, port: 3000, host: "127.0.0.1", path: "/acp" },

  // MAP server — inbound connections (optional)
  mapServer: { enabled: true, port: 3002, host: "127.0.0.1", path: "/map", name: "macro-agent" },

  // MAP sidecar — outbound hub connection (optional)
  map: {
    enabled: true,
    server: "ws://openhive-hub:3000",
    token: "api-key-or-preauth-key",
    scope: "swarm:my-project",
    systemId: "macro-agent",
    credential: "opaque-credential-for-verified-auth",
    agentName: "my-project-sidecar",
    trajectorySyncLevel: "metrics",  // "off" | "lifecycle" | "metrics" | "full"
    reconnectIntervalMs: 60000,
    reconnection: {
      enabled: true,
      maxRetries: 10,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    },
  },
});
```

### OpenSwarm Adapter Config

```json
{
  "adapter": { "id": "macro-agent" },
  "port": 3000,
  "host": "localhost"
}
```

Adapter-specific options (via `AdapterConfig.options`):
- `baseDir` — macro-agent data directory
- `defaultPermissionMode` — "auto-approve" (default)
- `apiPort` — Enable REST API on separate port
- `inbox`, `tasks`, `trigger` — Pass through to bootV2
- `federation` — Cross-instance config
- `map` — MAP sidecar config (auto-populated from bootstrap token)

### Bootstrap Token (auto-wiring)

Set `OPENSWARM_BOOTSTRAP_TOKEN` (base64 JSON):
```json
{
  "version": 1,
  "swarm_name": "my-swarm",
  "openhive_url": "http://hub:3000",
  "preauth_key": "preauthkey_abc123",
  "adapter": "macro-agent",
  "adapter_config": {},
  "expires_at": "2026-05-01T00:00:00Z"
}
```

The config loader auto-populates `adapter_config.map` from `openhive_url` + `preauth_key`, so the spawned swarm connects back to the hub automatically.

### cc-swarm Hooks Integration

To enable cc-swarm hooks on spawned agents (for sessionlog + trajectory):

1. Ensure cc-swarm is installed (plugin cache, marketplace, or references directory)
2. Enable the MAP server: `mapServer: { enabled: true }`
3. The `AgentManagerV2` calls `buildCCSwarmHooks(mapServerUrl, agentScope)` and passes hooks to acp-factory
4. Alternatively, call `startCCSwarmSidecar(mapServerUrl, scope, sessionId, cwd)` for direct sidecar spawning

cc-swarm is discovered at:
- `~/.claude/plugins/cache/claude-code-swarm/claude-code-swarm/<version>/`
- `~/.claude/plugins/marketplaces/claude-code-swarm/`
- `../../references/claude-code-swarm/` (development)

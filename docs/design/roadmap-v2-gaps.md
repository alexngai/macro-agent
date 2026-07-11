# V2 Roadmap: Deferred Gaps

> Post-migration backlog from the V1→V2 subsystem extraction.
> Each item was intentionally scoped out of the initial migration.
> Ordered by priority (what to build next).

## Phase A: External Connectivity

The entire network layer was deleted. V2 is CLI-only. These items restore programmatic and remote access.

### A1. REST API Server
**Priority:** High
**Effort:** Medium
**Why:** No programmatic HTTP access to the system. Dashboards, monitoring tools, and IDE integrations can't connect.

What V1 had:
- Express routes: GET/POST agents, tasks, teams, metrics, hierarchy
- WebSocket subscriptions for real-time agent/task/turn events
- Health endpoints

What V2 needs:
- Express (or Hono/Fastify) server in `src/api/`
- Routes that delegate to `MacroAgentSystemV2` services (agentManager, inboxAdapter, tasksAdapter, triggerSystem)
- Optional — can run standalone or embedded in boot-v2

Key decisions:
- Framework choice (Express is still a dep candidate, or go lighter)
- WebSocket for real-time updates (subscribe to inbox delivery events + agent lifecycle)
- Auth model (token-based, same as V1's `agentTokenManager`)

### A2. ACP WebSocket Server
**Priority:** High (if IDE/remote integration needed)
**Effort:** High
**Why:** The Agent Communication Protocol over WebSocket was how external tools (IDEs, remote agents) interacted with macro-agent. Without it, only local CLI access works.

What V1 had:
- `websocket-server.ts` — Multi-client WebSocket server at `/acp`
- `macro-agent.ts` — ACP agent implementation (initialize, newSession, loadSession, prompt, cancel, extensions)
- `session-mapper.ts` — Maps ACP session IDs to internal agent IDs
- Extension methods: `_macro/spawnAgent`, `_macro/getHierarchy`, `_macro/sendPeerMessage`, etc.

What V2 needs:
- WebSocket server wrapping `AgentManager` + `InboxAdapter` + `ControlServer`
- ACP protocol handler translating JSON-RPC to V2 service calls
- Session management (session → head manager mapping)
- Extension methods updated for V2 (no EventStore, use adapters)

Dependencies: A1 (shares the HTTP server)

### A3. MAP Protocol Bridge
**Priority:** Medium
**Effort:** Medium
**Why:** MAP (Multi-Agent Protocol) was the standard interop layer for connecting to other agent systems. With agent-inbox embedded, MAP support partially exists (inbox speaks MAP natively), but there's no server-side MAP endpoint for external MAP clients to connect to.

What V1 had:
- `map/adapter/` — Full MAP JSON-RPC adapter with connection/subscription lifecycle
- `map/federation/` — Cross-system message relay

What V2 can leverage:
- agent-inbox already supports MAP via `MapClient` and federation
- The gap is exposing macro-agent's MAP endpoint to external clients
- Could be as simple as wiring agent-inbox's MAP server to the HTTP/WS server from A1

### A4. Peer-to-Peer Multi-Instance
**Priority:** Low
**Effort:** High
**Why:** P2P communication between separate macro-agent instances. Only needed for distributed deployments.

What V1 had:
- `PeerManager` with WebSocket and local transports
- `CapabilityManager` for delegating capabilities across instances

What V2 can leverage:
- agent-inbox federation (encrypted P2P via agentic-mesh)
- Each macro-agent instance embeds its own agent-inbox
- Federation connects inboxes across instances automatically

The messaging layer is covered by inbox federation. The gap is coordination-level operations (spawn on remote instance, cross-instance hierarchy queries). This is a new design problem, not a restore.

---

## Phase B: Operational Gaps

Features that affect reliability and observability in production.

### B1. Metrics and Observability
**Priority:** High (for production)
**Effort:** Medium
**Why:** No aggregate throughput, utilization, or error metrics. Can't answer "how many tasks completed per hour?" or "which agents are idle?"

What V1 had:
- `ThroughputMetrics` — tasks completed/failed/created per time window, avg completion time
- `UtilizationMetrics` — active agents by role/state
- `ErrorMetrics` — errors by type/agent

What V2 needs:
- `src/metrics/` module that reads from AgentStore + ControlServer health data
- Counters: tasks created/completed/failed (from tasksAdapter or opentasks events)
- Gauges: running agents by role, active sessions, queue depth
- Histograms: task completion time, agent lifetime
- Export format: Prometheus-compatible or simple JSON endpoint (ties into A1)

### B2. Event Deduplication
**Priority:** Medium
**Effort:** Low
**Why:** Rapid inbox messages to the same agent can cause alert storms. V1's `deduplication.ts` used slot-based dedup to coalesce rapid events.

What V2 needs:
- Add dedup layer in `trigger-system-v2.ts` delivery handler
- Before enqueuing, check if an event with the same `sourceKey` was recently processed
- Simple time-window dedup: `Map<sourceKey, lastSeenTimestamp>` with TTL

Implementation: ~50 lines in the delivery handler. The `SystemEventQueue` already supports `sourceKey` for dedup hints — just need to check it before enqueuing.

### B3. Automated Health Check Escalation
**Priority:** Medium
**Effort:** Low
**Why:** V2 tracks heartbeats from MCP subprocesses via ControlServer but doesn't act on stale heartbeats automatically.

What V1 had:
- `HealthCheckService` — periodic check loop, consecutive failure counting, STALE_AGENT signal emission, zombie session cleanup

What V2 needs:
- Periodic loop in `boot-v2.ts` or `agent-manager-v2.ts` that calls `controlServer.getUnhealthyAgents(60000)`
- For unhealthy agents: emit warning via inbox to parent, optionally terminate after N missed heartbeats
- ~30 lines of `setInterval` logic

---

## Phase C: Feature Gaps

Capabilities that existed in V1 but were not essential for the V2 architecture migration.

### C1. Integrator Resolver Spawning
**Priority:** Medium
**Effort:** Medium
**Why:** V1's integrator done handler could detect merge conflicts and automatically spawn a "worker.resolver" agent to fix them. V2's integrator handler just emits `INTEGRATOR_DONE`.

What V1 had:
- `handleIntegratorDone()` processed merge queue, attempted merges, detected conflicts
- On conflict: spawned `worker.resolver` with conflict context, MR ID, resolver branch
- Resolver worked in a worktree, committed fix, emitted `RESOLVER_DONE`
- Integrator then merged the resolver's branch inline

What V2 needs:
- Re-add conflict detection to the integrator's done flow or to `AgentManagerV2.terminate()`
- Spawn resolver worker with workspace on conflict branch
- This ties into the workspace isolation flow

### C2. wait_for_activity MCP Tool
**Priority:** Low
**Effort:** Low
**Why:** Agents could block until a matching event occurred (e.g., "wait for child to complete"). V2 agents must poll `check_inbox` instead.

What V2 could do:
- Add `wait_for_activity` tool to `mcp-server-v2.ts`
- Implementation: poll `inboxAdapter.checkInbox()` with a timeout loop
- Or: use control socket to subscribe to events from main process

### C3. AI Router Strategy
**Priority:** Low
**Effort:** Medium
**Why:** V1 could fork a Claude session to make routing decisions for trigger events. Expensive but powerful for complex routing.

What V2 has:
- Pluggable `RoutingStrategy` interface already exists
- `registerStrategy()` API is available

What's needed:
- Implement `AIRouterStrategy` that spawns a lightweight Claude session
- Provide system state (agents, tasks, recent events) as context
- Parse routing decision from response
- Register via `triggerSystem.router.registerStrategy()`

### C4. Store Change Subscriptions
**Priority:** Low
**Effort:** Medium
**Why:** V1's EventStore had `onAgentChange()` and `onTaskChange()` subscriptions that components used for reactive updates. V2 has no equivalent.

What V2 does instead:
- Agent lifecycle callbacks via `agentManager.onLifecycleEvent()`
- Inbox delivery events via `inboxAdapter.onDelivery()`
- These cover the main reactive use cases

What's missing:
- No way to subscribe to AgentStore changes from outside the main process
- MCP subprocesses can't be notified when an agent's state changes

Low priority because the main use cases are covered by existing callbacks.

---

## Implementation Order

```
Immediate (high value, low effort):
  B2. Event Deduplication (~50 lines)
  B3. Health Check Escalation (~30 lines)

Next sprint (high value):
  B1. Metrics/Observability
  A1. REST API Server

When needed:
  A2. ACP WebSocket Server
  C1. Integrator Resolver Spawning

Later:
  A3. MAP Protocol Bridge
  C2. wait_for_activity Tool
  C3. AI Router Strategy
  C4. Store Change Subscriptions

Not until distributed deployment:
  A4. Peer-to-Peer Multi-Instance
```

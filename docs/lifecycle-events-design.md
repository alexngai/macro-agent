# Lifecycle Events Design

## Problem

macro-agent V2 has internal lifecycle events (`AgentManager.onLifecycleEvent`) but these don't propagate to:
1. **OpenHive hub** — needs to see agent spawn/stop for swarm monitoring
2. **Swarm Runner TUI** — needs events for dashboard updates (agent list, status indicators)
3. **TUI store** — expects `macro.status.emitted` events for milestone tracking (currently dormant)

## Current State

### What exists

- `AgentManager.onLifecycleEvent()` — callback for `spawned | started | stopped` events
- MAP sidecar lifecycle bridge — translates lifecycle → MAP `spawn()`/`unregister()` for hub
- MAP server lifecycle sync — registers/unregisters agents in MAPServer's agent registry
- MAPServer eventBus — emits `agent.registered`/`agent.unregistered` events (now working with SubscriptionManager patch)

### What's missing

1. **Rich status events** — `spawned`/`stopped` are lifecycle state changes. cc-swarm also emits milestone events like `checkpoint`, `blocked`, `discovery`. V2 doesn't have these.

2. **Session update events for observers** — when agent A prompts a child agent B, the ACP session updates from B are only visible to A's ACP stream. Other MAP clients (TUI observers) don't see B's activity unless they create their own ACP stream to B.

3. **Task state events via MAP** — when tasks transition in opentasks, no MAP events are emitted. The task bridge emits events via the sidecar (outbound to hub) but not via the MAP server (inbound for TUI).

## Design

### Layer 1: Enhanced lifecycle events

Extend `AgentLifecycleEvent` with richer event types:

```typescript
type AgentLifecycleEvent =
  | { type: "spawned"; agent: Agent }
  | { type: "started"; agent: Agent }
  | { type: "stopped"; agent: Agent; reason: StopReason }
  // New events:
  | { type: "state_changed"; agent: Agent; previousState: AgentState; newState: AgentState }
  | { type: "task_assigned"; agent: Agent; taskId: string }
  | { type: "prompt_started"; agent: Agent; promptLength: number }
  | { type: "prompt_completed"; agent: Agent; stopReason: string; tokenUsage?: TokenUsage }
```

Source: emit from `AgentManagerV2.spawn()`, `terminate()`, `prompt()`.

### Layer 2: MAP event emission

When lifecycle events fire, emit corresponding MAP events on the MAPServer's eventBus AND via the MAP sidecar:

| Lifecycle event | MAP server event (for TUI) | MAP sidecar event (for hub) |
|---|---|---|
| `spawned` | `agent.registered` (already works) | `agents/spawn` (already works) |
| `stopped` | `agent.unregistered` (already works) | `agents/unregister` (already works) |
| `state_changed` | `agent.state.changed` | `connection.updateState()` |
| `task_assigned` | Custom `macro.task.assigned` | `task.assigned` broadcast |
| `prompt_started` | Custom `macro.agent.busy` | State update to "busy" |
| `prompt_completed` | Custom `macro.agent.idle` + trajectory checkpoint | State update to "idle" + checkpoint |

### Layer 3: Session observation events

When any ACP session produces updates, broadcast them as MAP events so other clients can observe:

```
Agent B produces session update
  → ACP bridge sends to requesting client (A)
  → ACP bridge ALSO emits on MAPServer eventBus
  → Other clients subscribed to B's events see the update
  → TUI renders observed stream in real-time
```

This is partially implemented — the bridge emits `message_delivered` events on the eventBus (added this session). Needs verification that the TUI's "observed" stream handling picks these up correctly.

### Layer 4: StatusEvent bridge (for TUI backward compat)

The TUI store has handlers for `macro.status.emitted` events. To emit these:

```typescript
// In the MAP server lifecycle callback:
agentManager.onLifecycleEvent((event) => {
  if (event.type === "spawned") {
    mapServer.eventBus.emit({
      type: "macro.status.emitted",  // Custom event type
      data: {
        id: `status-${Date.now()}`,
        agentId: event.agent.id,
        statusType: "started",
        summary: `Agent ${event.agent.name} spawned`,
        timestamp: Date.now(),
      },
      source: { agentId: event.agent.id },
    });
  }
  // Similar for stopped, prompt_completed, etc.
});
```

The TUI's `macroAgentStore.eventHandlers["macro.status.emitted"]` would then update the status events in the store.

## Implementation Order

1. **Session observation** — verify the eventBus emission in acp-bridge.ts works for TUI observed streams
2. **StatusEvent bridge** — emit `macro.status.emitted` events from lifecycle callbacks in the MAP server
3. **Enhanced lifecycle events** — add `state_changed`, `prompt_started`, `prompt_completed` to AgentManagerV2
4. **Task state events** — emit `macro.task.*` events via MAP server when tasks transition

## Dependencies

- SubscriptionManager patch (done — `server.ts` step 2b)
- ACP bridge eventBus emission (done — `acp-bridge.ts`)
- MAP server lifecycle sync (done — `server.ts` step 6)

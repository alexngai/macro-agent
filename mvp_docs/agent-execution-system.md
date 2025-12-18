# Agent Execution System Design

**Status:** Draft  
**Date:** 2025-01-09  
**Related:** Multi-Agent Interaction System Design

---

## Overview

This document describes the execution system for agents in the multi-agent hierarchy. It covers how agents are spawned, managed, and terminated, and how they relate to the underlying agent implementation (e.g., Claude Code).

**Key principle:** The multi-agent system orchestrates and tracks agents via an event log and protocol wrapper, while delegating actual session management, checkpointing, and execution to the underlying agent implementation.

---

## Agent Spawning

### Who Can Spawn

Any agent can spawn other agents. This enables:
- Recursive task decomposition
- Task delegation to specialists
- User steering (via forks)
- Exploratory branches
- Utility agents for specific interactions

**Synchronous vs. Asynchronous:**
- **Native subagents** (e.g., Claude Code's built-in Task tool) — synchronous, tightly coupled, same session
- **System-level spawning** — asynchronous, independent sessions, for substantial/independent work

The multi-agent system handles asynchronous spawning only. Synchronous subtasks are handled by the underlying agent implementation.

### Spawn API

```
spawn_agent({
  task: string,                    // what this agent should do
  parent: agent_id,                // who spawned it (null for head manager)
  
  initial_context?: Context,       // starting state
  subscriptions?: [topic],         // explicit topics beyond defaults
  subscribe_parent?: boolean,      // default true; false for fire-and-forget
  config?: {
    model?: string,                // model to use
    timeout?: duration,            // max runtime
    resource_limits?: {...}        // compute constraints
  },
  fork_from?: session_id           // if forking from existing agent
}) → agent_id                      // returns immediately (reserved)
```

### Spawn Events

**On spawn request:**

```
{ type: spawn, 
  agent_id, 
  session_id,
  parent,
  task,
  fork_from?,
  timestamp }
```

**When agent is ready:**

```
{ type: status,
  agent_id,
  status_type: started,
  payload: { task_description, ... } }
```

Parent receives the `started` status via `subtree` subscription (if subscribed).

---

## Agent Lifecycle States

### State Diagram

```
   ┌───────────┐      ┌─────────┐      ┌─────────┐
   │ spawning  │─────▶│ running │─────▶│ stopped │
   └───────────┘      └─────────┘      └────┬────┘
                                            │
                                            │ resume
                                            ▼
                                      ┌─────────┐
                                      │ running │
                                      └─────────┘
```

### States

| State | Description |
|-------|-------------|
| `spawning` | Session being created, agent not yet running |
| `running` | Actively executing, can receive messages |
| `stopped` | Finished execution; session persisted, can be resumed |

### Properties

- All stopped agents are resumable by default (session always persisted)
- "Pause" is just `stopped` with intent to resume—no separate state needed
- The `terminate` event captures `reason` for context (completed, failed, stopped, timeout, cancelled)

---

## Resource Allocation

### Configuration Model

```
ResourceConfig {
  global: {
    max_concurrent_agents?: number,
    max_spawn_rate?: number,           // per minute
    max_message_rate?: number,         // per minute
  },
  per_parent: {
    max_children?: number,
    max_spawn_rate?: number,
  },
  per_agent: {
    max_runtime?: duration,
    max_tokens?: number,               // if virtualizing compute
  }
}
```

### Behavior at Limits

| Scenario | Response |
|----------|----------|
| Spawn when at capacity | Return error: "system at capacity, retry later" |
| Spawn when parent at child limit | Return error: "max children reached" |
| Rate limit hit | Throttle, return: "rate limited, request queued/delayed" |
| Agent exceeds runtime | System emits timeout notice |
| Absolute resource emergency | Pause all agents (drastic, rare) |

### Design Principles

- **Non-disruption priority:** Don't pause running agents; limit new allocations instead
- **Graceful degradation:** Agents receive feedback and can adapt
- **Interface first:** Define the interface now, enforce restrictions as needed later

### Agent Resource Awareness

Agents can query resource status:

```
get_resource_status() → {
  global: { agents_running, capacity, utilization },
  self: { children_running, children_limit, runtime_elapsed }
}
```

This enables agents to make informed decisions (e.g., consolidate rather than spawn when near limits).

---

## Session Management

### Delegation Model

Session management is delegated to the underlying agent implementation (e.g., Claude Code). The multi-agent system:
- References `session_id` in events
- Trusts that sessions are resumable/forkable
- Treats session contents as opaque

### Session-to-Agent Mapping

- Sessions can outlive agent execution
- Resuming or forking a session creates a new agent instance with that session's history
- Multiple agent instances may reference the same session over time (via resume)

### Checkpointing

| Aspect | Approach |
|--------|----------|
| Session checkpoints | Handled by underlying agent system |
| Git checkpoints | Handled by underlying agent system |
| Correlation | Correlated but separate (both may trigger at major state changes) |
| Multi-agent visibility | Out of scope; may add message logging for reconstruction later |

### Protocol Integration

The multi-agent system wraps a protocol (e.g., Agent Client Protocol) to:
- Start agents
- Send messages to agents
- Receive events from agents
- Manage agent lifecycle

```
┌─────────────────────────────────────────────────────────┐
│  Multi-Agent Orchestration Layer                        │
│  (event log, routing, subscriptions, coordination)      │
└─────────────────────────┬───────────────────────────────┘
                          │ protocol wrapper
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Agent Implementation (Claude Code, etc.)               │
│  (session management, execution, checkpointing)         │
└─────────────────────────────────────────────────────────┘
```

---

## Manager-Child Relationship

### Visibility

- Manager subscribes to `subtree:{child}` automatically (unless `subscribe_parent: false`)
- Child subscribes to `lineage:{self}` automatically
- Events include agent/task metadata for correlation

### Supervision Strategy

| Aspect | Approach |
|--------|----------|
| Failure notification | Manager receives `failed` status via `subtree` subscription |
| Recovery | Agentic—manager decides (retry, reassign, escalate, ignore) |
| Child limits | Not enforced; manager can self-limit via `get_resource_status()` |
| Task/agent mapping | Manager tracks in own context; events include metadata as redundancy |

### Failure Flow

```
Child agent fails
       │
       ▼
{ type: status, 
  agent_id: child, 
  task_id: X,
  status_type: failed,
  payload: { error, attempted, partial_results } }
       │
       ▼
Manager receives via subtree subscription
       │
       ▼
Manager decides: retry? reassign? escalate? continue without?
```

No system-level auto-retry. Manager has full context to make the appropriate decision.

### Control Tools

Managers have access to:

| Tool | Effect |
|------|--------|
| `stop_agent` | Terminate child execution |
| `inject_message` | Force-add message to child's context |
| `get_agent_summary` | Query child's current state |

---

## Fork Mechanics

### Overview

Forking creates a new agent from an existing agent's state. The fork is fully independent—source agent continues unaware.

### Fork API

```
fork_agent({
  source: agent_id | session_id,
  reason: string,                    // why forking
  task?: string,                     // new task (if different from source)
  
  initial_message?: string,          // first message to forked agent
  subscriptions?: [topic],
  config?: {...}
}) → agent_id
```

### Fork Properties

| Aspect | Approach |
|--------|----------|
| State copying | Full copy, delegated to agent implementation |
| Fork point | Current state (historical checkpoints future scope) |
| Forked agent orientation | System prompt includes fork context |
| Source notification | None—source continues unaware |
| Coordination | Fork can message source via standard messaging if needed |

### Forked Agent Context

The forked agent receives a system message orienting it:

```
{ role: system, 
  type: fork_context, 
  content: "You are a fork of Agent X (session_123), created because: {reason}.
            Your task: {task}. 
            You have full context from the original agent up to the fork point.
            You can message the original agent via standard messaging if coordination is needed." }
```

### Fork Event

```
{ type: fork,
  agent_id: new_agent,
  session_id: new_session,
  source_agent: original_agent_id,
  source_session: original_session_id,
  reason,
  timestamp }
```

---

## Summary

The agent execution system provides:

- **Asynchronous spawning** — independent agents for substantial work
- **Simple lifecycle** — spawning → running → stopped (resumable)
- **Flexible resource management** — configurable limits with graceful degradation
- **Delegated session management** — underlying agent system handles sessions
- **Agentic supervision** — managers receive events, decide on recovery
- **Independent forking** — full state copy, source unaware

**Key design principles:**
- Interface first, enforce later
- Delegate to agent implementation where appropriate
- Provide visibility and tools; let agents make intelligent decisions
- Non-disruption priority (don't interrupt running agents)

---

## Completed Design

1. ~~Agent spawning~~ ✓
2. ~~Agent lifecycle states~~ ✓
3. ~~Resource allocation~~ ✓
4. ~~Session management~~ ✓
5. ~~Manager-child relationship~~ ✓
6. ~~Fork mechanics~~ ✓

**Ready for data structure definitions.**

# Multi-Agent Interaction System Design

**Status:** Draft  
**Date:** 2025-01-09

---

## Overview

This document describes the design for a hierarchical multi-agent system with flexible interaction mechanisms between agents, managers, and users. The system prioritizes seamless user experience while maintaining clean separation of agent execution contexts.

---

## Execution Model

**Hybrid execution**: Agents are spawned on-demand but maintain their own state and context throughout their lifecycle. Manager/orchestrator nodes persist longer to coordinate child agents.

Key properties:
- Agents have a lifecycle: spawn → execute (with maintained context) → complete/terminate
- Agent state is persistent and replayable (checkpoint or event log based)
- Completed agents remain queryable for post-hoc inspection

---

## Agent Hierarchy

```
                    ┌─────────────────┐
                    │  Head Manager   │
                    │  (persistent)   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │ Manager  │   │ Manager  │   │ Manager  │
        │    A     │   │    B     │   │    C     │
        └────┬─────┘   └────┬─────┘   └──────────┘
             │              │
        ┌────┴────┐    ┌────┴────┐
        ▼         ▼    ▼         ▼
    ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐
    │Agent 1│ │Agent 2│ │Agent 3│ │Agent 4│
    └───────┘ └───────┘ └───────┘ └───────┘
```

Managers delegate tasks to child agents and maintain visibility into their subtree. Cross-branch communication occurs via the messaging system.

---

## User Interaction Model

Users interact with agents through three modes:

### 1. Observe (Passive)
Read an agent's context, logs, or current state without involving the agent.

### 2. Query (Inspector)
Ask questions about what an agent is doing or has done. Implemented as a short-lived inspector agent with read access to the target's state.

### 3. Steer (Fork)
Actively guide an agent's work. Implemented by forking the agent—user interacts with the fork, which can message the original.

**From the user's perspective, all three feel like "talking to Agent X."** The underlying machinery (forks, inspectors, messaging) is invisible.

---

## Mount Abstraction

The user has a single conversation terminal. Agent sessions are "mounted" to this terminal, similar to how processes attach to a shell.

```
┌─────────────────────────────────────┐
│  User Conversation Terminal         │
│  (single interface)                 │
└──────────────┬──────────────────────┘
               │ mount/unmount
               ▼
┌─────────────────────────────────────┐
│  Currently Mounted Session          │
│  - original agent                   │
│  - fork                             │
│  - inspector                        │
│                                     │
│  metadata: {                        │
│    agent_id, fork_of, parent,       │
│    mount_time, lineage, state       │
│  }                                  │
└─────────────────────────────────────┘
```

**Seamless switching**: Mount transitions are invisible to the user by default. Metadata is tracked and optionally displayable for power users.

---

## Fork Behavior

When a user initiates a steering interaction:

1. **Fork created**: New agent spawned from target's current state
2. **User interacts with fork**: Fork handles the conversation
3. **Fork can message original**: Uses standard agent-to-agent messaging
4. **Original can accept**: If original wants direct control, it can "accept" the conversation

### Accept/Handoff Flow

```
User starts talking to Agent X
         │
         ▼
┌─────────────────────┐
│ Fork X' created     │
│ User mounted to X'  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ X' handles convo    │
│ X' messages X       │◄─── async, via messaging system
└─────────┬───────────┘
          │
          ▼ (optional)
┌─────────────────────┐
│ X accepts convo     │
│ X' context → X      │
│ User remounted to X │
│ X' terminates       │
└─────────────────────┘
```

Forks are independent agents that happen to share lineage. They use the same messaging infrastructure as any peer agent—no special merge protocol.

---

## Context Merging: Layered Context Windows

Each session maintains its own context buffer. The user sees a unified view; agents see scoped views.

### User's View
Unified, stitched conversation across all sessions they've interacted with. Appears as one continuous thread.

### Agent's View
- Full fidelity for messages during its mount period
- Handoff summaries for context from other sessions

### Example

```
User sees (unified):       Agent X sees:           Fork Y saw:
────────────────────       ─────────────           ────────────
msg 1                      msg 1                   [summary: msgs 1-3]
msg 2                      msg 2                   msg 4
X reply                    X reply                 Y reply
msg 3                      msg 3                   msg 5
Y reply                    [summary: msgs 4-5]
msg 4                      msg 6
Y reply                    X reply
msg 5
X reply
msg 6
```

This preserves full context for the user while keeping agent context windows manageable.

---

## Agent-to-Agent Messaging

### Core Principles

**Async-by-default**: Messages are always asynchronous. Sender posts and continues (or explicitly waits). "Synchronous" behavior is achieved by an agent choosing to wait on a correlated response, possibly via sub-agent.

**Event log as source of truth**: All messages are events in an append-only, immutable log. State transitions (like "acknowledged") are new events referencing the original—events themselves never mutate.

**Materialized projections**: The system maintains a flattened, queryable state view projected from the event log. This can be rebuilt from the log at any time.

```
┌─────────────────────────────────────────────────────────┐
│  Event Log (append-only, immutable)                     │
│  ─────────────────────────────────────────────────────  │
│  [spawn A] [msg A→B] [ack B→A] [fork A→A'] [mount A']   │
└─────────────────────┬───────────────────────────────────┘
                      │ project/reduce
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Materialized State (queryable, rebuildable)            │
│  ─────────────────────────────────────────────────────  │
│  agents: { A: running, A': mounted, B: idle }           │
│  messages: { msg_1: { status: acked, ... } }            │
│  tasks: { task_1: { assigned: A, progress: ... } }      │
└─────────────────────────────────────────────────────────┘
```

### Event Schema

```
Event {
  id: unique identifier
  timestamp: when it occurred
  type: message | spawn | fork | terminate | mount | accept | status | system_notice | ...
  
  source: {
    agent_id: who/what emitted this
    task_id: task context (if applicable)
    lineage: [ancestry chain]
  }
  
  target: {
    agent_id: direct recipient (optional)
    task_id: task scope (optional)
    topic: pub/sub topic (optional)
    scope: subtree | branch | all (for broadcasts)
  }
  
  payload: {
    content: actual message/data
    correlation_id: for request/response threading
    priority: normal | urgent | ...
  }
  
  metadata: {
    ttl: expiration (optional)
    requires_ack: boolean
    ... extensible
  }
}
```

### Subscription Model

Agents receive events based on their subscriptions. Central projector maintains full system state; agents get scoped views.

**Subscription types:**

| Subscription | What it captures |
|--------------|------------------|
| `agent:{id}` | Direct messages to this agent |
| `task:{id}` | All events on a specific task |
| `lineage:{id}` | Events from agents in my ancestry |
| `subtree:{id}` | Everything in a manager's subtree |
| `topic:{name}` | Named pub/sub topic (e.g., "errors", "discoveries") |
| `broadcast:all` | System-wide broadcasts |

**Automatic subscriptions (at spawn):**
- Manager spawns child → manager subscribes to `subtree:{child}` (visibility downward)
- Child is spawned → child subscribes to `lineage:{self}` (visibility upward)
- All agents get `agent:{self}` and `task:{assigned}`

**Explicit subscriptions:**
- Topics defined at spawn time by parent/spawner
- Minimal by default; agents opt-in to additional topics

**Information flow:**

```
         Manager A
         [subscribes: subtree:A]
              │
              │ sees child events automatically
              ▼
         ┌────┴────┐
         ▼         ▼
     Agent B    Agent C
     [lineage]  [lineage]
     
     B and C see upward (to A)
     A sees downward (B and C)
     B and C don't see each other unless:
       - same explicit topic
       - direct message
```

Cross-branch communication requires intentional subscription or direct addressing.

---

## Agent-to-Manager Feedback

### Two-Tier Model

**Tier 1: Structured milestone events (pushed)**
Agents emit compact status events at defined moments, designed for manager consumption.

**Tier 2: Full event stream (queryable)**
The detailed agent trajectory exists in the log. Managers don't subscribe to it by default but can query when they need to drill down.

### Status Event Schema

```
StatusEvent {
  type: status
  source: { agent_id, task_id }
  
  status_type: 
    | started
    | checkpoint
    | blocked
    | discovery
    | completed
    | failed
  
  payload: {
    summary: string (human/agent readable)
    details: { ... }  // structured, varies by status_type
  }
}
```

**Details by status type:**

| status_type | details |
|-------------|---------|
| `started` | `{ task_description, estimated_effort }` |
| `checkpoint` | `{ progress, remaining, artifacts_so_far }` |
| `blocked` | `{ reason, needs, suggested_resolution }` |
| `discovery` | `{ what, relevance, suggested_action }` |
| `completed` | `{ result_summary, artifacts, usage }` |
| `failed` | `{ error, attempted, partial_results }` |

### Reporting Contract

**Minimum (required):**
- `started` — when agent begins work
- `completed` | `failed` — when agent finishes, with summary

**Optional (agent's discretion):**
- `checkpoint` — for long-running tasks, if agent deems it useful
- `discovery` — when agent finds something plan-relevant
- `blocked` — when agent can't proceed

Agents determine natural checkpoints based on their work. At minimum, they report a summary of task work and status at completion.

### System Safety Net

**Silent completion:**
If an agent's execution ends without a status event, the system emits a synthetic notice:

```
{ type: system_notice, 
  notice_type: silent_completion,
  agent_id, task_id }
```

Manager can then query the agent's trajectory or reactivate the agent for summary.

**Timeout:**
Configurable at system level. If an agent runs past the timeout:

```
{ type: system_notice,
  notice_type: timeout,
  agent_id, task_id }
```

Manager or user can intervene.

---

## Routing

### Overview

Users talk implicitly—they don't address specific agents. The currently mounted agent is the "first responder" and has tools to route elsewhere when needed.

### Routing Flow

```
User message
     │
     ▼
┌─────────────────────────────────────┐
│ Currently mounted agent             │
│ (or head manager if no mount)       │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│ Can I handle this?                  │
│  - Is it about my task/context?     │
│  - Do I have the information?       │
└─────────────────┬───────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
      Yes                   No
        │                   │
        ▼                   ▼
   Handle it         ┌─────────────────┐
                     │ Query tools:    │
                     │  - agent index  │
                     │  - task index   │
                     │  - hierarchy    │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ Route/delegate: │
                     │  - fork target  │
                     │  - spawn query  │
                     │  - remount user │
                     └─────────────────┘
```

### Index System

**Query interface (stable, implementation can evolve):**

```
query_index({
  type: agents | tasks | all
  filter: { status, parent, created_after, ... }
  search: string (natural language, optional)
  limit: number
  sort: recency | relevance | hybrid (default)
  archived: boolean (default false)
})
```

**Properties:**
- Recency scoring: recent/active items score higher, configurable decay curve
- Garbage collection: routine process archives stale entries (completed tasks older than X days)
- Archive fallback: if index miss and `archived=true`, searches historical data
- Stable interface: underlying implementation can evolve (keyword → semantic) without API changes

**Routing tools available to mounted agent:**

| Tool | Purpose |
|------|---------|
| `query_index` | Search agents/tasks with filters, recency-weighted |
| `get_hierarchy` | Tree view of current agent structure |
| `get_agent_summary` | Quick view of specific agent's state |
| `fork_agent` | Create fork for user steering |
| `spawn_inspector` | Create short-lived query agent |
| `remount_user` | Switch user's mounted session |

---

## Broadcast & Blackboard

### Core Principles

**Broadcasts are passive (pull-based):** Broadcast events update shared blackboard state. Agents check when convenient—no interruption to their flow.

**Active intervention is explicit:** Managers use targeted tools (`stop_agent`, `inject_message`) for intentional interruption.

### Blackboard Architecture

The blackboard uses a **ledger + materialized view** pattern, consistent with the event-sourced architecture:

```
┌─────────────────────┐      ┌─────────────────────┐
│ Blackboard Ledger   │      │ Materialized View   │
│ (append-only)       │─────▶│ (current state)     │
│                     │      │                     │
│ [001] set api=/v2   │      │ api: /v3            │
│ [002] set rate=100  │      │ rate: 100           │
│ [003] set api=/v3   │      │ warnings: [mem 80%] │
│ [004] add warning   │      │                     │
└─────────────────────┘      └─────────────────────┘
```

### Multiplexed Sections

The blackboard is a collection of sections, each with its own ledger + view. Interface supports different projection semantics per section (for future flexibility).

```
┌─────────────────────────────────────────────────────────────────┐
│                         Blackboard                              │
│─────────────────────────────────────────────────────────────────│
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  announcements  │  │  shared_state   │  │   discussions   │  │
│  │  (ledger+view)  │  │  (ledger+view)  │  │  (ledger+view)  │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Blackboard Interface

```
Blackboard {
  // Write (always appends to section's ledger)
  post(section: string, entry: {
    key?: string        // for key-value sections
    thread?: string     // for threaded sections
    content: any
    metadata?: {...}
  })
  
  // Read current materialized view
  read(section: string, filter?: {
    key?: string
    thread?: string
    limit?: number
  })
  
  // Get updates since last check (cursor-based)
  updates(section: string, since: cursor) → { entries, new_cursor }
  
  // List available sections
  list_sections() → [{ name, type, description }]
}
```

### Projection Types (future)

| Type | Projection behavior |
|------|---------------------|
| `append` | View = all entries in order |
| `key_value` | View = latest entry per key |
| `threaded` | View = entries grouped by thread |
| `windowed` | View = entries within time window |

For v1, all sections use `append` semantics.

### Active Intervention Tools

| Mechanism | Scope | Effect |
|-----------|-------|--------|
| `stop_agent` | Single agent | Terminates execution |
| `pause_agent` | Single agent | Suspends, can resume |
| `inject_message` | Single agent or subtree | Force-adds message to agent's context |
| `inject_all` | System-wide | Force-adds message to all running agents |

---

## Summary Generation & Context Handoff

### Core Principle

**Minimal interface, hidden complexity.** The handoff produces a single flattened system message that slots into the receiving agent's context. Merge strategies, summarization, and truncation are internal implementation details.

### Agent Interface

```
handoff_conversation({
  to: agent_id | session_id,
  context_hints?: {
    focus?: string,           // "user wants to change the API design"
    key_decisions?: [string], // ["chose REST over GraphQL"]
    open_questions?: [string] // ["auth strategy not decided"]
  }
})
```

### System Output

The system generates a single message for the receiving agent:

```
HandoffMessage {
  role: system,
  type: handoff_context,
  content: string,            // natural language summary/context
  metadata: {
    from_agent: agent_id,
    from_session: session_id,
    handoff_time: timestamp
  }
}
```

### What the Receiving Agent Sees

```
[
  { role: system, type: handoff_context, content: "Previous conversation 
    with Agent A: User asked to design an API for user management. Key 
    decisions: REST over GraphQL, using PostgreSQL. Open question: auth 
    strategy. User now wants to revisit the endpoint structure." },
  { role: user, content: "Can we add pagination to the list endpoint?" },
  ...
]
```

### Internal Merge Strategy (Progressive)

The system picks the simplest strategy that fits the token budget:

```
Context merge request
        │
        ▼
┌───────────────┐
│ Naive merge   │ ─── fits? ──▶ Done
│ (concatenate) │
└───────┬───────┘
        │ too long
        ▼
┌───────────────┐
│ Truncation    │ ─── fits? ──▶ Done
│ (recent N)    │
└───────┬───────┘
        │ still too long
        ▼
┌───────────────┐
│ Extraction    │ ─── fits? ──▶ Done
│ (key items)   │
└───────┬───────┘
        │ still too long
        ▼
┌───────────────┐
│ Summarization │ ──────────▶ Done
│ (compress)    │
└───────────────┘
```

### Design Properties

- **For users:** Seamless, no visible handoff mechanics
- **For agents:** One system message with prior context, nothing special to handle
- **For the system:** Flexible to change strategies without breaking interface

---

## Agent Termination & Persistence

### Core Principle

**Event log tracks lifecycle; session storage handles internal state.** The event log references `session_id`—agent conversation history and internal state live in the session system, which already has its own persistence.

```
┌─────────────────────────────────────────────────────────────┐
│  Event Log                                                  │
│  (lifecycle, messages, coordination)                        │
│─────────────────────────────────────────────────────────────│
│  { type: spawn, agent_id: A, session_id: sess_123, ... }    │
│  { type: status, agent_id: A, status_type: started, ... }   │
│  { type: message, from: A, to: B, ... }                     │
│  { type: status, agent_id: A, status_type: completed, ... } │
│  { type: terminate, agent_id: A, session_id: sess_123 }     │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ references
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Session Storage (external)                                 │
│  (conversation history, internal state)                     │
│─────────────────────────────────────────────────────────────│
│  sess_123/                                                  │
│    context.json                                             │
│    artifacts/                                               │
│    ...                                                      │
└─────────────────────────────────────────────────────────────┘
```

### Termination Triggers

| Trigger | Description |
|---------|-------------|
| Task completion | Agent finishes work, emits `completed` |
| Explicit failure | Agent can't proceed, emits `failed` |
| Manager termination | Parent calls `stop_agent` |
| Timeout | System-level safety, emits `system_notice` |
| User cancellation | User explicitly kills agent |

### Termination Flow (uniform for all causes)

```
Agent terminates (any reason)
         │
         ▼
┌─────────────────────────────────┐
│ Emit terminate event            │
│ { type: terminate,              │
│   agent_id, session_id,         │
│   reason: completed | failed |  │
│           stopped | timeout |   │
│           cancelled,            │
│   timestamp }                   │
└─────────────────────────────────┘
         │
         ▼
Session persists via session system (already happening)
```

### Resumption Flow

```
Resume request for Agent A
         │
         ▼
Query event log → find session_id
         │
         ▼
Load session from session storage
         │
         ▼
Spawn new agent instance with loaded session
         │
         ▼
Emit spawn event (with lineage reference to original)
```

### Archival

Optional: copy session files to archival storage if configured. Useful for long-term retention or compliance.

---

## Message Priority

### Core Principle

**No complex priority system.** Messages are flattened chronologically; agent triages and decides what to handle. Forced interrupts bypass the queue entirely.

### Normal Messages

- Flattened chronologically into agent's message view
- Agent sees all pending messages, decides what to handle
- Configurable soft limit per message (generous default, e.g., 1000 tokens)
- Over-limit messages truncated with reference to full content

```
┌─────────────────────────────────────────────────────────────┐
│  Message Queue (checked when agent is ready)                │
│─────────────────────────────────────────────────────────────│
│  [10:01] system: Resource warning - memory at 80%           │
│  [10:02] peer:B: FYI, found a bug in module X               │
│  [10:03] user: Can you check on the API progress?           │
│  [10:04] peer:C: [truncated] see full: msg_id_456           │
└─────────────────────────────────────────────────────────────┘
```

### Forced Interrupts

Injected directly into agent context (not the message queue). Agent sees them immediately as part of working context.

```
┌─────────────────────────────────────────────────────────────┐
│  Agent Context                                              │
│─────────────────────────────────────────────────────────────│
│  [...existing conversation...]                              │
│                                                             │
│  [INJECTED] manager: Stop current work, pivot to auth       │
│                                                             │
│  [...continues...]                                          │
└─────────────────────────────────────────────────────────────┘
```

### Channel Behavior Summary

| Channel | Behavior |
|---------|----------|
| Normal messages | Batched, chronological, agent triages |
| Injected messages | Inserted into context, unavoidable |
| Stop signal | Terminates execution immediately |

---

## Summary

This document defines a multi-agent interaction system with:

- **Hybrid execution model**: Agents spawned on-demand with persistent, replayable state
- **Three user interaction modes**: Observe, Query, Steer—all feeling like direct conversation
- **Mount abstraction**: User terminal attaches to agent sessions seamlessly
- **Fork behavior**: Independent agents with messaging back to original; can accept handoff
- **Layered context windows**: Users see unified view; agents see scoped view with summaries
- **Event-sourced messaging**: Append-only log with materialized projections
- **Subscription-based visibility**: Automatic lineage/subtree subscriptions, explicit topics
- **Milestone-based feedback**: Agents report at natural checkpoints; system safety net for silent completion
- **Index-based routing**: Mounted agent queries index to find/route to appropriate targets
- **Passive blackboard**: Multiplexed sections with ledger + view pattern
- **Progressive context merging**: Simplest strategy that fits; flattened handoff message
- **Session-based persistence**: Event log tracks lifecycle; session storage handles state
- **Flat message priority**: Chronological queue; forced interrupts bypass

---

## Completed Design

1. ~~Design agent-to-agent messaging system~~ ✓
2. ~~Define manager feedback mechanisms~~ ✓
3. ~~Specify routing and broadcast protocols~~ ✓
4. ~~Determine summary generation strategy~~ ✓
5. ~~Define persistence and termination behavior~~ ✓
6. ~~Establish priority/interrupt model~~ ✓

**Ready for implementation planning.**

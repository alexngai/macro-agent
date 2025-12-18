# Multi-Agent System Data Structures

**Status:** Draft  
**Date:** 2025-01-09  
**Related:** Multi-Agent Interaction System Design, Agent Execution System Design

---

## Overview

This document defines the data structures and schemas for the multi-agent system. These structures support the event-sourced architecture where the event log is the source of truth and materialized views provide queryable state.

---

## Core Entities

### Agent Record

Represents an agent instance in the system. Agents are spawned, execute work, and terminate. Their state is derived from events and cached in a materialized view.

```
Agent {
  // Identity
  id: agent_id                     // unique identifier
  session_id: session_id           // reference to underlying session
  
  // Hierarchy
  parent: agent_id | null          // who spawned this agent
  lineage: [agent_id]              // ancestry chain (root to parent)
  fork_from?: {                    // if this agent is a fork
    agent_id: agent_id,
    session_id: session_id
  }
  
  // State
  state: AgentState                // current lifecycle state
  stop_reason?: StopReason         // why agent stopped (if stopped)
  
  // Task
  task: string                     // description of agent's purpose
  task_id?: task_id                // explicit task assignment (if any)
  
  // Configuration
  subscriptions: [Subscription]    // event subscriptions
  config: AgentConfig
  
  // Timestamps
  created_at: timestamp
  started_at?: timestamp           // when agent began executing
  stopped_at?: timestamp           // when agent stopped
  
  // Derived (cached, rebuilt from events)
  children: [agent_id]             // agents where parent = this.id
}

AgentState = spawning | running | stopped

StopReason = completed | failed | stopped | timeout | cancelled

AgentConfig {
  model?: string                   // model to use
  timeout?: duration               // max runtime
  resource_limits?: {
    max_tokens?: number,
    max_children?: number,
    ... extensible
  }
}

Subscription {
  type: agent | task | lineage | subtree | topic | broadcast
  target: string                   // id or topic name
}
```

---

### Task Record

Represents a unit of work that can be assigned to agents. Tasks are first-class entities that can exist independently of agents and may be touched by multiple agents over their lifecycle.

```
Task {
  id: task_id                      // unique identifier
  description: string              // what needs to be done
  
  // Status
  status: TaskStatus
  
  // Assignment
  assigned_agent?: agent_id        // currently assigned agent
  agent_history: [AgentAssignment] // all agents that worked on this
  
  // Hierarchy (for decomposition)
  parent_task?: task_id            // parent task (if subtask)
  subtasks: [task_id]              // child tasks (derived from events)
  
  // Inputs/Outputs
  inputs?: { ... }                 // task inputs (flexible schema)
  outputs?: { ... }                // task outputs (flexible schema)
  artifacts?: [ArtifactRef]        // references to produced artifacts
  
  // Timestamps
  created_at: timestamp
  started_at?: timestamp           // when work began
  completed_at?: timestamp         // when task finished
  
  // Metadata
  created_by: agent_id             // who created this task
  metadata?: { ... }               // extensible
}

TaskStatus = pending | assigned | in_progress | completed | failed

AgentAssignment {
  agent_id: agent_id
  role: AssignmentRole
  started_at: timestamp
  ended_at?: timestamp
}

AssignmentRole = implementer | reviewer | verifier | advisor | ... extensible

ArtifactRef {
  type: file | commit | url | ...
  ref: string                      // path, sha, url, etc.
  description?: string
}
```

---

## Event System

### Base Event Schema

All events share a common structure. The event log is append-only and immutable.

```
Event {
  id: event_id                     // unique identifier
  timestamp: timestamp             // when event occurred
  type: EventType                  // event type discriminator
  
  source: EventSource              // who/what emitted this event
  target?: EventTarget             // intended recipient(s)
  
  payload: { ... }                 // type-specific data
  
  metadata?: EventMetadata         // optional metadata
}

EventSource {
  agent_id?: agent_id              // emitting agent
  task_id?: task_id                // task context
  lineage?: [agent_id]             // ancestry for routing
}

EventTarget {
  agent_id?: agent_id              // direct recipient
  task_id?: task_id                // task scope
  topic?: string                   // pub/sub topic
  scope?: TargetScope              // broadcast scope
}

TargetScope = subtree | branch | all

EventMetadata {
  correlation_id?: string          // for request/response threading
  ttl?: duration                   // expiration
  requires_ack?: boolean           // acknowledgment required
  ... extensible
}
```

---

### Event Types

#### Lifecycle Events

**SpawnEvent** — Agent created

```
SpawnEvent {
  type: "spawn"
  payload: {
    session_id: session_id
    parent: agent_id | null
    task: string
    task_id?: task_id
    config?: AgentConfig
    fork_from?: {
      agent_id: agent_id,
      session_id: session_id
    }
  }
}
```

**ForkEvent** — Agent forked from existing agent

```
ForkEvent {
  type: "fork"
  payload: {
    source_agent: agent_id
    source_session: session_id
    reason: string
  }
}
```

**TerminateEvent** — Agent stopped execution

```
TerminateEvent {
  type: "terminate"
  payload: {
    session_id: session_id
    reason: StopReason
  }
}
```

---

#### Status Events

**StatusEvent** — Agent milestone update

```
StatusEvent {
  type: "status"
  payload: {
    status_type: StatusType
    summary: string
    details: StatusDetails
  }
}

StatusType = started | checkpoint | blocked | discovery | completed | failed

StatusDetails (varies by status_type) {
  // started
  task_description?: string
  estimated_effort?: string
  
  // checkpoint
  progress?: string
  remaining?: string
  artifacts_so_far?: [ArtifactRef]
  
  // blocked
  reason?: string
  needs?: string
  suggested_resolution?: string
  
  // discovery
  what?: string
  relevance?: string
  suggested_action?: string
  
  // completed
  result_summary?: string
  artifacts?: [ArtifactRef]
  usage?: { ... }
  
  // failed
  error?: string
  attempted?: string
  partial_results?: { ... }
}
```

---

#### Messaging Events

**MessageEvent** — Agent-to-agent message

```
MessageEvent {
  type: "message"
  payload: {
    content: string | { ... }      // message content (full, inline)
    correlation_id?: string        // for threading
    priority?: MessagePriority
  }
}

MessagePriority = normal | urgent
```

**SystemNoticeEvent** — System-generated notification

```
SystemNoticeEvent {
  type: "system_notice"
  payload: {
    notice_type: NoticeType
    details: { ... }
  }
}

NoticeType = silent_completion | timeout | resource_warning | ...
```

---

#### User Interaction Events

**MountEvent** — User mounted to agent session

```
MountEvent {
  type: "mount"
  payload: {
    session_id: session_id
    previous_session?: session_id
    mount_type: MountType
  }
}

MountType = original | fork | inspector
```

**AcceptEvent** — Original agent accepted fork's conversation

```
AcceptEvent {
  type: "accept"
  payload: {
    from_fork: agent_id
    fork_session: session_id
    context_transferred: boolean
  }
}
```

---

#### Task Events

**TaskEvent** — Task lifecycle change

```
TaskEvent {
  type: "task"
  payload: {
    task_id: task_id
    action: TaskAction
    details: { ... }
  }
}

TaskAction = created | assigned | unassigned | status_change | completed | failed
```

---

#### Blackboard Events

**BlackboardPostEvent** — Blackboard update

```
BlackboardPostEvent {
  type: "blackboard_post"
  payload: {
    section: string
    key?: string                   // for key-value sections
    thread?: string                // for threaded sections
    content: any
  }
}
```

---

## Session Structures

### Session Reference

Sessions are managed by the underlying agent implementation. The multi-agent system only references them by ID.

```
SessionRef {
  session_id: string
  // Contents are opaque to multi-agent system
  // Underlying system handles: context, history, checkpoints, artifacts
}
```

---

### System-Injected Messages

Messages injected into agent context by the multi-agent system.

**HandoffMessage** — Context from previous session

```
HandoffMessage {
  role: "system"
  type: "handoff_context"
  content: string                  // natural language summary
  metadata: {
    from_agent: agent_id
    from_session: session_id
    handoff_time: timestamp
  }
}
```

**ForkContextMessage** — Orientation for forked agent

```
ForkContextMessage {
  role: "system"
  type: "fork_context"
  content: string                  // orientation message
  metadata: {
    source_agent: agent_id
    source_session: session_id
    reason: string
    fork_time: timestamp
  }
}
```

**InjectedMessage** — Forced message from manager/system

```
InjectedMessage {
  role: "system"
  type: "injected"
  content: string
  metadata: {
    injected_by: agent_id | "system"
    reason?: string
    timestamp: timestamp
  }
}
```

---

## Index Structures

### Agent Index Entry

Queryable entry for agent discovery and routing.

```
AgentIndexEntry {
  // Identity
  id: agent_id
  session_id: session_id
  parent: agent_id | null
  
  // State
  state: AgentState
  stop_reason?: StopReason
  
  // Task
  task_summary: string             // short description for display
  task_id?: task_id
  
  // Timestamps
  created_at: timestamp
  last_activity: timestamp
  
  // Search support
  keywords: [string]               // extracted for keyword search
  score: number                    // recency-weighted score
  
  // Future
  // embedding?: vector            // for semantic search
}
```

---

### Task Index Entry

Queryable entry for task discovery.

```
TaskIndexEntry {
  // Identity
  id: task_id
  
  // State
  status: TaskStatus
  assigned_agent?: agent_id
  
  // Description
  description: string
  
  // Timestamps
  created_at: timestamp
  last_activity: timestamp
  
  // Search support
  keywords: [string]
  score: number
  
  // Future
  // embedding?: vector
}
```

---

### Index Query

```
IndexQuery {
  type: agents | tasks | all
  
  filter?: {
    state?: AgentState | [AgentState]
    status?: TaskStatus | [TaskStatus]
    parent?: agent_id
    assigned_agent?: agent_id
    created_after?: timestamp
    created_before?: timestamp
    ... extensible
  }
  
  search?: string                  // natural language search
  
  sort?: recency | relevance | hybrid
  limit?: number
  offset?: number
  
  archived?: boolean               // include archived entries
}

IndexResult {
  entries: [AgentIndexEntry | TaskIndexEntry]
  total: number
  has_more: boolean
}
```

---

## Blackboard Structures

### Blackboard Entry

Individual entry posted to a blackboard section.

```
BlackboardEntry {
  id: entry_id
  section: string                  // which section
  
  // Structure hints (for projection)
  key?: string                     // for key-value sections
  thread?: string                  // for threaded sections
  
  // Content
  content: any                     // flexible payload
  
  // Metadata
  author: agent_id
  timestamp: timestamp
  metadata?: { ... }               // extensible
}
```

---

### Blackboard Section

Configuration for a blackboard section.

```
BlackboardSection {
  name: string
  description?: string
  
  // Projection behavior
  projection_type: ProjectionType
  
  // Future: access control
  // read_access?: [agent_id | role | "all"]
  // write_access?: [agent_id | role | "all"]
}

ProjectionType = append | key_value | threaded | windowed
```

---

### Blackboard View

Materialized view of a section's current state.

```
BlackboardView {
  section: string
  projection_type: ProjectionType
  
  // Content varies by projection type
  entries?: [BlackboardEntry]      // for append
  values?: { key: BlackboardEntry }  // for key_value
  threads?: { thread: [BlackboardEntry] }  // for threaded
  
  // Cursor for updates
  cursor: string
  last_updated: timestamp
}
```

---

## Resource Structures

### Resource Configuration

System-wide resource configuration.

```
ResourceConfig {
  global: {
    max_concurrent_agents?: number
    max_spawn_rate?: number        // per minute
    max_message_rate?: number      // per minute
  }
  
  per_parent: {
    max_children?: number
    max_spawn_rate?: number
  }
  
  per_agent: {
    max_runtime?: duration
    max_tokens?: number
  }
}
```

---

### Resource Status

Current resource utilization (queryable by agents).

```
ResourceStatus {
  global: {
    agents_running: number
    capacity: number
    utilization: number            // 0.0 - 1.0
  }
  
  self: {
    children_running: number
    children_limit?: number
    runtime_elapsed: duration
  }
}
```

---

## Type Definitions

### Primitive Types

```
agent_id: string                   // unique agent identifier
session_id: string                 // unique session identifier
task_id: string                    // unique task identifier
event_id: string                   // unique event identifier
entry_id: string                   // unique blackboard entry identifier
timestamp: number                  // Unix timestamp (milliseconds)
duration: number                   // Duration in milliseconds
```

---

## Summary

This document defines:

- **Agent Record** — agent identity, hierarchy, state, configuration
- **Task Record** — first-class work items with multi-agent lifecycle
- **Event Types** — lifecycle, status, messaging, user interaction, task, blackboard
- **Session Structures** — references and system-injected messages
- **Index Structures** — queryable entries for agents and tasks
- **Blackboard Structures** — entries, sections, and views
- **Resource Structures** — configuration and status

All structures support the event-sourced architecture where:
- Events are the source of truth (append-only, immutable)
- Materialized views provide queryable state (derived, cached)
- Sessions are opaque references to underlying agent implementation

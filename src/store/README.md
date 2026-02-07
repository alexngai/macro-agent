# Store Module

Event-sourced persistence layer for macro-agent. All state changes flow through the EventStore as append-only events.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        EventStore                            │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Agents    │  │    Tasks    │  │      Messages       │  │
│  │  lifecycle  │  │  lifecycle  │  │  routing & history  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│         │                │                   │               │
│         └────────────────┼───────────────────┘               │
│                          ▼                                   │
│              ┌─────────────────────┐                         │
│              │   Backend (SQLite   │                         │
│              │    or Memory)       │                         │
│              └─────────────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

## Components

### EventStore (`event-store.ts`)

Central interface for all state operations:

**Agent Operations:**
- `spawnAgent()` - Create new agent
- `updateAgentState()` - Change agent state
- `terminateAgent()` - End agent lifecycle
- `listAgents()`, `getAgent()` - Query agents

**Task Operations:**
- `createTask()` - Create new task
- `assignTask()` - Assign to agent
- `completeTask()`, `failTask()` - End task
- `listTasks()`, `getTask()` - Query tasks

**Event Operations:**
- `emit()` - Append event
- `getEvents()` - Query events
- `subscribe()` - Real-time subscriptions

### Types (`types/`)

Type definitions organized by domain:

- `agents.ts` - Agent state, lifecycle
- `tasks.ts` - Task state, assignment
- `events.ts` - Event types, payloads
- `primitives.ts` - Branded ID types (AgentId, TaskId, etc.)

### Backends (`backends/`)

Pluggable storage backends:

- `sqlite-backend.ts` - Persistent SQLite storage
- `memory-backend.ts` - In-memory (testing)

## Event Types

All state changes are events:

```typescript
type EventType =
  | "agent_spawned"
  | "agent_started"
  | "agent_terminated"
  | "task_created"
  | "task_assigned"
  | "task_completed"
  | "message"
  | "status";
```

## Usage

```typescript
import { createEventStore } from "./store/event-store.js";
import { createSQLiteBackend } from "./store/backends/sqlite-backend.js";

const backend = createSQLiteBackend("./data/events.db");
const store = createEventStore({ backend });

// Spawn an agent
const agent = store.spawnAgent({
  role: "worker",
  parent_id: coordinatorId,
});

// Emit an event
const event = store.emit({
  type: "message",
  source: { agent_id: senderId },
  target: { agent_id: recipientId },
  payload: { content: "Hello" },
});

// Subscribe to events
store.subscribe(agentId, { type: "topic", target: "updates" });
```

## Subscriptions

Agents can subscribe to:

- **Topic** - Named channels (e.g., "updates", "errors")
- **Agent** - Direct messages from specific agent
- **Task** - Events related to a task
- **Lineage** - Events from descendants

```typescript
// Subscribe to topic
store.subscribe(agentId, { type: "topic", target: "system-events" });

// Get subscribers
const subscribers = store.getSubscribers({ type: "topic", target: "updates" });
```

## ID Types

The store uses branded types for type safety:

```typescript
type AgentId = string & { readonly __brand: "AgentId" };
type TaskId = string & { readonly __brand: "TaskId" };
type EventId = string & { readonly __brand: "EventId" };
```

Note: Internal types use `agent_id` (snake_case), while MAP types use `agent`. See CLAUDE.md for naming conventions.

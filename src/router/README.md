# Router Module

Core internal message routing for macro-agent. Handles all agent-to-agent communication.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MessageRouter                            │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Legacy API  │  │ Address API │  │   Status/Events     │  │
│  │ send()      │  │ sendTo      │  │   emitStatus()      │  │
│  │ sendMessage │  │ Address()   │  │   subscribe()       │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│         │                │                   │               │
│         └────────────────┼───────────────────┘               │
│                          ▼                                   │
│                   ┌─────────────┐                            │
│                   │ EventStore  │                            │
│                   └─────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

## Components

### MessageRouter (`message-router.ts`)

The central routing authority. Two APIs:

**Legacy Channel-based** (`send`, `sendMessage`):
```typescript
router.send(from, { agent_id: targetId }, content);
router.send(from, { task_id: taskId }, content);
router.send(from, { topic: "updates" }, content);
```

**MAP Address-based** (`sendToAddress`):
```typescript
router.sendToAddress({
  from: agentId,
  to: { agent: targetId },
  content: "Hello",
  priority: "high",
});
```

### Channels (`channels.ts`, `types.ts`)

Channel types for legacy routing:
- `agent_id` - Direct to agent
- `task_id` - To task's assigned agent
- `topic` - Pub/sub topic
- `lineage` - To ancestors
- `subtree` - To descendants
- `broadcast` - System-wide

### Role Resolution (`role-resolver.ts`)

Resolves role-based addresses to agent IDs:

```typescript
const workers = resolveRoleTarget(agentSource, {
  role: "worker",
  scope: "project-1",  // Filter by scope membership
  coordinatorId: "coord-1",  // Filter by subtree
});
```

### Wake Logic (`wake.ts`)

Priority-based wake decisions:
- `urgent` → Interrupt current activity
- `high` → Inject into session (fallback: interrupt)
- `normal` → Wake if idle
- `low` → Queue only

### Broadcast (`broadcast.ts`)

Fan-out message delivery:
- `all` - All running agents
- `coordinators` - Agents with coordinator role
- `workers` - Agents with worker role
- `monitors` - Agents with monitor role

## Usage

```typescript
import { createMessageRouter } from "./router/message-router.js";

const router = createMessageRouter({
  eventStore,
  agentManager,
  federationHandler,  // Optional: for cross-system routing
});

// Send to agent
await router.sendToAddress({
  from: senderId,
  to: { agent: recipientId },
  content: "Hello",
});

// Send to role
await router.sendToAddress({
  from: senderId,
  to: { role: "worker" },
  content: "Task update",
});
```

## Relationship to Other Routers

| Router | Purpose | Entry Point |
|--------|---------|-------------|
| **MessageRouter** | Internal agent↔agent | AgentManager, MCP tools |
| **MAPAdapter** | External MAP clients | WebSocket connections |
| **TriggerRouter** | External events | Webhooks, cron |

MessageRouter is the **core authority** - other routers delegate to it.

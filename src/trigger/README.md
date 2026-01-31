# Trigger System

The trigger system provides event-driven activation for macro-agent's multi-agent hierarchy. It allows external and internal events to wake agents, route messages, and coordinate responses across the agent network.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                       External Sources                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │  Cron    │  │ Webhook  │  │ Channel  │  │ System   │            │
│  │ Service  │  │ Handler  │  │  Events  │  │  Events  │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
└───────┼─────────────┼─────────────┼─────────────┼───────────────────┘
        │             │             │             │
        └─────────────┴──────┬──────┴─────────────┘
                             │
                    ┌────────▼────────┐
                    │ Trigger Router  │  ← Pluggable Strategies
                    │  (route event)  │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
   ┌─────────┐        ┌─────────────┐      ┌───────────┐
   │ Inject  │        │   System    │      │   Wake    │
   │ Session │        │ Event Queue │      │  Manager  │
   └─────────┘        └─────────────┘      └───────────┘
                             │                    │
                             └────────────────────┘
                                      │
                              ┌───────▼───────┐
                              │    Agents     │
                              └───────────────┘
```

## Quick Start

```typescript
import { createTriggerSystem } from "./trigger/index.js";

// Create the trigger system with dependencies
const triggerSystem = createTriggerSystem({
  eventStore,
  agentManager,
  messageRouter,
});

// Start the system
await triggerSystem.start();

// Register a webhook endpoint
const endpoint = await triggerSystem.webhookHandler.registerEndpoint({
  name: "GitHub Events",
  methods: ["POST"],
  path: "/webhooks/github",
  enabled: true,
  wakeMode: "now",
  routing: { target: { type: "role", role: "ci-handler" } },
});

// Add a cron job
await triggerSystem.cronService.add({
  name: "Hourly Health Check",
  enabled: true,
  schedule: { kind: "every", everyMs: 3600_000 },
  sessionTarget: "main",
  wakeMode: "now",
  payload: { kind: "text", content: "Run health check" },
});

// Manually route a trigger event
const result = await triggerSystem.router.route(
  createTriggerEvent({
    source: { type: "internal", component: "api" },
    payload: { kind: "text", content: "User request" },
    wakeMode: "now",
    routing: { target: { type: "head" } },
  })
);
```

## Core Concepts

### Trigger Events

A `TriggerEvent` is the fundamental unit that flows through the system:

```typescript
interface TriggerEvent {
  id: string;                    // Unique identifier
  source: TriggerSource;         // Where it came from
  payload: TriggerPayload;       // The content (text or JSON)
  wakeMode: TriggerWakeMode;     // "now" | "next-prompt"
  timestamp: number;             // When it was created
  routing?: TriggerRoutingHint;  // Where to send it
  priority?: TriggerPriority;    // "low" | "normal" | "high" | "urgent"
}
```

### Wake Modes

- **`now`**: Immediately wake the agent using inject/interrupt/prompt chain
- **`next-prompt`**: Queue the event for delivery on the agent's next interaction

### Routing Targets

| Target Type | Description |
|-------------|-------------|
| `head` | Route to the root/coordinator agent |
| `agent` | Route to a specific agent by ID |
| `role` | Route to agent(s) with a specific role |
| `task` | Route to agent assigned to a task |
| `broadcast` | Fan-out to all agents on a channel |
| `ai-router` | Let AI decide routing based on system state |

## Components

### System Event Queue

Per-agent ephemeral queues for pending trigger events:

```typescript
// Queue an event for an agent
triggerSystem.queue.enqueue("New task available", {
  agentId: "agent_worker_1",
  priority: "high",
  sourceKey: "task:123", // Deduplication key
});

// Check for pending events
if (triggerSystem.queue.hasEvents("agent_worker_1")) {
  const events = triggerSystem.queue.drain("agent_worker_1");
}
```

### Trigger Router

Routes events to agents using pluggable strategies:

```typescript
// Built-in strategies: direct, head, role, broadcast, task, ai-router
const result = await triggerSystem.router.route(event);

// Register a custom strategy
triggerSystem.router.registerStrategy({
  name: "priority-router",
  canHandle: (event) => event.priority === "urgent",
  route: async (event, context) => ({
    targetAgents: ["agent_urgent_handler"],
    reason: "Urgent event routed to dedicated handler",
  }),
});
```

### Wake Manager

Delivers events to agents using a fallback chain:

1. **Inject** - Add context to active session (if supported)
2. **Interrupt** - Interrupt current processing with new context
3. **Prompt** - Send a new prompt to wake the agent

```typescript
// Start heartbeat-based wake polling
triggerSystem.wakeManager.start();

// Request immediate wake
triggerSystem.wakeManager.requestWakeNow({ reason: "urgent-alert" });

// Manually run a wake cycle
const result = await triggerSystem.wakeManager.runWakeCycle({ reason: "manual" });
```

### Cron Service

Time-based trigger scheduling:

```typescript
// One-shot at specific time
await triggerSystem.cronService.add({
  name: "Deployment",
  schedule: { kind: "at", atMs: Date.now() + 3600_000 },
  // ...
});

// Recurring interval
await triggerSystem.cronService.add({
  name: "Heartbeat",
  schedule: { kind: "every", everyMs: 60_000 },
  // ...
});

// Cron expression
await triggerSystem.cronService.add({
  name: "Daily Report",
  schedule: { kind: "cron", expr: "0 9 * * *" }, // 9 AM daily
  // ...
});
```

### Webhook Handler

HTTP trigger endpoints:

```typescript
// Register endpoint
const endpoint = await triggerSystem.webhookHandler.registerEndpoint({
  name: "Stripe Webhooks",
  methods: ["POST"],
  path: "/webhooks/stripe",
  enabled: true,
  secret: process.env.STRIPE_WEBHOOK_SECRET, // HMAC validation
  wakeMode: "now",
  routing: { target: { type: "role", role: "payment-handler" } },
});

// Handle incoming request (from your HTTP server)
const result = await triggerSystem.webhookHandler.handleRequest({
  endpointId: endpoint.id,
  method: "POST",
  path: "/webhooks/stripe",
  headers: req.headers,
  body: req.body,
  timestamp: Date.now(),
});
```

## Adding Custom Integrations

### Custom Trigger Source

```typescript
// Create a source that generates trigger events
function createSlackHandler(deps: {
  triggerRouter: TriggerRouter;
  wakeManager: TriggerWakeManager;
}) {
  return {
    handleMessage(message: SlackMessage) {
      const event = createTriggerEvent({
        source: {
          type: "channel",
          channelType: "slack",
          channelId: message.channel,
        },
        payload: { kind: "json", data: message },
        wakeMode: "now",
        routing: { target: { type: "role", role: "slack-responder" } },
      });

      deps.triggerRouter.route(event);
      deps.wakeManager.requestWakeNow({ reason: "slack-message" });
    },
  };
}
```

### Custom Routing Strategy

```typescript
const customStrategy: RoutingStrategy = {
  name: "load-balancer",
  description: "Distributes load across workers",

  canHandle(event) {
    return event.source.type === "webhook";
  },

  async route(event, context) {
    const workers = context.agentManager
      .list()
      .filter((a) => a.role === "worker" && a.state === "running");

    // Round-robin or least-loaded selection
    const target = selectLeastLoaded(workers);

    return {
      targetAgents: [target.id],
      reason: "Load balanced to least busy worker",
    };
  },
};

triggerSystem.router.registerStrategy(customStrategy);
```

## Configuration

### TriggerSystemConfig

```typescript
interface TriggerSystemConfig {
  // Enable AI-based routing strategy
  enableAIRouter?: boolean;

  // Wake manager settings
  wakeConfig?: {
    heartbeatIntervalMs?: number;  // Default: 30000
    wakeDelayMs?: number;          // Default: 100
    maxRetries?: number;           // Default: 3
  };

  // Cron service settings
  cronConfig?: {
    tickIntervalMs?: number;       // Default: 1000
  };

  // Queue settings
  queueConfig?: {
    maxEventsPerAgent?: number;    // Default: 100
  };
}
```

## Integration with macro-agent

The trigger system integrates with these macro-agent components:

- **AgentManager**: Spawns agents, manages sessions, delivers prompts
- **MessageRouter**: Existing message routing (compatible, not conflicting)
- **EventStore**: Event persistence and querying
- **WorkspaceManager**: Workspace isolation for spawned agents
- **RoleRegistry**: Role-based capability enforcement

### Relationship to MessageRouter

The trigger system complements (not replaces) MessageRouter:

| Component | Purpose |
|-----------|---------|
| **MessageRouter** | Agent-to-agent messaging, subscriptions, acknowledgments |
| **TriggerRouter** | External event routing, wake management, spawn decisions |

They can be used together:

```typescript
// Trigger routes external event to agent
await triggerSystem.router.route(webhookEvent);

// Agent uses MessageRouter for internal communication
await messageRouter.send({
  from: { agent_id: workerId },
  to: { agent_id: coordinatorId },
  content: "Webhook processed",
});
```

## Testing

Run tests:

```bash
# Unit tests
npm test -- src/trigger

# Integration tests
npm test -- src/trigger/__tests__/trigger-system-integration.test.ts

# Regression tests (macro-agent compatibility)
npm test -- src/trigger/__tests__/macro-agent-regression.test.ts
```

## File Structure

```
src/trigger/
├── index.ts                    # Main exports
├── types.ts                    # Core trigger types
├── trigger-system.ts           # System factory
│
├── queue/                      # Event queue
│   ├── types.ts
│   ├── system-event-queue.ts
│   └── index.ts
│
├── router/                     # Event routing
│   ├── types.ts
│   ├── trigger-router.ts
│   ├── index.ts
│   └── strategies/
│       ├── direct-strategy.ts
│       ├── head-strategy.ts
│       ├── role-strategy.ts
│       ├── broadcast-strategy.ts
│       ├── task-strategy.ts
│       ├── ai-router-strategy.ts
│       └── index.ts
│
├── wake/                       # Wake management
│   ├── types.ts
│   ├── wake-manager.ts
│   └── index.ts
│
├── sources/                    # Trigger sources
│   ├── cron/
│   │   ├── types.ts
│   │   ├── scheduler.ts
│   │   ├── cron-service.ts
│   │   └── index.ts
│   └── webhook/
│       ├── types.ts
│       ├── webhook-handler.ts
│       └── index.ts
│
└── __tests__/                  # Tests
    ├── system-event-queue.test.ts
    ├── scheduler.test.ts
    ├── routing-strategies.test.ts
    ├── trigger-router.test.ts
    ├── wake-manager.test.ts
    ├── cron-service.test.ts
    ├── webhook-handler.test.ts
    ├── trigger-system-integration.test.ts
    └── macro-agent-regression.test.ts
```

## Design Decisions

1. **Decoupled Wake Manager**: The wake manager is decoupled from `AgentManager.prompt()` to keep abstractions clean. It manages its own queue draining and delivery logic.

2. **Pluggable Routing Strategies**: The router uses a strategy pattern to allow different routing approaches (direct, role-based, AI-powered) without modifying core logic.

3. **Per-Agent Ephemeral Queues**: Events are queued per-agent in memory (not persisted) since they're ephemeral triggers, not durable messages.

4. **Fallback Delivery Chain**: Wake attempts inject → interrupt → prompt, gracefully degrading when features aren't available.

5. **AI Router as Optional Strategy**: The AI router is an optional strategy that can make intelligent routing decisions but falls back to simpler strategies if unavailable.

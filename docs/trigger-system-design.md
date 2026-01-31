# Trigger System Design

This document outlines the design for macro-agent's trigger system, enabling external and internal events to route to appropriate agents.

## Overview

The trigger system enables:
- **Cron scheduling** - Time-based agent activation
- **Webhooks** - External HTTP triggers
- **System events** - Internal event queue
- **Pluggable routing** - Flexible strategies including AI-based routing

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Trigger Sources                              │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────────┐  │
│  │   Cron     │ │  Webhook   │ │  System    │ │     Channel      │  │
│  │ Scheduler  │ │ Endpoints  │ │  Events    │ │    Adapters      │  │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └────────┬─────────┘  │
└────────┼──────────────┼──────────────┼─────────────────┼────────────┘
         │              │              │                 │
         └──────────────┴──────────────┴─────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Trigger Router                                 │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │            Routing Strategy Interface                          │ │
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────────────────────┐  │ │
│  │  │  Direct  │  │   Role   │  │      AI Router Agent        │  │ │
│  │  │ Strategy │  │ Strategy │  │  (fork session to decide)   │  │ │
│  │  └──────────┘  └──────────┘  └─────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    System Event Queue                                │
│         (Per-agent ephemeral queue - drain into next prompt)        │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Wake System Integration                           │
│  ┌─────────────┐         ┌─────────────┐        ┌───────────────┐   │
│  │ "next-prompt"│ ◄────► │    "now"    │ ─────► │ Existing Wake │   │
│  │  (queue only)│        │ (immediate) │        │ inject/interrupt│ │
│  └─────────────┘         └─────────────┘        └───────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/
├── trigger/                      # Trigger system root
│   ├── index.ts                  # Public exports
│   ├── types.ts                  # Core trigger types
│   │
│   ├── sources/                  # Trigger sources
│   │   ├── cron/                 # Cron scheduler
│   │   │   ├── cron-service.ts   # Main cron service
│   │   │   ├── scheduler.ts      # Schedule computation
│   │   │   ├── store.ts          # Job storage
│   │   │   └── types.ts
│   │   │
│   │   ├── webhook/              # Webhook endpoints
│   │   │   ├── webhook-handler.ts
│   │   │   └── types.ts
│   │   │
│   │   └── system-events/        # Internal system events
│   │       └── system-event-emitter.ts
│   │
│   ├── router/                   # Trigger router
│   │   ├── trigger-router.ts     # Main router
│   │   ├── types.ts              # Strategy interface
│   │   └── strategies/           # Pluggable strategies
│   │       ├── direct-strategy.ts
│   │       ├── role-strategy.ts
│   │       └── ai-router-strategy.ts
│   │
│   └── queue/                    # Per-agent event queue
│       ├── system-event-queue.ts
│       └── types.ts
```

## Core Types

### TriggerEvent

```typescript
interface TriggerEvent {
  id: string;
  source: TriggerSource;
  payload: TriggerPayload;
  wakeMode: "now" | "next-prompt";
  timestamp: number;
  routing?: TriggerRoutingHint;
  priority?: "low" | "normal" | "high" | "urgent";
}

type TriggerSource =
  | { type: "cron"; jobId: string; jobName: string }
  | { type: "webhook"; endpointId: string; method: string; path: string }
  | { type: "system"; eventType: string }
  | { type: "channel"; channelType: string; channelId: string };

type TriggerPayload =
  | { kind: "text"; content: string }
  | { kind: "json"; data: Record<string, unknown> }
  | { kind: "activity"; activityType: string; details?: Record<string, unknown> };
```

### Routing Strategy Interface

```typescript
interface RoutingStrategy {
  readonly name: string;

  route(
    event: TriggerEvent,
    context: RoutingContext
  ): Promise<RoutingDecision>;

  canHandle?(event: TriggerEvent): boolean;
}

interface RoutingDecision {
  targetAgents: AgentId[];
  spawnNew?: {
    task: string;
    role?: string;
    parentId?: AgentId;
  };
  additionalContext?: string;
  wakeModeOverride?: "now" | "next-prompt";
}
```

## Routing Strategies

### 1. Direct Strategy

Routes to explicitly specified agent ID. Validates agent exists and is running.

```typescript
// Usage
{
  routing: { targetAgentId: "worker_123" }
}
```

### 2. Role Strategy

Routes to agents by role using existing role resolution from MessageRouter.

```typescript
// Usage
{
  routing: { targetRole: "monitor" }
}
```

### 3. AI Router Strategy

Forks a router agent session to make intelligent routing decisions:

- Inspects current agent state via blackboard
- Reviews pending messages and task assignments
- Decides: route to existing, spawn new, or defer
- Uses messaging system to communicate decision

```typescript
// The AI router receives context like:
{
  trigger: TriggerEvent,
  activeAgents: AgentSummary[],
  pendingTasks: TaskSummary[],
  recentMessages: MessageSummary[],
  blackboardState: Record<string, unknown>
}

// And returns a decision:
{
  action: "route" | "spawn" | "defer",
  targetAgentId?: AgentId,
  spawnConfig?: { task: string, role: string },
  reason: string
}
```

## System Event Queue

Per-agent ephemeral queue (inspired by openclaw's `system-events.ts`):

```typescript
interface SystemEventQueue {
  enqueue(text: string, options: { agentId: AgentId }): void;
  drain(agentId: AgentId): QueuedSystemEvent[];
  drainText(agentId: AgentId): string[];
  peek(agentId: AgentId): string[];
  hasEvents(agentId: AgentId): boolean;
}
```

**Characteristics:**
- In-memory, ephemeral (no persistence)
- Max events limit with oldest eviction
- Consecutive duplicate filtering
- Drained into next prompt automatically

## Wake Modes

### `"next-prompt"` Mode

Events are queued and delivered when agent's next prompt occurs:
1. Event added to system event queue
2. On next `agentManager.prompt()`, queue is drained
3. Events prepended to prompt as system context

### `"now"` Mode

Immediate wake using existing inject/interrupt chain:
1. Event formatted as activity context
2. `wakeAgent()` called with appropriate priority
3. Falls through: inject → interrupt → queue

## Cron Service

Manages scheduled triggers:

```typescript
interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "now" | "next-prompt";
  payload: CronJobPayload;
  routing?: TriggerRoutingHint;
}

type CronSchedule =
  | { kind: "at"; atMs: number }              // One-shot
  | { kind: "every"; everyMs: number }        // Recurring
  | { kind: "cron"; expr: string; tz?: string }; // Cron expression
```

## API Endpoints

### Webhooks

```
POST   /api/webhook/:endpointId       # Receive webhook
GET    /api/webhooks                  # List configurations
POST   /api/webhooks                  # Create endpoint
DELETE /api/webhooks/:endpointId      # Remove endpoint
```

### Cron

```
GET    /api/cron/jobs                 # List jobs
POST   /api/cron/jobs                 # Create job
PATCH  /api/cron/jobs/:jobId          # Update job
DELETE /api/cron/jobs/:jobId          # Delete job
POST   /api/cron/jobs/:jobId/run      # Manual trigger
```

### Direct Trigger

```
POST   /api/trigger                   # Send trigger event
```

## Implementation Phases

### Phase 1: Foundation
- Core types (`src/trigger/types.ts`)
- System event queue
- Direct and role routing strategies
- Basic trigger router

### Phase 2: Wake Integration
- Modify `AgentManager.prompt()` to drain system events
- Add wake mode support to wake chain
- Integrate trigger router with `wakeAgent()`

### Phase 3: Cron Service
- Job storage (SQLite)
- Schedule computation
- Job lifecycle management
- Trigger router integration

### Phase 4: Webhooks
- Webhook handler
- Signature validation
- API endpoints

### Phase 5: AI Router Strategy
- Forked session routing
- Blackboard state provider
- Decision timeout/fallback

### Phase 6: Polish
- Full API integration
- MCP tools for agents
- Documentation

## Configuration

```bash
# Cron
MACRO_CRON_ENABLED=true
MACRO_CRON_STORE_PATH=:memory:

# Webhooks
MACRO_WEBHOOK_SECRET=xxx
MACRO_WEBHOOK_TIMEOUT_MS=30000

# AI Router
MACRO_AI_ROUTER_ENABLED=false
MACRO_AI_ROUTER_TIMEOUT_MS=10000
```

## References

- openclaw system events: `vendor/openclaw/src/infra/system-events.ts`
- openclaw cron service: `vendor/openclaw/src/cron/service/timer.ts`
- openclaw heartbeat wake: `vendor/openclaw/src/infra/heartbeat-wake.ts`
- Existing wake system: `src/agent/wake.ts`
- Existing message router: `src/router/message-router.ts`

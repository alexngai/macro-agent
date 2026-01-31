# Trigger System - AI Agent Instructions

This document provides instructions for AI coding agents working on the trigger system.

## Module Overview

The trigger system routes external and internal events to agents in the macro-agent hierarchy. It was designed based on patterns from [openclaw](https://github.com/openclaw/openclaw) and adapted for macro-agent's multi-agent architecture.

## Key Files and Their Purpose

| File | Purpose | When to Modify |
|------|---------|----------------|
| `types.ts` | Core types (`TriggerEvent`, `TriggerSource`, etc.) | Adding new source types or payload kinds |
| `trigger-system.ts` | Factory that wires all components | Adding new system-level components |
| `queue/system-event-queue.ts` | Per-agent event queues | Changing queue behavior or limits |
| `router/trigger-router.ts` | Main routing logic | Modifying delivery methods or strategy selection |
| `router/strategies/*.ts` | Individual routing strategies | Adding/modifying routing logic |
| `wake/wake-manager.ts` | Agent wake/delivery logic | Changing inject/interrupt/prompt chain |
| `sources/cron/cron-service.ts` | Cron job scheduling | Modifying schedule types or execution |
| `sources/webhook/webhook-handler.ts` | HTTP endpoint handling | Adding webhook features |

## Common Tasks

### Adding a New Trigger Source Type

1. Add the source type to `TriggerSource` union in `types.ts`:

```typescript
// types.ts
export type TriggerSource =
  | { type: "cron"; jobId: string; jobName: string }
  | { type: "webhook"; endpointId: string; method: string; path: string }
  | { type: "system"; eventType: string }
  | { type: "channel"; channelType: string; channelId: string }
  | { type: "internal"; component: string }
  | { type: "your-new-type"; /* your fields */ };  // ADD HERE
```

2. Update `formatTriggerSource()` in `types.ts` if needed for display.

3. Create handler in `sources/your-source/`:
   - `types.ts` - Source-specific types
   - `your-handler.ts` - Handler implementation
   - `index.ts` - Exports

4. Wire into `trigger-system.ts` if it's a core source.

### Adding a New Routing Strategy

1. Create strategy file in `router/strategies/`:

```typescript
// router/strategies/my-strategy.ts
import type { RoutingStrategy, RoutingContext, RoutingDecision } from "../types.js";
import type { TriggerEvent } from "../../types.js";

export interface MyStrategyOptions {
  // configuration options
}

export function createMyStrategy(options: MyStrategyOptions = {}): RoutingStrategy {
  return {
    name: "my-strategy",
    description: "What this strategy does",

    canHandle(event: TriggerEvent): boolean {
      // Return true if this strategy should handle this event
      return event.routing?.target?.type === "my-target-type";
    },

    async route(event: TriggerEvent, context: RoutingContext): Promise<RoutingDecision> {
      // Determine target agents
      return {
        targetAgents: ["agent_id"],
        reason: "Why this decision was made",
      };
    },

    // Optional lifecycle hooks
    async initialize?(context: RoutingContext): Promise<void> {},
    async shutdown?(): Promise<void> {},
  };
}
```

2. Export from `router/strategies/index.ts`.

3. Optionally register in `trigger-router.ts` default strategies.

4. Add tests in `__tests__/routing-strategies.test.ts`.

### Adding a New Cron Schedule Type

1. Add schedule kind to `CronSchedule` in `sources/cron/types.ts`:

```typescript
export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string }
  | { kind: "your-kind"; /* fields */ };  // ADD HERE
```

2. Update `computeNextRunTime()` in `sources/cron/scheduler.ts`.

3. Update `validateSchedule()` and `formatSchedule()` in scheduler.

4. Add tests in `__tests__/scheduler.test.ts`.

### Modifying the Wake Delivery Chain

The wake manager uses this fallback chain:
1. `inject()` - Add context to active session
2. `interruptWith()` - Interrupt with new context
3. `prompt()` - Send new prompt

To modify, edit `wake/wake-manager.ts`:

```typescript
// In deliverToAgent()
async function deliverToAgent(agentId: AgentId, content: string): Promise<AgentDrainResult> {
  // 1. Try inject
  if (session?.supportsInject?.()) {
    const result = await session.inject(content);
    if (result.success) return { method: "inject", success: true };
  }

  // 2. Try interrupt
  // ... your modifications here

  // 3. Fallback to prompt
  // ...
}
```

## Architecture Constraints

### DO

- Keep wake manager decoupled from `AgentManager.prompt()` internals
- Use the strategy pattern for routing decisions
- Maintain per-agent queue isolation
- Handle failures gracefully with fallbacks
- Use types from `store/types/` for agent/task IDs

### DON'T

- Don't persist trigger events to EventStore (they're ephemeral)
- Don't call `agentManager.prompt()` directly from the router (use wake manager)
- Don't modify MessageRouter behavior (trigger system complements it)
- Don't add blocking operations in the routing path

## Integration Points

### With AgentManager

```typescript
// Used for:
- list() - Get all agents for routing decisions
- get(id) - Check if target agent exists
- getSession(id) - Get session for inject/interrupt
- prompt(id, msg) - Wake agent with message
- spawn(opts) - Create new agent for trigger
```

### With MessageRouter

The trigger system is complementary, not replacing:

| Trigger System | MessageRouter |
|----------------|---------------|
| External → Agent | Agent → Agent |
| Wake/spawn decisions | Message delivery |
| Event routing | Subscription management |

### With EventStore

```typescript
// Used for:
- getAllTasks() - Task information for routing
- getAgent(id) - Agent lookup
- listAgents() - Agent enumeration
// NOT used for trigger event persistence
```

## Testing Guidelines

### Unit Tests

Each component has unit tests:
- `system-event-queue.test.ts` - Queue operations
- `scheduler.test.ts` - Cron schedule computation
- `routing-strategies.test.ts` - Individual strategies
- `trigger-router.test.ts` - Router logic
- `wake-manager.test.ts` - Wake delivery
- `cron-service.test.ts` - Job management
- `webhook-handler.test.ts` - HTTP handling

### Integration Tests

`trigger-system-integration.test.ts` tests end-to-end flows.

### Regression Tests

`macro-agent-regression.test.ts` ensures compatibility with:
- AgentManager lifecycle
- MessageRouter operations
- EventStore queries
- Role system

When making changes, run regression tests:

```bash
npm test -- src/trigger/__tests__/macro-agent-regression.test.ts
```

## Error Handling Patterns

### Graceful Degradation

```typescript
// Good: Try multiple approaches
async function deliverToAgent(agentId, content) {
  try {
    return await tryInject(agentId, content);
  } catch {
    try {
      return await tryInterrupt(agentId, content);
    } catch {
      return await fallbackToPrompt(agentId, content);
    }
  }
}

// Bad: Single point of failure
async function deliverToAgent(agentId, content) {
  return await tryInject(agentId, content); // Fails if inject unavailable
}
```

### Re-queuing on Failure

```typescript
// If delivery fails, re-queue for retry
if (!result.success) {
  queue.enqueue(content, { agentId, priority: "high" });
}
```

## Common Patterns

### Creating Trigger Events

```typescript
import { createTriggerEvent } from "../types.js";

const event = createTriggerEvent({
  source: { type: "webhook", endpointId: "ep1", method: "POST", path: "/hook" },
  payload: { kind: "json", data: { action: "deploy" } },
  wakeMode: "now",
  routing: { target: { type: "role", role: "deployer" } },
  priority: "high",
});
```

### Strategy Selection

The router selects strategies in order:
1. Strategies where `canHandle(event)` returns true
2. First matching strategy is used
3. If none match, uses default (head) strategy

### Queue Deduplication

```typescript
// Use sourceKey for deduplication
queue.enqueue("Event", {
  agentId: "agent_1",
  sourceKey: "webhook:endpoint_1:request_123", // Prevents duplicates
});
```

## Performance Considerations

- Queue has per-agent limits (default 100 events)
- Wake requests are coalesced (multiple requests = one wake cycle)
- Heartbeat polling is configurable (default 30s)
- Avoid blocking operations in routing strategies

## Debugging

Enable debug logging:

```typescript
const triggerSystem = createTriggerSystem(deps, {
  wakeConfig: { enableLogging: true },
});

// Or for AI router
const aiStrategy = createAIRouterStrategy({ enableLogging: true });
```

## Related Documentation

- `README.md` - User-facing documentation
- `docs/trigger-system-design.md` - Original design document
- `../CLAUDE.md` - Root project instructions
- `vendor/openclaw/` - Reference implementation (git submodule)

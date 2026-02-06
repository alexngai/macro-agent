# MAP Integration Module

Multi-Agent Protocol (MAP) integration for macro-agent, enabling standardized communication with external clients, agents, and gateways.

## Architecture

```
External Clients → MAPAdapter → MessageRouter → EventStore
(MAP protocol)     (translation)  (routing)      (persistence)
```

## Components

### Core Types (`types.ts`)

Defines MAP-compliant address types for message routing:

- **AgentAddress** - `{ agent: AgentId }` - Direct to agent
- **AgentsAddress** - `{ agents: AgentId[] }` - Multi-agent delivery
- **TaskAddress** - `{ task: TaskId }` - Route to assigned agent
- **ScopeAddress** - `{ scope: ScopeId }` - Scope-based pub/sub
- **RoleAddress** - `{ role: string, within?: ScopeId }` - Role-based fan-out
- **BroadcastAddress** - `{ broadcast: scope }` - System-wide broadcast
- **HierarchicalAddress** - Parent/children/ancestors/descendants/siblings
- **FederatedAddress** - Cross-system routing

### Adapter (`adapter/`)

The `MAPAdapter` handles external connections:

- **Connection Management** - Accept/disconnect participants
- **Authentication** - Validate credentials, assign capabilities
- **RPC Handling** - JSON-RPC 2.0 request/response
- **Subscriptions** - Event streaming to participants
- **Extensions** - Pluggable method handlers (spawn, wake, tasks)

Key files:
- `map-adapter.ts` - Core adapter implementation
- `connection-manager.ts` - Participant lifecycle
- `subscription-manager.ts` - Event subscriptions
- `rpc-handler.ts` - JSON-RPC processing
- `extensions/` - Extension method handlers

### Federation (`federation/`)

Cross-system communication:

- **FederationHandler** - Routes messages between MAP systems
- **PeerManager** - Manages connections to peer systems
- **SystemId** - Unique system identification (domain/system/instance)

## Usage

```typescript
import { createMAPAdapter } from "./map/adapter/index.js";

const adapter = createMAPAdapter({
  name: "my-system",
  authenticate: async (type, credentials) => {
    // Validate credentials
    return { allowed: true, capabilities: { canQuery: true } };
  },
});

await adapter.start();

// Accept WebSocket connection
const participant = await adapter.acceptConnection(stream);
```

## ID Naming Convention

MAP types use clean field names (`agent`, `task`) while internal types use explicit names (`agent_id`, `task_id`). See CLAUDE.md for details.

## Related Modules

- `router/` - Internal message routing (MessageRouter)
- `store/` - Event persistence (EventStore)
- `trigger/` - External event routing (TriggerRouter)

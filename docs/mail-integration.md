# Mail Protocol Integration Guide

This document describes how to integrate the MAP Mail Protocol into macro-agent, enabling structured conversation tracking across the agent hierarchy.

## Background

### What Mail Adds

macro-agent already coordinates multiple agents with message routing, status events, and lifecycle signals. Mail adds a **structured conversation layer** on top:

- **Conversations** — Named, stateful containers grouping related interactions (e.g., one per user session or delegated task)
- **Turns** — Ordered records of every message, status update, and tool call within a conversation
- **Threads** — Sub-conversations for branching discussions within a conversation
- **Participants** — Tracked membership with roles and permissions per conversation

Today, macro-agent's `conversationHistory[]` is a flat array on the API server with no structure. Internal agent-to-agent messages flow through the MessageRouter but aren't linked to any conversation context. Mail gives all of this a shared identity.

### What Doesn't Change

- Agent spawning still uses acp-factory
- The role system (worker, integrator, coordinator, monitor) stays the same
- Workspace isolation and merge queue are unaffected
- MCP remains the agent-facing tool interface

---

## Current Architecture vs Mail

| macro-agent today | With mail | What changes |
|---|---|---|
| `conversationHistory[]` flat array | `Conversation` with ordered `Turn[]` | Structured, queryable, has lifecycle |
| `MessageRouter.send()` fire-and-forget | `send()` with `mail` meta → auto-recorded turn | Messages become conversation turns |
| `emit_status()` broadcast | `recordTurn(contentType: 'event')` | Status events linked to conversations |
| `correlation_id` for reply threading | `threadId` within conversation | Threads are first-class, nestable |
| `done()` summary string | `closeConversation()` with summary | Completion tied to conversation lifecycle |
| No cross-session history | `listTurns()`, `replayConversation()` | Full audit trail per conversation |

---

## Integration Strategy

The recommended approach is **incremental overlay** — keep the existing MessageRouter and EventStore, add mail as a parallel tracking layer. This avoids a risky rewrite while getting mail benefits immediately.

### Dependencies

Add the MAP SDK as a dependency:

```bash
npm install @anthropic-ai/multi-agent-protocol
```

The key imports:

```typescript
import {
  MAPServer,
  type ConversationManager,
  type TurnManager,
  type ThreadManager,
} from '@anthropic-ai/multi-agent-protocol/server';
```

Or, if connecting to an external MAP server instead of embedding one:

```typescript
import { AgentConnection } from '@anthropic-ai/multi-agent-protocol';
```

---

## Phase 1: Conversation Lifecycle on API Server

**Goal**: Each user chat session gets a mail conversation. User messages and head manager responses become turns.

### Changes to `src/api/server.ts`

Replace the flat `conversationHistory[]` with a mail-backed conversation:

```typescript
// Before
interface ServerState {
  conversationHistory: Array<{
    role: 'user' | 'assistant';
    content: string;
    agent_id?: string;
    timestamp: number;
  }>;
}

// After
interface ServerState {
  activeConversationId: string | null;
  mailServer: MAPServer;  // or external connection
}
```

#### On system init (`POST /api/init`)

Create or configure the mail server:

```typescript
const mailServer = new MAPServer({
  name: 'macro-agent',
  mail: { enabled: true },
});
```

#### On user message (`POST /api/conversation/message`)

```typescript
// Create conversation on first message (or reuse active one)
if (!state.activeConversationId) {
  const result = await mailServer.conversations.create({
    type: 'user-session',
    subject: body.message.slice(0, 80),
    createdBy: 'user',
  });
  state.activeConversationId = result.id;
}

// Record user message as turn
await mailServer.turns.add({
  conversationId: state.activeConversationId,
  participant: 'user',
  contentType: 'text',
  content: { text: body.message },
});

// ... prompt head manager ...

// Record assistant response as turn
await mailServer.turns.add({
  conversationId: state.activeConversationId,
  participant: state.headManagerId,
  contentType: 'text',
  content: { text: responseContent },
});
```

#### On history query (`GET /api/conversation/history`)

```typescript
const { turns } = await mailServer.turns.list(
  state.activeConversationId,
  { order: 'asc', limit, offset }
);
```

### New module: `src/mail/mail-service.ts`

A thin wrapper that owns the MAPServer instance and exposes conversation operations:

```typescript
export interface MailService {
  /** Create a new conversation */
  createConversation(opts: {
    type: string;
    subject: string;
    createdBy: string;
    parentConversationId?: string;
  }): Promise<{ conversationId: string }>;

  /** Record a turn */
  recordTurn(opts: {
    conversationId: string;
    participant: string;
    contentType: string;
    content: unknown;
    threadId?: string;
  }): Promise<{ turnId: string }>;

  /** Close a conversation */
  closeConversation(opts: {
    conversationId: string;
    closedBy: string;
    summary?: string;
  }): Promise<void>;

  /** List turns for a conversation */
  listTurns(conversationId: string, opts?: {
    limit?: number;
    order?: 'asc' | 'desc';
    threadId?: string;
  }): Promise<Turn[]>;

  /** Get or create conversation for a session */
  getOrCreateSessionConversation(sessionKey: string): Promise<string>;
}
```

This keeps the rest of macro-agent decoupled from MAP internals.

---

## Phase 2: Mail Context in MessageRouter

**Goal**: When messages flow between agents, mail context (conversationId, threadId) travels with them. Turns are auto-recorded.

### Changes to `src/router/types.ts`

Add mail context to the message types:

```typescript
export interface SendMessageRequest {
  from: MessageSender;
  to: MessageTarget;
  content: string;
  correlation_id?: string;
  priority?: MessagePriority;
  // New: mail context
  mail?: {
    conversationId: string;
    threadId?: string;
  };
}

export interface SentMessage {
  id: EventId;
  from: MessageSender;
  to: MessageTarget;
  content: string;
  timestamp: Timestamp;
  correlation_id?: string;
  // New: mail context preserved
  mail?: {
    conversationId: string;
    threadId?: string;
  };
}

export interface ReceivedMessage {
  id: EventId;
  from: EventSource;
  content: string;
  timestamp: Timestamp;
  truncated: boolean;
  correlation_id?: string;
  // New: mail context for receivers
  mail?: {
    conversationId: string;
    threadId?: string;
  };
}
```

### Changes to `src/router/message-router.ts`

In the `send()` method, after routing the message, record a turn if mail context is present:

```typescript
async send(request: SendMessageRequest): Promise<SentMessage> {
  // ... existing routing logic ...

  // Record turn if mail context present
  if (request.mail?.conversationId && this.mailService) {
    try {
      await this.mailService.recordTurn({
        conversationId: request.mail.conversationId,
        participant: request.from.agent_id,
        contentType: 'data',
        content: { message: request.content },
        threadId: request.mail.threadId,
      });
    } catch (err) {
      // Never fail message delivery due to mail errors
      console.warn('Mail turn recording failed:', err);
    }
  }

  return sentMessage;
}
```

The `mail` field flows through to `ReceivedMessage` so receiving agents can see and forward it.

### Conversation-per-Task Pattern

When a coordinator spawns a worker for a task, create a child conversation:

```typescript
// In agent-manager.ts spawn()
if (parentMailContext?.conversationId && this.mailService) {
  const child = await this.mailService.createConversation({
    type: 'agent-task',
    subject: taskDescription,
    createdBy: parentAgentId,
    parentConversationId: parentMailContext.conversationId,
  });
  // Attach to the spawned agent's context
  agentMailContext.set(newAgentId, {
    conversationId: child.conversationId,
  });
}
```

This creates a conversation tree:
```
User Session (conv-001)
├── Head Manager delegates to Worker A (conv-002)
│   └── Worker A's tool calls and results
├── Head Manager delegates to Worker B (conv-003)
│   └── Worker B's tool calls and results
└── Head Manager final response
```

---

## Phase 3: MCP Tool Updates

**Goal**: Agents can interact with mail through their existing MCP tool interface.

### Update `send_message` tool

Add optional mail fields:

```typescript
const SendMessageSchema = {
  to: z.object({
    agent_id: z.string().optional(),
    task_id: z.string().optional(),
    topic: z.string().optional(),
  }).describe('Message target'),
  content: z.string().describe('Message content'),
  correlation_id: z.string().optional(),
  // New
  conversation_id: z.string().optional()
    .describe('Conversation ID for mail tracking (auto-set if in conversation context)'),
  thread_id: z.string().optional()
    .describe('Thread ID within conversation'),
};
```

The handler auto-injects conversation context from the agent's current context if not explicitly provided:

```typescript
// In send_message handler
const mailContext = args.conversation_id
  ? { conversationId: args.conversation_id, threadId: args.thread_id }
  : agentMailContext.get(context.agent_id);  // auto from spawn context

await messageRouter.send({
  from: { agent_id: context.agent_id },
  to: args.to,
  content: args.content,
  correlation_id: args.correlation_id,
  mail: mailContext,
});
```

### Update `check_messages` tool

Return mail context so agents can forward it:

```typescript
// In response formatting
messages.map(msg => ({
  id: msg.id,
  from: msg.from,
  content: msg.content,
  timestamp: msg.timestamp,
  conversation_id: msg.mail?.conversationId,  // New
  thread_id: msg.mail?.threadId,               // New
}));
```

### New `record_observation` tool

For Level 2 (conversation-aware) agents that want to record non-message turns:

```typescript
const RecordObservationSchema = {
  content_type: z.enum(['event', 'tool_call', 'tool_result', 'text'])
    .describe('Type of observation'),
  content: z.record(z.string(), z.unknown())
    .describe('Observation content'),
  conversation_id: z.string().optional()
    .describe('Conversation ID (defaults to agent context)'),
};
```

This lets agents record tool calls, intermediate results, or status changes as conversation turns without sending messages.

### Update `done()` tool

When an agent completes, close its conversation:

```typescript
// In done handler, after existing logic
const agentConvId = agentMailContext.get(context.agent_id);
if (agentConvId && mailService) {
  // Record completion turn
  await mailService.recordTurn({
    conversationId: agentConvId,
    participant: context.agent_id,
    contentType: 'event',
    content: {
      event: `agent.${args.status}`,
      summary: args.summary,
      details: args.details,
    },
  });

  // Close the conversation
  await mailService.closeConversation({
    conversationId: agentConvId,
    closedBy: context.agent_id,
    summary: args.summary,
  });
}
```

---

## Phase 4: Agent System Prompt Updates

**Goal**: Agents understand mail context and forward it naturally.

### Changes to `src/agent/system-prompt.ts`

Add a mail section to the system prompt for agents that may receive mail context:

#### Workers (Level 1 — pass-through)

```
## Message Context

Messages you receive may include a `conversation_id` field. This tracks the
conversation this work belongs to. When replying or sending messages, include
the same `conversation_id` to maintain the conversation chain:

  send_message({ to: { agent_id: "..." }, content: "...", conversation_id: "<from received message>" })

If no conversation_id is present, omit it — your message will still be delivered normally.
```

#### Coordinators (Level 3 — orchestrator)

```
## Conversation Tracking

When you spawn workers or delegate tasks, the system automatically creates
child conversations to track their work. You can:

- Use `record_observation` to log planning decisions or intermediate analysis
- Check conversation history via the conversation_id in status updates
- The `done()` call automatically closes the agent's conversation

All agent interactions within a task are recorded as conversation turns,
giving you a full audit trail of delegated work.
```

---

## Phase 5: WebSocket/Observer Integration

**Goal**: Dashboard clients can watch conversation turns in real-time.

### Changes to `src/api/server.ts` (WebSocket handling)

Add a `conversation` subscription channel that forwards mail events:

```typescript
// New WebSocket message types
type WSMessageType =
  | 'subscribe' | 'unsubscribe'
  | 'agent_update' | 'task_update'
  | 'message' | 'status' | 'error'
  | 'turn_added'        // New
  | 'conversation_update' // New
  ;
```

When mail events fire, broadcast to subscribed WebSocket clients:

```typescript
mailServer.eventBus.on('mail.turn.added', (event) => {
  broadcast(`conversation:${event.data.conversationId}`, {
    type: 'turn_added',
    data: event.data.turn,
  });
});

mailServer.eventBus.on('mail.closed', (event) => {
  broadcast(`conversation:${event.data.conversationId}`, {
    type: 'conversation_update',
    data: { status: 'closed', summary: event.data.summary },
  });
});
```

### New REST endpoints

```
GET  /api/conversations                    List conversations
GET  /api/conversations/:id                Get conversation details
GET  /api/conversations/:id/turns          List turns (paginated)
GET  /api/conversations/:id/threads        List threads
POST /api/conversations/:id/close          Close a conversation
```

---

## Data Flow: Complete Example

Here's how a user request flows through the system with mail enabled:

```
1. User sends "Refactor the auth module" via POST /api/conversation/message

2. API Server:
   - Creates conversation conv-001 (type: user-session)
   - Records Turn 1: user text "Refactor the auth module"
   - Prompts Head Manager with mail context { conversationId: conv-001 }

3. Head Manager (coordinator):
   - Spawns Worker A for "analyze current auth code"
     → Creates child conversation conv-002 (parent: conv-001)
   - Spawns Worker B for "write new auth implementation"
     → Creates child conversation conv-003 (parent: conv-001)
   - Records Turn 2: event { plan: "split into analyze + implement" }

4. Worker A receives message with { conversationId: conv-002 }:
   - Records Turn: event { tool: "file_read", file: "src/auth.ts" }
   - Records Turn: event { analysis: "found 3 issues..." }
   - Calls done(status: "completed", summary: "Analysis complete")
     → Records completion turn, closes conv-002
   - Sends results back to Head Manager with mail context

5. Head Manager receives Worker A results:
   - Turn auto-recorded in conv-001 (intercepted from message)
   - Forwards analysis to Worker B via message with conv-003 context

6. Worker B completes implementation:
   - Records tool call turns in conv-003
   - Calls done() → closes conv-003

7. Head Manager compiles final response:
   - Records Turn: text "Refactored auth module. Changes: ..."
   - Response returned to API Server

8. API Server:
   - Records Turn: assistant response in conv-001
   - Returns response to user

Conversation tree:
  conv-001 (user-session): 5 turns
  ├── conv-002 (agent-task: analyze): 4 turns
  └── conv-003 (agent-task: implement): 6 turns
```

---

## File Change Summary

| Phase | File | Change |
|---|---|---|
| 1 | `package.json` | Add `@anthropic-ai/multi-agent-protocol` dependency |
| 1 | `src/mail/mail-service.ts` | **New** — MailService wrapper around MAPServer |
| 1 | `src/mail/index.ts` | **New** — Barrel export |
| 1 | `src/api/server.ts` | Replace `conversationHistory[]` with mail-backed conversations |
| 2 | `src/router/types.ts` | Add `mail` field to message types |
| 2 | `src/router/message-router.ts` | Record turns on send when mail context present |
| 2 | `src/agent/agent-manager.ts` | Create child conversations on spawn, track agent mail context |
| 3 | `src/mcp/mcp-server.ts` | Add mail fields to send_message, check_messages; add record_observation tool |
| 3 | `src/mcp/tools/done.ts` | Record completion turn and close conversation on done() |
| 4 | `src/agent/system-prompt.ts` | Add mail context instructions per role |
| 5 | `src/api/server.ts` | Add conversation WebSocket channels and REST endpoints |
| 5 | `src/api/types.ts` | Add conversation-related API types |

---

## Configuration

Mail is opt-in. Add to macro-agent's config:

```typescript
interface MacroAgentConfig {
  // ... existing config ...

  /** Enable mail conversation tracking */
  mail?: {
    enabled: boolean;
    /** Connect to external MAP server instead of embedding one */
    serverUrl?: string;
    /** Custom stores for persistence (default: in-memory) */
    stores?: {
      conversations?: ConversationStore;
      turns?: TurnStore;
      threads?: ThreadStore;
    };
  };
}
```

When `mail.enabled` is false (default), all mail code paths are no-ops and no conversations are created.

---

## Testing Strategy

| Test | What it validates |
|---|---|
| `mail-service.test.ts` | MailService CRUD operations |
| `message-router.test.ts` | Existing tests still pass; new tests for mail context propagation |
| `api-server.test.ts` | Conversation endpoints return correct turns |
| `done.test.ts` | done() records completion turn and closes conversation |
| `mcp-server.test.ts` | send_message passes mail context; record_observation works |
| `integration.test.ts` | Full flow: user message → spawn → worker done → conversation tree |

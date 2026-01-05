# Multi-Agent System MVP Implementation Plan

**Status:** Draft  
**Date:** 2025-01-09  
**Phase:** MVP (Phase 1)

---

## Overview

This document describes the implementation plan for the MVP of the multi-agent system. The goal is a working system where a user can interact with a head manager agent that can spawn child agents for complex task decomposition.

### MVP Target Flow

```
User (CLI) → API → Head Manager Agent
                        │
                        ├── Spawns child agents via ACP
                        ├── Receives status updates via messaging
                        ├── Queries child state/results
                        └── Synthesizes and responds to user
```

### Success Criteria

- [ ] User can start system and interact via CLI
- [ ] Head manager spawns on first interaction
- [ ] Head manager can spawn child agents for subtasks
- [ ] Child agents execute work via Claude Code
- [ ] Status flows from children to parent via messaging
- [ ] Parent can query agent/task state
- [ ] Results flow back to user
- [ ] History persists across sessions

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI (lightweight)                        │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ HTTP/WebSocket
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                              API                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Routes    │  │  WebSocket  │  │     MCP Server          │  │
│  │  (REST)     │  │  (realtime) │  │   (agent tools)         │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
└─────────┼────────────────┼─────────────────────┼────────────────┘
          │                │                     │
          └────────────────┼─────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Core Services                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  Agent Manager  │  │  Task Manager   │  │ Message Router  │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  │
└───────────┼────────────────────┼────────────────────┼───────────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Event Store (TinyBase)                        │
│  ┌─────────────────┐  ┌─────────────────────────────────────┐   │
│  │   Event Log     │  │       Materialized Views            │   │
│  │  (append-only)  │  │  (agents, tasks, messages, etc.)    │   │
│  └─────────────────┘  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ACP Wrapper (separate scope)                  │
│                    (Claude Code integration)                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Local Environment

### Directory Structure

```
~/.multiagent/
├── config.json           # System configuration
├── store.db              # TinyBase persistent storage
└── logs/                 # Optional: debug logs
```

### Configuration Schema

```json
{
  "version": "1.0.0",
  
  "storage": {
    "path": "~/.multiagent/store.db"
  },
  
  "api": {
    "port": 3000,
    "host": "localhost"
  },
  
  "acp": {
    "endpoint": "...",
    "timeout": 300000
  },
  
  "agents": {
    "default_model": "claude-sonnet-4-20250514",
    "default_timeout": 1800000
  },
  
  "system": {
    "head_manager_task": "You are the head manager agent..."
  }
}
```

---

## Implementation Components

### 1. Event Store (TinyBase)

**Purpose:** Append-only event log with real-time materialized views.

**1.1 Store Initialization**

```typescript
// store/init.ts
interface EventStore {
  // Core operations
  emit(event: Omit<Event, 'id' | 'timestamp'>): Event
  query(filter: EventFilter): Event[]
  subscribe(filter: EventFilter, callback: (events: Event[]) => void): Unsubscribe
  
  // Views
  agents: AgentView
  tasks: TaskView
  messages: MessageView
  subscriptions: SubscriptionView
}

function createEventStore(config: StoreConfig): EventStore
```

**1.2 Event Log Table**

```typescript
// Tables
events: {
  id: string
  timestamp: number
  type: EventType
  source_agent_id: string | null
  source_task_id: string | null
  target_agent_id: string | null
  target_task_id: string | null
  target_topic: string | null
  payload: string  // JSON
  metadata: string // JSON
}
```

**1.3 Materialized Views**

```typescript
// Derived from events, maintained by TinyBase
agents: {
  [agent_id]: {
    id, session_id, parent, state, task, task_id,
    created_at, started_at, stopped_at, stop_reason
  }
}

tasks: {
  [task_id]: {
    id, description, status, assigned_agent,
    parent_task, created_at, created_by
  }
}

messages: {
  [agent_id]: {
    pending: [{ message_id, from, content, timestamp, ... }]
  }
}

subscriptions: {
  [agent_id]: [{ type, target }]
}
```

**1.4 Real-time Sync**

- TinyBase provides reactive updates
- CLI subscribes to changes via WebSocket
- Views update automatically on new events

**Deliverables:**
- [ ] TinyBase store setup with persistence
- [ ] Event emission with ID/timestamp generation
- [ ] Event query with filtering
- [ ] Agent view projection
- [ ] Task view projection
- [ ] Message queue projection
- [ ] Subscription change handlers

---

### 2. Agent Manager

**Purpose:** Manage agent lifecycle and state.

**2.1 Interface**

```typescript
// services/agent-manager.ts
interface AgentManager {
  // Lifecycle
  spawn(params: SpawnParams): Promise<Agent>
  terminate(agent_id: string, reason: StopReason): Promise<void>
  
  // Queries
  get(agent_id: string): Agent | null
  list(filter?: AgentFilter): Agent[]
  getChildren(agent_id: string): Agent[]
  getHierarchy(root?: string): HierarchyNode
  
  // Head manager
  getOrCreateHeadManager(): Promise<Agent>
}

interface SpawnParams {
  task: string
  parent: string | null
  task_id?: string
  subscriptions?: Subscription[]
  subscribe_parent?: boolean
  config?: AgentConfig
}
```

**2.2 Head Manager Bootstrap**

```typescript
async function getOrCreateHeadManager(): Promise<Agent> {
  // Check for existing head manager
  const existing = agents.list({ parent: null, state: 'running' })
  if (existing.length > 0) {
    return existing[0]
  }
  
  // Spawn new head manager
  return spawn({
    task: config.system.head_manager_task,
    parent: null,
    subscribe_parent: false
  })
}
```

**2.3 Spawn Flow**

```typescript
async function spawn(params: SpawnParams): Promise<Agent> {
  // 1. Generate IDs
  const agent_id = generateId('agent')
  const task_id = params.task_id ?? generateId('task')
  
  // 2. Create task (if not provided)
  if (!params.task_id) {
    taskManager.create({
      id: task_id,
      description: params.task,
      created_by: params.parent ?? 'system'
    })
  }
  
  // 3. Spawn via ACP
  const session_id = await acp.spawn({
    systemPrompt: generateSystemPrompt({ agent_id, task_id, ...params }),
    // ... other ACP config
  })
  
  // 4. Emit spawn event
  eventStore.emit({
    type: 'spawn',
    source: { agent_id: params.parent },
    payload: {
      agent_id,
      session_id,
      task: params.task,
      task_id,
      parent: params.parent,
      config: params.config
    }
  })
  
  // 5. Setup subscriptions
  setupSubscriptions(agent_id, params)
  
  // 6. Assign task
  taskManager.assign(task_id, agent_id)
  
  return agents.get(agent_id)
}
```

**2.4 Termination Flow**

```typescript
async function terminate(agent_id: string, reason: StopReason): Promise<void> {
  const agent = agents.get(agent_id)
  
  // 1. Terminate via ACP
  await acp.terminate(agent.session_id)
  
  // 2. Emit terminate event
  eventStore.emit({
    type: 'terminate',
    source: { agent_id },
    payload: {
      session_id: agent.session_id,
      reason
    }
  })
  
  // 3. Update task status
  if (agent.task_id) {
    const status = reason === 'completed' ? 'completed' : 'failed'
    taskManager.updateStatus(agent.task_id, status)
  }
}
```

**Deliverables:**
- [ ] AgentManager service
- [ ] Spawn flow with ACP integration
- [ ] Terminate flow
- [ ] Head manager bootstrap
- [ ] Agent queries (get, list, children, hierarchy)
- [ ] Subscription setup on spawn

---

### 3. Task Manager

**Purpose:** Manage task lifecycle and assignment.

**3.1 Interface**

```typescript
// services/task-manager.ts
interface TaskManager {
  // CRUD
  create(params: CreateTaskParams): Task
  get(task_id: string): Task | null
  list(filter?: TaskFilter): Task[]
  update(task_id: string, updates: Partial<Task>): Task
  
  // Assignment
  assign(task_id: string, agent_id: string, role?: AssignmentRole): void
  unassign(task_id: string, agent_id: string): void
  
  // Status
  updateStatus(task_id: string, status: TaskStatus): void
  
  // Hierarchy
  createSubtask(parent_id: string, params: CreateTaskParams): Task
  getSubtasks(task_id: string): Task[]
}
```

**3.2 Task Events**

```typescript
// Task creation
{ type: 'task', payload: { task_id, action: 'created', details: {...} } }

// Task assignment
{ type: 'task', payload: { task_id, action: 'assigned', details: { agent_id, role } } }

// Task status change
{ type: 'task', payload: { task_id, action: 'status_change', details: { status } } }
```

**Deliverables:**
- [ ] TaskManager service
- [ ] Task CRUD operations
- [ ] Task assignment/unassignment
- [ ] Status transitions
- [ ] Subtask creation
- [ ] Task view projection

---

### 4. Messaging System

**Purpose:** Route messages between agents.

**4.1 Interface**

```typescript
// services/message-router.ts
interface MessageRouter {
  // Sending
  send(params: SendParams): Message
  
  // Receiving
  getMessages(agent_id: string, options?: GetMessagesOptions): Message[]
  getFullMessage(message_id: string): Message
  
  // Subscriptions
  subscribe(agent_id: string, subscription: Subscription): void
  unsubscribe(agent_id: string, subscription: Subscription): void
  getSubscriptions(agent_id: string): Subscription[]
}

interface SendParams {
  from: { agent_id: string, task_id?: string }
  to: Target
  content: string
  correlation_id?: string
  priority?: MessagePriority
}

interface Target {
  agent_id?: string
  task_id?: string
  topic?: string
}
```

**4.2 Message Routing Logic**

```typescript
function routeMessage(event: MessageEvent): void {
  const { target } = event
  const recipients: string[] = []
  
  // Direct to agent
  if (target.agent_id) {
    recipients.push(target.agent_id)
  }
  
  // To task's assigned agent
  if (target.task_id) {
    const task = tasks.get(target.task_id)
    if (task?.assigned_agent) {
      recipients.push(task.assigned_agent)
    }
  }
  
  // To topic subscribers
  if (target.topic) {
    const subscribers = subscriptions.getByTopic(target.topic)
    recipients.push(...subscribers)
  }
  
  // Add to each recipient's queue
  for (const agent_id of new Set(recipients)) {
    addToMessageQueue(agent_id, event)
  }
}
```

**4.3 Automatic Subscriptions**

```typescript
function setupSubscriptions(agent_id: string, params: SpawnParams): void {
  // Always subscribe to direct messages
  subscribe(agent_id, { type: 'agent', target: agent_id })
  
  // Subscribe to assigned task
  if (params.task_id) {
    subscribe(agent_id, { type: 'task', target: params.task_id })
  }
  
  // Subscribe to lineage (upward visibility)
  subscribe(agent_id, { type: 'lineage', target: agent_id })
  
  // Parent subscribes to subtree (downward visibility)
  if (params.parent && params.subscribe_parent !== false) {
    subscribe(params.parent, { type: 'subtree', target: agent_id })
  }
  
  // Explicit subscriptions
  for (const sub of params.subscriptions ?? []) {
    subscribe(agent_id, sub)
  }
}
```

**4.4 Status Event Routing**

Status events from children are routed to parent via subtree subscription:

```typescript
function handleStatusEvent(event: StatusEvent): void {
  const { source } = event
  
  // Route to agents subscribed to this agent's subtree
  const subscribers = subscriptions.getBySubtree(source.agent_id)
  for (const subscriber of subscribers) {
    addToMessageQueue(subscriber, event)
  }
}
```

**Deliverables:**
- [ ] MessageRouter service
- [ ] Send message with routing
- [ ] Message queue per agent
- [ ] Subscription management
- [ ] Automatic subscription setup
- [ ] Status event routing to parent
- [ ] Truncation for large messages

---

### 5. System Prompt Generator

**Purpose:** Generate appropriate system prompts for agents.

**5.1 Interface**

```typescript
// services/prompt-generator.ts
interface PromptGenerator {
  generate(context: PromptContext): string
}

interface PromptContext {
  agent_id: string
  session_id: string
  task: string
  task_id: string
  parent: string | null
  lineage: string[]
  subscriptions: Subscription[]
  config: AgentConfig
  available_tools: ToolDescription[]
}
```

**5.2 Template**

```typescript
function generate(ctx: PromptContext): string {
  return `
You are Agent ${ctx.agent_id} (session: ${ctx.session_id}).

## Task
${ctx.task}

## Hierarchy
- Agent ID: ${ctx.agent_id}
- Parent: ${ctx.parent ?? 'none (you are the head manager)'}
- Lineage: ${ctx.lineage.join(' → ') || 'root'}

## Available Tools
${ctx.available_tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

## Subscriptions
${ctx.subscriptions.map(s => `- ${s.type}:${s.target}`).join('\n')}

## Guidance

### Status Reporting
- Emit 'started' status when you begin work
- Emit 'checkpoint' status at significant milestones
- Emit 'completed' or 'failed' status when done, with summary

### Communication
- Check messages periodically for updates from parent or peers
- Send messages to coordinate with other agents
- Use the blackboard for cross-cutting discoveries

### Task Management
- Spawn sub-agents for substantial independent subtasks
- Monitor child agent status via messages
- Aggregate results for your parent/user

${ctx.parent === null ? `
### Head Manager Responsibilities
You are the head manager. You interact directly with the user.
- Decompose complex requests into manageable tasks
- Spawn specialized agents for different aspects
- Synthesize results and report back to the user
- You persist across interactions; maintain continuity
` : ''}
`.trim()
}
```

**Deliverables:**
- [ ] PromptGenerator service
- [ ] Base template
- [ ] Head manager variant
- [ ] Tool list formatting
- [ ] Subscription formatting

---

### 6. MCP Tools

**Purpose:** Expose multi-agent capabilities to agents.

**6.1 Server Setup**

```typescript
// mcp/server.ts
interface MCPServer {
  start(): Promise<void>
  stop(): Promise<void>
  registerTool(tool: Tool): void
}

interface Tool {
  name: string
  description: string
  parameters: JSONSchema
  handler: (params: any, context: ToolContext) => Promise<any>
}

interface ToolContext {
  agent_id: string
  session_id: string
}
```

**6.2 MVP Tool Implementations**

```typescript
// mcp/tools/spawn-agent.ts
const spawnAgentTool: Tool = {
  name: 'spawn_agent',
  description: 'Spawn a new agent to handle a subtask',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'What the agent should do' },
      subscribe_parent: { type: 'boolean', default: true },
      config: { type: 'object' }
    },
    required: ['task']
  },
  handler: async (params, ctx) => {
    const agent = await agentManager.spawn({
      task: params.task,
      parent: ctx.agent_id,
      subscribe_parent: params.subscribe_parent,
      config: params.config
    })
    return { agent_id: agent.id, task_id: agent.task_id }
  }
}

// mcp/tools/emit-status.ts
const emitStatusTool: Tool = {
  name: 'emit_status',
  description: 'Report a status milestone',
  parameters: {
    type: 'object',
    properties: {
      status_type: { 
        type: 'string', 
        enum: ['started', 'checkpoint', 'blocked', 'discovery', 'completed', 'failed']
      },
      summary: { type: 'string' },
      details: { type: 'object' }
    },
    required: ['status_type', 'summary']
  },
  handler: async (params, ctx) => {
    const event = eventStore.emit({
      type: 'status',
      source: { agent_id: ctx.agent_id },
      payload: params
    })
    return { event_id: event.id }
  }
}

// mcp/tools/send-message.ts
const sendMessageTool: Tool = {
  name: 'send_message',
  description: 'Send a message to another agent, task, or topic',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'object',
        properties: {
          agent_id: { type: 'string' },
          task_id: { type: 'string' },
          topic: { type: 'string' }
        }
      },
      content: { type: 'string' },
      correlation_id: { type: 'string' }
    },
    required: ['to', 'content']
  },
  handler: async (params, ctx) => {
    const message = messageRouter.send({
      from: { agent_id: ctx.agent_id },
      to: params.to,
      content: params.content,
      correlation_id: params.correlation_id
    })
    return { message_id: message.id }
  }
}

// mcp/tools/check-messages.ts
const checkMessagesTool: Tool = {
  name: 'check_messages',
  description: 'Check for pending messages',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', default: 10 }
    }
  },
  handler: async (params, ctx) => {
    const messages = messageRouter.getMessages(ctx.agent_id, {
      limit: params.limit
    })
    return { messages }
  }
}

// mcp/tools/query-index.ts
const queryIndexTool: Tool = {
  name: 'query_index',
  description: 'Search for agents or tasks',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['agents', 'tasks', 'all'] },
      filter: { type: 'object' },
      search: { type: 'string' },
      limit: { type: 'number', default: 10 }
    }
  },
  handler: async (params, ctx) => {
    if (params.type === 'agents' || params.type === 'all') {
      const agents = agentManager.list(params.filter)
      // Apply search/limit
    }
    if (params.type === 'tasks' || params.type === 'all') {
      const tasks = taskManager.list(params.filter)
      // Apply search/limit
    }
    return { entries }
  }
}

// mcp/tools/get-hierarchy.ts
const getHierarchyTool: Tool = {
  name: 'get_hierarchy',
  description: 'View the agent hierarchy tree',
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      depth: { type: 'number', default: 3 }
    }
  },
  handler: async (params, ctx) => {
    const tree = agentManager.getHierarchy(params.root)
    return { tree }
  }
}
```

**6.3 MVP Tool List**

| Tool | Status | Notes |
|------|--------|-------|
| `spawn_agent` | MVP | Core functionality |
| `emit_status` | MVP | Child → parent feedback |
| `send_message` | MVP | Agent communication |
| `check_messages` | MVP | Receive messages |
| `query_index` | MVP | Agent/task lookup |
| `get_hierarchy` | MVP | Tree visualization |
| `get_agent_summary` | MVP | Quick agent view |
| `stop_agent` | MVP | Terminate children |
| `create_task` | MVP | Explicit task creation |
| `get_task` | MVP | Task lookup |

**Deliverables:**
- [ ] MCP server setup
- [ ] Tool registration system
- [ ] spawn_agent tool
- [ ] emit_status tool
- [ ] send_message tool
- [ ] check_messages tool
- [ ] query_index tool
- [ ] get_hierarchy tool
- [ ] get_agent_summary tool
- [ ] stop_agent tool (with ownership check)
- [ ] create_task tool
- [ ] get_task tool

---

### 7. API Layer

**Purpose:** HTTP/WebSocket API for CLI and future clients.

**7.1 REST Endpoints**

```typescript
// api/routes.ts

// System
POST /api/init                    // Initialize system
GET  /api/status                  // System status

// Conversation (user interaction)
POST /api/conversation/message    // Send message to head manager
GET  /api/conversation/history    // Get conversation history

// Agents (read-only for CLI)
GET  /api/agents                  // List agents
GET  /api/agents/:id              // Get agent
GET  /api/agents/:id/hierarchy    // Get subtree

// Tasks (read-only for CLI)
GET  /api/tasks                   // List tasks
GET  /api/tasks/:id               // Get task

// Events (debugging)
GET  /api/events                  // Query events
```

**7.2 WebSocket (real-time updates)**

```typescript
// api/websocket.ts

// Client subscribes to updates
ws.on('subscribe', (channel: string) => {
  // Channels: 'agents', 'tasks', 'messages', 'conversation'
})

// Server pushes updates
ws.emit('agent:update', agent)
ws.emit('task:update', task)
ws.emit('conversation:message', message)
```

**7.3 User Conversation Flow**

```typescript
// api/routes/conversation.ts

async function sendMessage(req: Request): Promise<Response> {
  const { content } = req.body
  
  // Get or create head manager
  const headManager = await agentManager.getOrCreateHeadManager()
  
  // Send message to head manager via ACP
  await acp.send(headManager.session_id, {
    role: 'user',
    content
  })
  
  // Response streams back via WebSocket
  return { status: 'sent', agent_id: headManager.id }
}
```

**Deliverables:**
- [ ] Express/Fastify server setup
- [ ] REST routes
- [ ] WebSocket server
- [ ] TinyBase → WebSocket bridge for real-time updates
- [ ] Conversation endpoint (user → head manager)

---

### 8. CLI

**Purpose:** Lightweight command-line interface for user interaction.

**8.1 Commands**

```bash
# Start the system
multiagent start

# Interactive conversation mode
multiagent chat

# Status commands
multiagent status                 # System overview
multiagent agents                 # List agents
multiagent agents <id>            # Agent details
multiagent tasks                  # List tasks
multiagent tasks <id>             # Task details
multiagent hierarchy              # Show agent tree

# Management
multiagent clear                  # Clear history (new head manager)
multiagent stop                   # Stop system
```

**8.2 Chat Mode**

```typescript
// cli/chat.ts

async function chatMode() {
  const ws = connectWebSocket()
  const rl = createReadline()
  
  // Subscribe to conversation updates
  ws.send({ type: 'subscribe', channel: 'conversation' })
  
  // Display incoming messages
  ws.on('conversation:message', (msg) => {
    console.log(`\n[${msg.from}]: ${msg.content}`)
    prompt()
  })
  
  // Send user input
  rl.on('line', async (input) => {
    await api.post('/conversation/message', { content: input })
  })
  
  // Real-time status updates (optional display)
  ws.on('agent:update', (agent) => {
    if (verbose) {
      console.log(`[status] Agent ${agent.id}: ${agent.state}`)
    }
  })
}
```

**8.3 Status Display**

```
$ multiagent status

System Status: running
Head Manager: agent_abc123 (running)

Agents: 5 total
  - 1 running
  - 4 stopped

Tasks: 3 total
  - 1 in_progress
  - 2 completed

$ multiagent hierarchy

agent_abc123 (head_manager) [running]
├── agent_def456 (architect) [completed]
├── agent_ghi789 (implementer) [running]
│   ├── agent_jkl012 (auth_module) [completed]
│   └── agent_mno345 (api_routes) [running]
└── agent_pqr678 (reviewer) [stopped]
```

**Deliverables:**
- [ ] CLI framework (commander/yargs)
- [ ] start command
- [ ] chat command with real-time updates
- [ ] status command
- [ ] agents/tasks list commands
- [ ] hierarchy command
- [ ] clear command
- [ ] stop command

---

## Deferred to Phase 2

The following are explicitly out of scope for MVP:

- Fork mechanics (fork_agent tool, fork context)
- Mount/remount abstraction
- Blackboard system
- Resource management (limits, throttling)
- Advanced context merging (summarization)
- Handoff conversation tool
- Inject message tool
- Index garbage collection / archival
- Semantic search

---

## Implementation Sequence

### Week 1: Foundation

**Days 1-2: Event Store**
- [ ] TinyBase setup with persistence
- [ ] Event log table
- [ ] Event emission API
- [ ] Basic queries

**Days 3-4: Materialized Views**
- [ ] Agent view projection
- [ ] Task view projection
- [ ] Message queue projection
- [ ] Subscription projection

**Day 5: Integration Test**
- [ ] Emit events, verify views update
- [ ] Real-time subscription test

### Week 2: Core Services

**Days 1-2: Agent Manager**
- [ ] Spawn flow (mock ACP)
- [ ] Terminate flow
- [ ] Agent queries
- [ ] Head manager bootstrap

**Days 3-4: Task Manager**
- [ ] Task CRUD
- [ ] Assignment management
- [ ] Status transitions

**Day 5: Messaging**
- [ ] Message router
- [ ] Subscription management
- [ ] Status event routing

### Week 3: Agent Interface

**Days 1-2: ACP Integration**
- [ ] Protocol wrapper
- [ ] Claude Code adapter
- [ ] Session management

**Days 3-4: System Prompts**
- [ ] Template implementation
- [ ] Context assembly
- [ ] Tool documentation in prompt

**Day 5: MCP Server**
- [ ] Server setup
- [ ] Tool registration

### Week 4: MCP Tools & API

**Days 1-2: Core Tools**
- [ ] spawn_agent
- [ ] emit_status
- [ ] send_message
- [ ] check_messages

**Days 3-4: Additional Tools**
- [ ] query_index
- [ ] get_hierarchy
- [ ] stop_agent
- [ ] Task tools

**Day 5: API Layer**
- [ ] REST endpoints
- [ ] WebSocket server

### Week 5: CLI & Integration

**Days 1-2: CLI**
- [ ] Command framework
- [ ] Chat mode
- [ ] Status commands

**Days 3-5: End-to-End Testing**
- [ ] Full flow testing
- [ ] Bug fixes
- [ ] Documentation

---

## Validation Checklist

### Core Functionality
- [ ] System starts and persists state
- [ ] Head manager created on first interaction
- [ ] User can send messages via CLI
- [ ] Head manager responds appropriately

### Agent Spawning
- [ ] Head manager can spawn child agents
- [ ] Child agents receive correct system prompts
- [ ] Child agents can use MCP tools
- [ ] Spawn events recorded correctly

### Communication
- [ ] Child agents can emit status
- [ ] Parent receives child status updates
- [ ] Agents can send direct messages
- [ ] Messages appear in recipient's queue

### Task Management
- [ ] Tasks created on agent spawn
- [ ] Task status updates with agent status
- [ ] Task queries work correctly

### Hierarchy
- [ ] Agent hierarchy tracked correctly
- [ ] Children list maintained
- [ ] Hierarchy visualization works

### Persistence
- [ ] State survives restart
- [ ] Event log intact after restart
- [ ] Views rebuild correctly

---

## Open Items for Separate Documents

1. **ACP Wrapper Design** — Detailed design for Agent Client Protocol integration
2. **Error Handling Strategy** — How errors propagate and are handled at each layer
3. **Testing Strategy** — Unit tests, integration tests, end-to-end tests
4. **Deployment Guide** — How to install and run the system

---

## Summary

This MVP implementation plan covers:

1. **Event Store** — TinyBase with real-time materialized views
2. **Agent Manager** — Spawn, terminate, query, head manager bootstrap
3. **Task Manager** — First-class tasks with CRUD and assignment
4. **Messaging** — Send/receive with subscription-based routing
5. **System Prompts** — Template-based generation
6. **MCP Tools** — Core toolset for agent capabilities
7. **API** — REST + WebSocket for CLI integration
8. **CLI** — Lightweight interface for user interaction

**Target:** Working system where user can interact with head manager that spawns child agents for complex task decomposition.

# Agent Interface Design

**Status:** Draft  
**Date:** 2025-01-09  
**Related:** Multi-Agent Interaction System Design, Agent Execution System Design, Data Structures

---

## Overview

This document describes the interface presented to agents in the multi-agent system. It covers system prompts, available tools, event handling, context injection, and output conventions.

**Key principle:** The interface is flexible and guidance-driven rather than rigidly enforced. Agent types are implicit based on behavior, not explicitly declared.

---

## System Prompt Structure

Agents receive a templated system prompt with contextual flexibility based on their situation.

### Template Structure

```
SystemPrompt {
  // Core identity (always present)
  identity: {
    agent_id: string
    session_id: string
    task: string
    parent: agent_id | null
    lineage: [agent_id]
  }
  
  // Contextual additions (when applicable)
  fork_context?: {
    source_agent: agent_id
    source_session: session_id
    reason: string
    orientation: string
  }
  
  handoff_context?: {
    from_agent: agent_id
    from_session: session_id
    summary: string
  }
  
  // Environment
  available_tools: [ToolDescription]
  subscriptions: [Subscription]
  resource_limits?: {
    timeout?: duration
    max_children?: number
    ...
  }
  
  // Guidance
  guidance: {
    reporting: string
    coordination: string
    task_specific?: string
  }
}
```

### Example System Prompt

```
You are Agent worker_42 (session: sess_abc123).

**Task:** Implement the user authentication endpoint

**Hierarchy:**
- Parent: manager_12
- Lineage: [head_manager, manager_12]

**Environment:**
- Available tools: send_message, check_messages, query_index, spawn_agent, 
  post_blackboard, read_blackboard, emit_status, handoff_conversation, 
  get_resource_status, stop_agent (own children only)
- Subscriptions: agent:worker_42, task:task_789, lineage:worker_42
- Timeout: 30 minutes

**Guidance:**
- Report status at key milestones (started, checkpoint, completed/failed)
- Check messages periodically for updates from manager or peers
- Post significant discoveries to the blackboard
- Spawn sub-agents for substantial independent subtasks

Your task is to implement the user authentication endpoint. Focus on...
```

### Fork Context Example

```
You are Agent fork_55 (session: sess_def456).

**Fork Context:**
You are a fork of Agent worker_42 (session: sess_abc123).
Reason: User wants to explore an alternative authentication approach.

You have full context from the original agent up to the fork point.
You can message the original agent via send_message if coordination is needed.

**Task:** Explore OAuth-based authentication as an alternative...
```

### Handoff Context Example

```
You are Agent worker_43 (session: sess_ghi789).

**Handoff Context:**
Previous conversation with Agent worker_42: User asked to implement 
authentication. Key decisions: JWT-based tokens, 24-hour expiry. 
Open question: refresh token strategy. User now wants to continue 
with the refresh token implementation.

**Task:** Implement refresh token handling...
```

---

## Available Tools (MCP)

### Core Tools (All Agents)

#### Messaging

| Tool | Parameters | Returns | Purpose |
|------|------------|---------|---------|
| `send_message` | `{ to: Target, content: string, correlation_id?: string }` | `{ message_id }` | Send message to agent/task/topic |
| `check_messages` | `{ limit?: number }` | `{ messages: [Message] }` | Poll message queue |
| `get_full_message` | `{ message_id }` | `{ content: string }` | Retrieve truncated message content |

```
Target {
  agent_id?: agent_id        // direct to agent
  task_id?: task_id          // to task's assigned agent
  topic?: string             // to topic subscribers
}

Message {
  id: message_id
  from: { agent_id, task_id? }
  timestamp: timestamp
  content: string            // may be truncated
  truncated: boolean
  correlation_id?: string
}
```

#### Discovery & Routing

| Tool | Parameters | Returns | Purpose |
|------|------------|---------|---------|
| `query_index` | `{ type, filter?, search?, sort?, limit?, archived? }` | `{ entries, total, has_more }` | Search agents/tasks |
| `get_hierarchy` | `{ root?: agent_id, depth?: number }` | `{ tree: HierarchyNode }` | View agent tree |
| `get_agent_summary` | `{ agent_id }` | `{ AgentSummary }` | Quick view of specific agent |

```
HierarchyNode {
  agent_id: agent_id
  task: string
  state: AgentState
  children: [HierarchyNode]
}

AgentSummary {
  agent_id: agent_id
  session_id: session_id
  task: string
  state: AgentState
  parent: agent_id | null
  children_count: number
  last_activity: timestamp
  recent_status?: StatusEvent
}
```

#### Spawning & Forking

| Tool | Parameters | Returns | Purpose |
|------|------------|---------|---------|
| `spawn_agent` | `{ task, initial_context?, subscriptions?, subscribe_parent?, config?, fork_from? }` | `{ agent_id }` | Create new agent |
| `fork_agent` | `{ source, reason, task?, initial_message?, subscriptions?, config? }` | `{ agent_id }` | Fork existing agent |

#### Blackboard

| Tool | Parameters | Returns | Purpose |
|------|------------|---------|---------|
| `post_blackboard` | `{ section, content, key?, thread?, metadata? }` | `{ entry_id }` | Write to blackboard |
| `read_blackboard` | `{ section, filter?, limit? }` | `{ view: BlackboardView }` | Read current view |
| `get_blackboard_updates` | `{ section, since: cursor }` | `{ entries, new_cursor }` | Get changes since cursor |

#### Status & Resources

| Tool | Parameters | Returns | Purpose |
|------|------------|---------|---------|
| `emit_status` | `{ status_type, summary, details? }` | `{ event_id }` | Report milestone |
| `get_resource_status` | `{}` | `{ ResourceStatus }` | Query resource utilization |

```
emit_status parameters:
  status_type: started | checkpoint | blocked | discovery | completed | failed
  summary: string
  details?: {
    // varies by status_type
    progress?: string
    remaining?: string
    artifacts?: [ArtifactRef]
    error?: string
    ...
  }
```

#### User Interaction

| Tool | Parameters | Returns | Purpose |
|------|------------|---------|---------|
| `handoff_conversation` | `{ to, context_hints? }` | `{ success: boolean }` | Transfer context to another agent |

```
handoff_conversation parameters:
  to: agent_id | session_id
  context_hints?: {
    focus?: string
    key_decisions?: [string]
    open_questions?: [string]
  }
```

---

### Restricted Tools (Role-Based)

These tools are available based on implicit role (determined by agent's relationships).

#### Control Tools (Own Subtree Only)

| Tool | Parameters | Returns | Purpose | Restriction |
|------|------------|---------|---------|-------------|
| `stop_agent` | `{ agent_id, reason? }` | `{ success: boolean }` | Terminate agent | Own children only |
| `inject_message` | `{ agent_id, content, reason? }` | `{ success: boolean }` | Force message into context | Own subtree only |

An agent can use these tools on agents it spawned (directly or transitively).

#### User Routing (When User Mounted)

| Tool | Parameters | Returns | Purpose | Restriction |
|------|------------|---------|---------|-------------|
| `remount_user` | `{ to: agent_id \| session_id }` | `{ success: boolean }` | Switch user's mount | Only when user is mounted to this agent |

---

## Hooks & Events

From the agent's perspective, hooks are just events that appear in their context or message queue.

### Event Delivery

| Event Type | Delivery Method | Agent Action |
|------------|-----------------|--------------|
| Spawn | Initial system prompt | Begin work, emit `started` |
| Message received | Retrieved via `check_messages` | Triage, respond, ignore |
| User message | Appears in conversation | Respond naturally |
| Injected message | Forced into context | Must acknowledge |
| System notice | Appears in context | React as appropriate |
| Timeout warning | System notice | Wrap up, checkpoint |

### System Notices

System notices appear as system messages in the agent's context:

```
[System notice: Resource warning - approaching memory limit]
[System notice: Timeout warning - 5 minutes remaining]
[System notice: Rate limit - message sending throttled]
```

### Injected Messages

Injected messages are forced into the agent's context and cannot be ignored:

```
[SYSTEM INJECTION from manager:manager_12 at 2025-01-09T10:05:00Z]
Stop current work immediately. Pivot to authentication implementation.
Reason: Priority change from user.

[Agent must acknowledge and respond to this injection]
```

---

## Context Injection

### Message Queue

Messages are retrieved explicitly via `check_messages` and woven into the conversation flow naturally.

**Tool call:**
```
check_messages({ limit: 10 })
```

**Response in conversation:**
```
Messages (3 pending):

[10:01:23] from:agent_peer_5 (task:task_456)
  "Found a potential issue with the API schema - the user ID field 
   is defined as string but we're using integers elsewhere."
  
[10:02:45] from:agent_manager_12 (task:task_789)
  "Prioritize the authentication work. User needs this by end of day."
  correlation_id: msg_abc

[10:03:12] from:user (mounted)
  "Can you check on the API progress?"
```

**Agent response pattern:**
```
I see three pending messages. Let me address them:

1. Peer feedback about API schema - this is a valid concern, I'll 
   update the schema to use integers consistently.
   
2. Manager priority update - acknowledged, I'll focus on authentication.

3. User question - I'll provide a status update.

[Agent continues with appropriate actions...]
```

### Injected Messages

Injected messages bypass the queue and appear directly in context:

```
[Previous conversation...]

Agent: I'm now working on the database schema design. First, I'll...

[SYSTEM INJECTION from manager:manager_12 at 10:05:00]
Priority change: Stop schema work. Implement authentication endpoint 
immediately. User escalated this request.

Agent: Understood. I'm pausing the schema work and pivoting to 
authentication. Let me emit a checkpoint for my current progress 
before switching...
```

### Handoff Context

When an agent receives a handoff, the context appears as a system message:

```
[System: Handoff context from agent:worker_42 (session:sess_abc)]
Previous conversation summary: User requested authentication 
implementation. Key decisions made: JWT tokens, 24-hour expiry, 
bcrypt for password hashing. Open question: refresh token strategy.
User's last message was about implementing refresh tokens.

[Conversation continues with user...]
```

---

## Output Format Conventions

Output conventions are guidance, not enforced rules.

### Status Reporting

**Recommended patterns:**

```
// When starting substantial work
emit_status({
  status_type: "started",
  summary: "Beginning authentication endpoint implementation",
  details: { task_description: "...", estimated_effort: "~2 hours" }
})

// At natural checkpoints
emit_status({
  status_type: "checkpoint",
  summary: "Completed JWT token generation",
  details: { progress: "40%", remaining: "Refresh tokens, validation", 
             artifacts: [{ type: "file", ref: "src/auth/jwt.ts" }] }
})

// When finding something relevant to others
emit_status({
  status_type: "discovery",
  summary: "Existing user service has incompatible ID format",
  details: { what: "User IDs are strings, not integers",
             relevance: "Affects all services using user references",
             suggested_action: "Coordinate with team on migration" }
})

// When blocked
emit_status({
  status_type: "blocked",
  summary: "Cannot proceed without database credentials",
  details: { reason: "Missing DB_PASSWORD environment variable",
             needs: "Credential configuration",
             suggested_resolution: "Check with ops team" }
})

// When completing successfully
emit_status({
  status_type: "completed",
  summary: "Authentication endpoint implemented and tested",
  details: { result_summary: "JWT-based auth with refresh tokens",
             artifacts: [{ type: "file", ref: "src/auth/" }],
             usage: { tokens: 45000, duration: "1h 23m" } }
})

// When failing
emit_status({
  status_type: "failed",
  summary: "Could not complete authentication implementation",
  details: { error: "Incompatible with existing session management",
             attempted: "Tried adapter pattern, direct integration",
             partial_results: { completed: ["JWT generation"], 
                               incomplete: ["Session integration"] } }
})
```

### Message Conventions

**Recommended patterns:**

```
// Keep messages concise
send_message({
  to: { agent_id: "agent_xyz" },
  content: "Found dependency issue: auth module requires user-service v2, 
            but we're on v1. Suggest upgrading before integration."
})

// Use correlation_id when responding
send_message({
  to: { agent_id: "agent_xyz" },
  content: "Confirmed. I'll handle the user-service upgrade.",
  correlation_id: "msg_123"  // references original message
})

// Include context for cross-branch communication
send_message({
  to: { topic: "api-changes" },
  content: "Breaking change: /users endpoint now requires auth header. 
            Migration guide in docs/auth-migration.md. 
            Affects: user-service, admin-panel, mobile-api."
})
```

### Blackboard Conventions

**Recommended patterns:**

```
// Discoveries section - share learnings
post_blackboard({
  section: "discoveries",
  content: {
    type: "api_change",
    summary: "External API deprecated endpoint",
    details: "...",
    affected_components: ["service_a", "service_b"],
    suggested_action: "Migrate to v2 endpoint"
  }
})

// Shared state section - configuration/status
post_blackboard({
  section: "shared_state",
  key: "db_migration_status",
  content: {
    status: "in_progress",
    current_version: "v23",
    target_version: "v25",
    estimated_completion: "2025-01-09T15:00:00Z"
  }
})

// Discussions section - threaded conversation
post_blackboard({
  section: "discussions",
  thread: "auth_strategy",
  content: {
    from: "worker_42",
    message: "Should we use JWT or session-based auth?",
    options: ["JWT - stateless", "Sessions - simpler revocation"]
  }
})
```

---

## Agent Type Variations

Agent types are implicit, determined by behavior rather than explicit declaration.

### Implicit Capabilities

| Behavior | Resulting Capabilities |
|----------|------------------------|
| Spawned children | Can use `stop_agent`, `inject_message` on own subtree |
| User mounted | Can use `remount_user` |
| Is a fork | Receives fork context, knows source agent |
| Long-running | May receive timeout warnings |

### Behavioral Patterns

**Manager-like behavior:**
- Spawns multiple children for task decomposition
- Monitors subtree via status events
- Uses `stop_agent` / `inject_message` for coordination
- May remount user to child agents

**Worker-like behavior:**
- Focused on single task
- Reports status to parent
- Spawns sub-agents only for substantial subtasks
- May become manager-like if task requires decomposition

**Inspector-like behavior:**
- Short-lived
- Read-focused (query_index, read_blackboard)
- Typically spawned to answer specific questions
- Minimal state changes

**Head manager behavior:**
- Persistent
- Primary user interaction point
- Routes user to appropriate agents
- Broadest visibility of system state

### Capability Resolution

Tools check capabilities at runtime based on agent relationships:

```
// stop_agent checks
if (target.lineage.includes(caller.agent_id)) {
  // Allowed - target is in caller's subtree
} else {
  // Denied - "Cannot stop agent outside your subtree"
}

// remount_user checks
if (user.currently_mounted_to == caller.agent_id) {
  // Allowed - user is mounted to this agent
} else {
  // Denied - "User is not mounted to your session"
}
```

---

## Summary

The agent interface provides:

- **Flexible system prompts** — template-based with contextual additions
- **Comprehensive tools** — messaging, discovery, spawning, blackboard, status
- **Role-based restrictions** — implicit based on agent relationships
- **Event-driven hooks** — events appear in context or message queue
- **Natural context injection** — messages woven into conversation flow
- **Guidance-based conventions** — recommendations, not rigid enforcement
- **Implicit agent types** — behavior determines capabilities

**Design principles:**
- Flexibility over rigidity
- Guidance over enforcement
- Implicit roles over explicit declarations
- Natural conversation flow over structured protocols

# Sudocode Integration

macro-agent integrates with [sudocode](https://github.com/sudocode-ai/sudocode) to provide external issue tracking and dependency management for tasks. This enables agents to work on issues from a structured backlog with proper dependency ordering.

## Overview

When using the sudocode backend:
- Tasks are bound to sudocode issues via `external_id`
- Blocking relationships come from sudocode's issue links
- `listReady()` returns only tasks whose bound issues have no incomplete blockers
- Task status can optionally sync with issue status

## Quick Start

### 1. Set Environment Variables

```bash
# Enable sudocode backend
export MACRO_TASK_BACKEND=sudocode

# Set project path (defaults to cwd)
export SUDOCODE_PROJECT_PATH=/path/to/project
```

### 2. Start macro-agent

```bash
npx multiagent
```

The agent will automatically connect to sudocode and use issues as the task source.

## Configuration Reference

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MACRO_TASK_BACKEND` | Backend type: `memory` or `sudocode` | `memory` |
| `MACRO_TASK_TOOL_MODE` | Tool exposure mode: `abstract`, `native`, `both`, `auto` | `auto` |
| `SUDOCODE_PROJECT_PATH` | Path to sudocode project root | `process.cwd()` |
| `SUDOCODE_TOOL_MODE` | Sudocode tool mode: `native`, `mapped`, `both` | `mapped` |

### Programmatic Configuration

```typescript
import { createTaskBackend, loadTaskConfigFromEnv } from 'macro-agent';

// Load from environment
const config = loadTaskConfigFromEnv();

// Or configure manually
const config = {
  backend: {
    type: 'sudocode',
    projectPath: '/path/to/project',
    idStrategy: 'dual',        // Task ID strategy
    syncMode: 'realtime',      // Event sync mode
    executionTracking: { mode: 'bound-only' },
    autoLinkSpecs: true,       // Link tasks to specs
    toolMode: 'mapped',        // Tool exposure mode
  },
  toolMode: 'auto',
};

const { backend, toolProvider, toolMode } = await createTaskBackend(config, eventStore);
```

### Backend Configuration Options

```typescript
interface SudocodeBackendConfig {
  type: 'sudocode';

  /** Path to sudocode project root (contains .sudocode/) */
  projectPath: string;

  /** ID strategy (default: 'dual') */
  idStrategy?: 'dual';

  /** Sync mode for event subscriptions */
  syncMode?: 'realtime' | 'batch';

  /** Execution tracking configuration */
  executionTracking?: ExecutionTrackingConfig;

  /** Auto-link tasks to specs when created from spec context */
  autoLinkSpecs?: boolean;

  /** Tool mode for this backend */
  toolMode?: 'native' | 'mapped' | 'both';
}
```

### Execution Tracking Options

Control when execution records are created:

```typescript
type ExecutionTrackingConfig =
  | { mode: 'none' }        // No execution records
  | { mode: 'bound-only' }  // Only tasks with external binding (default)
  | { mode: 'all' }         // All agent runs
  | { mode: 'filter'; filter: ExecutionFilter };
```

## Usage Guide

### Creating Tasks Bound to Issues

```typescript
// Create task bound to an existing sudocode issue
const task = await backend.create({
  description: 'Implement feature X',
  external_id: 'i-abc123',  // sudocode issue ID
});

console.log(task.external_id); // 'i-abc123'
```

### Multiple Tasks Per Issue

Multiple tasks (parallel workers) can work on the same issue:

```typescript
// Parallel workers on same issue
const task1 = await backend.create({
  description: 'Worker 1 attempt',
  external_id: 'i-abc123',
});

const task2 = await backend.create({
  description: 'Worker 2 attempt',
  external_id: 'i-abc123',
});

// Assign to different agents
await backend.assign(task1.id, 'worker-1');
await backend.assign(task2.id, 'worker-2');
```

### Working with Dependencies

Sudocode's blocking relationships determine task readiness:

```typescript
// Get tasks that are ready (no blocking dependencies)
const ready = await backend.listReady();

// Check if a specific task is blocked
const task = await backend.get(taskId);
if (task.isBlocked) {
  // Task's bound issue has incomplete blockers
  const blockers = await backend.getBlockers(taskId);
  console.log('Blocked by:', blockers.map(b => b.external_id));
}
```

### Task Lifecycle

```typescript
// 1. Create task bound to issue
const task = await backend.create({
  description: 'Implement feature',
  external_id: 'i-abc123',
});

// 2. Assign to agent
await backend.assign(task.id, 'agent-1');

// 3. Start execution
await backend.start(task.id);
// Issue status syncs to 'in_progress' if syncStatus enabled

// 4. Complete task
await backend.complete(task.id, {
  summary: 'Feature implemented',
  result: { files_changed: 3 },
});

// 5. (Optional) Issue is closed by coordinator, not automatically
```

### Event Subscriptions

```typescript
// Subscribe to all task changes
const unsubscribe = backend.onTaskChange((event) => {
  console.log(`Task ${event.taskId}: ${event.type}`);
});

// Subscribe to specific task
const unsubscribe = backend.onTaskChange(taskId, (event) => {
  console.log(`Task updated: ${event.type}`);
});
```

## Tool Modes

The sudocode backend supports different tool exposure modes:

| Mode | Description |
|------|-------------|
| `native` | Expose sudocode's native tools (`upsert_issue`, `link`, etc.) |
| `mapped` | Map to abstract task tools (`create_task`, `complete_task`, etc.) |
| `both` | Expose both tool sets |

### Auto Mode Behavior

When `toolMode: 'auto'`:
- Sudocode backend defaults to `mapped` (abstract tools)
- Memory backend defaults to `abstract`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              SudocodeTaskBackend                             │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              EventStore (Task Storage)               │    │
│  │  - Tasks with external_id bindings                   │    │
│  │  - Task-level state (assignment, status, outputs)    │    │
│  └─────────────────────────────────────────────────────┘    │
│                              │                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              SudocodeClient (Interface)              │    │
│  │  - Abstracts deployment mode                         │    │
│  │  - Issue/spec/relationship operations                │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────┼───────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌───────────────────────────┐      ┌───────────────────────────┐
│       ServerClient        │      │     StandaloneClient      │
│  (Managed Mode)           │      │  (Standalone Mode)        │
│  - REST API + WebSocket   │      │  - CLI + File Watcher     │
└───────────────────────────┘      └───────────────────────────┘
```

### Data Flow

1. **Task Creation**: Backend creates task in EventStore, binds to issue via `external_id`
2. **Blocker Lookup**: When `isBlocked` is queried, client fetches issue's blockers
3. **Status Sync**: Task status changes optionally sync to issue status
4. **Ready Queries**: `listReady()` filters tasks by sudocode's ready issues

## Migration Guide

### From InMemoryTaskBackend

#### Breaking Changes

1. **No `subtasks[]` array** - Use `getChildren(parentId)` instead
2. **No `agent_history[]` array** - Use `getAgentHistory(taskId)` instead
3. **`isBlocked` is computed** - Based on sudocode relationships, not task.blockers

#### Migration Steps

1. Update task creation to use `external_id` for issue binding:
   ```typescript
   // Before
   const task = await backend.create({ description: 'Work' });

   // After (with issue binding)
   const task = await backend.create({
     description: 'Work',
     external_id: 'i-abc123',
   });
   ```

2. Replace direct property access with method calls:
   ```typescript
   // Before
   const children = task.subtasks;
   const history = task.agent_history;

   // After
   const children = await backend.getChildren(task.id);
   const history = await backend.getAgentHistory(task.id);
   ```

3. Use `listReady()` for dependency-aware queries:
   ```typescript
   // Before (manual filtering)
   const tasks = await backend.list({ status: 'pending' });
   const ready = tasks.filter(t => !t.blockers?.length);

   // After
   const ready = await backend.listReady({ status: 'pending' });
   ```

### Coexistence

Both backends can coexist during migration:
- Tasks without `external_id` work like in-memory tasks
- Tasks with `external_id` are bound to sudocode issues
- Switch backends via environment variable without code changes

## Sync Policy

Configure how task and issue state synchronize:

```typescript
interface SyncPolicy {
  /** Action when bound issue is closed externally */
  onIssueClosed: 'complete_task' | 'fail_task' | 'notify_only';

  /** Action when issue description changes */
  onDescriptionChanged: 'propagate' | 'snapshot';

  /** Action when blocker status changes */
  onBlockerChanged: 'update_blocked' | 'notify_only';

  /** Update issue status when task starts */
  updateIssueOnStart: boolean;

  /** Update issue when task completes */
  updateIssueOnComplete: 'close' | 'comment' | 'never';
}
```

Default policy:
```typescript
const defaultSyncPolicy = {
  onIssueClosed: 'notify_only',      // Don't auto-complete/fail tasks
  onDescriptionChanged: 'snapshot',   // Keep original description
  onBlockerChanged: 'update_blocked', // Update isBlocked state
  updateIssueOnStart: true,           // Sync status to in_progress
  updateIssueOnComplete: 'never',     // Let coordinator close issues
};
```

## API Reference

### TaskBackend Methods

| Method | Description |
|--------|-------------|
| `create(options)` | Create task, optionally bound to issue |
| `get(id)` | Get task with computed `isBlocked` |
| `update(id, updates)` | Update task metadata |
| `assign(id, agentId)` | Assign task to agent |
| `start(id)` | Start task, optionally sync to issue |
| `complete(id, outputs?)` | Complete task |
| `fail(id, error)` | Mark task as failed |
| `list(filter?)` | List tasks with optional filter |
| `listReady(filter?)` | List unblocked tasks |
| `getBlockers(id)` | Get blocking tasks |
| `getBlocking(id)` | Get tasks blocked by this one |
| `getChildren(id)` | Get subtasks |
| `getAgentHistory(id)` | Get assignment history |
| `onTaskChange(callback)` | Subscribe to task events |

### ExtendedTask Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Internal task ID |
| `external_id` | `string?` | Bound sudocode issue ID |
| `status` | `TaskStatus` | Current status |
| `isBlocked` | `boolean` | Computed from issue blockers |
| `assigned_agent` | `string?` | Assigned agent ID |
| `parent_task` | `string?` | Parent task ID |
| `outputs` | `object?` | Task outputs on completion |

## Troubleshooting

### Task shows isBlocked=false when issue has blockers

Ensure the sudocode client has fetched the latest issue state. Call `backend.getBlockers(taskId)` to refresh blocker data.

### Status not syncing to issue

Check that `syncStatus: true` is set in backend config (default is true).

### Tasks not appearing in listReady()

Tasks must:
1. Have status `pending` or `assigned`
2. Be bound to an issue with no incomplete blockers
3. Not be excluded by filter criteria

# Troubleshooting Guide

Common issues and solutions when using macro-agent.

## Agent Issues

### Agent fails to spawn

**Symptoms:**
- `spawn()` throws error
- Agent stuck in "spawning" state
- Timeout during agent creation

**Possible causes and solutions:**

1. **Missing acp-factory registration**
   ```typescript
   // Ensure macro-agent is registered before spawning
   import { registerMacroAgent } from 'macro-agent';
   registerMacroAgent();
   ```

2. **Invalid working directory**
   ```bash
   # Ensure the cwd exists and is accessible
   ls -la /path/to/cwd
   ```

3. **Resource limits**
   - Check system resources (memory, file handles)
   - Reduce `maxWorktrees` in workspace config

### Agent not responding to prompts

**Symptoms:**
- `prompt()` hangs indefinitely
- No streaming updates received
- Agent appears stuck

**Possible causes and solutions:**

1. **Agent is processing previous prompt**
   ```typescript
   // Check if agent is currently prompting
   const busy = agentManager.isPrompting(agentId);
   ```

2. **Session disconnected**
   ```typescript
   // Get session and check state
   const session = agentManager.getSession(agentId);
   // session may be null if disconnected
   ```

3. **Deadlock in message routing**
   - Check for circular message dependencies
   - Ensure agents are calling `check_messages` periodically

### Context injection not working

**Symptoms:**
- `inject()` returns success but agent doesn't see context
- Fallback to message instead of injection
- `interruptWith()` not interrupting

**Possible causes and solutions:**

1. **Agent doesn't support injection**
   ```typescript
   // Check injection support
   const session = agentManager.getSession(agentId);
   const supported = session?.supportsInject();
   // Older Claude Code versions may not support inject
   ```

2. **Agent not prompting**
   - Injection only works when agent is actively prompting
   - If not prompting, context goes to message queue

3. **Content too large**
   - Large injection content may fail
   - Break into smaller messages if needed

## Task Issues

### Tasks stuck in "blocked" state

**Symptoms:**
- `isBlocked` always true
- `listReady()` returns empty array
- Tasks never become ready

**Possible causes and solutions:**

1. **Incomplete blockers**
   ```typescript
   // Check what's blocking the task
   const blockers = await backend.getBlockers(taskId);
   console.log('Blocked by:', blockers.map(b => ({
     id: b.id,
     status: b.status,
     external_id: b.external_id,
   })));
   ```

2. **Circular dependencies**
   - Check for A blocks B, B blocks A situations
   - Use `getBlocking()` to trace dependency chains

3. **Stale blocker state**
   - External issues may be closed but task not updated
   - Refresh task state: `await backend.get(taskId)`

### Task-issue binding issues (OpenTasks)

**Symptoms:**
- Tasks created without `external_id`
- Status not syncing between task and issue
- Duplicate tasks for same issue

**Possible causes and solutions:**

1. **Missing external_id**
   ```typescript
   // Always provide external_id when binding to issue
   const task = await backend.create({
     description: 'Work on feature',
     external_id: 'i-abc123',  // Required for binding
   });
   ```

2. **Backend configuration**
   ```typescript
   // Check backend config
   const config = {
     backend: {
       type: 'opentasks',
       socketPath: '/path/to/socket',
     },
   };
   ```

3. **OpenTasks connectivity**
   - Check OpenTasks server is running
   - Verify `OPENTASKS_SOCKET_PATH` is correct

## Workspace Issues

### Worktree creation fails

**Symptoms:**
- "Failed to create worktree" error
- Pool exhausted
- Git errors during workspace setup

**Possible causes and solutions:**

1. **Pool exhausted**
   ```typescript
   // Check current worktree count
   const worktrees = await workspaceManager.listWorktrees();
   console.log(`${worktrees.length} / ${config.maxWorktrees} worktrees`);
   ```

2. **Git repository issues**
   ```bash
   # Verify repo is valid
   git -C /path/to/repo status

   # Check for corrupted worktrees
   git worktree list
   git worktree prune
   ```

3. **Permission issues**
   ```bash
   # Check directory permissions
   ls -la /path/to/repo/.worktrees
   ```

### Merge conflicts in queue

**Symptoms:**
- Merge request stuck in queue
- Conflict detected during integration
- Workers blocked waiting for resolution

**Possible causes and solutions:**

1. **Identify conflicting files**
   ```typescript
   // Queue provides conflict details
   const queueItem = await mergeQueue.peek();
   if (queueItem.status === 'conflict') {
     console.log('Conflicts:', queueItem.conflicts);
   }
   ```

2. **Manual resolution needed**
   - Integrator spawns resolver worker for complex conflicts
   - Simple conflicts may auto-resolve

3. **Stale branches**
   ```bash
   # Rebase worker branch on integration
   git -C /path/to/worktree rebase integration
   ```

### Workspace cleanup failures

**Symptoms:**
- Orphaned worktrees after agent termination
- Disk space not freed
- "Worktree in use" errors

**Possible causes and solutions:**

1. **Force cleanup**
   ```bash
   # List and prune orphaned worktrees
   git worktree list
   git worktree prune
   ```

2. **Locked worktree**
   ```bash
   # Remove lock file if present
   rm /path/to/repo/.git/worktrees/worker-01/locked
   ```

3. **Process still using directory**
   ```bash
   # Find processes using the worktree
   lsof +D /path/to/worktree
   ```

## Message Routing Issues

### Messages not delivered

**Symptoms:**
- `send_message` succeeds but recipient never receives
- `check_messages` returns empty
- Messages pile up in queue

**Possible causes and solutions:**

1. **Invalid recipient**
   ```typescript
   // Verify agent exists
   const agent = agentManager.get(recipientId);
   if (!agent) {
     console.error('Recipient not found');
   }
   ```

2. **Agent not checking messages**
   - Agents must periodically call `check_messages`
   - Check agent's message polling interval

3. **Channel type mismatch**
   ```typescript
   // Ensure correct channel type
   await messageRouter.send({
     from: { agent_id: senderId },
     to: { agent_id: recipientId },  // Direct channel
     // OR
     to: { channel: 'broadcast' },   // Broadcast channel
     // OR
     to: { role: 'worker' },         // Role channel
     content: 'message',
   });
   ```

### Broadcast not reaching all agents

**Symptoms:**
- Some agents receive broadcast, others don't
- Inconsistent delivery

**Possible causes and solutions:**

1. **Agents spawned after broadcast**
   - Broadcasts only reach agents that exist at send time
   - New agents won't receive past broadcasts

2. **Agent state**
   - Stopped agents won't receive messages
   - Check agent state: `agent.state === 'running'`

## Event Store Issues

### Database locked

**Symptoms:**
- "Database is locked" error
- Concurrent write failures
- Operations timing out

**Possible causes and solutions:**

1. **Multiple processes**
   ```bash
   # Check for multiple macro-agent processes
   ps aux | grep multiagent
   ```

2. **Long-running transactions**
   - Event store uses WAL mode for better concurrency
   - Check for uncommitted transactions

3. **Increase busy timeout**
   ```typescript
   // SQLite backend accepts busy timeout config
   const eventStore = await createEventStore({
     dbPath: './data/events.db',
     busyTimeout: 5000,  // 5 seconds
   });
   ```

### Event replay issues

**Symptoms:**
- Inconsistent state after restart
- Missing materialized view data
- Events but no corresponding state

**Possible causes and solutions:**

1. **Corrupted event log**
   ```bash
   # Check SQLite integrity
   sqlite3 ./data/events.db "PRAGMA integrity_check;"
   ```

2. **Migration needed**
   - Check for pending migrations
   - Event store auto-migrates on startup

## API Server Issues

### WebSocket connection drops

**Symptoms:**
- Clients disconnected unexpectedly
- Reconnection loops
- "Connection refused" errors

**Possible causes and solutions:**

1. **Server restart**
   - Implement reconnection logic in clients
   - Use exponential backoff

2. **Proxy timeout**
   ```nginx
   # If behind nginx, increase timeouts
   proxy_read_timeout 3600;
   proxy_send_timeout 3600;
   ```

3. **Port already in use**
   ```bash
   # Check if port is in use
   lsof -i :3001
   ```

### REST API returning 500 errors

**Symptoms:**
- Internal server errors
- Inconsistent failures

**Possible causes and solutions:**

1. **Check server logs**
   ```bash
   # Run with debug output
   DEBUG=macro-agent:* npx multiagent
   ```

2. **Validate request body**
   ```bash
   # Test with curl
   curl -X POST http://localhost:3000/api/init \
     -H "Content-Type: application/json" \
     -d '{"cwd": "/path/to/project"}'
   ```

## Performance Issues

### High memory usage

**Symptoms:**
- Memory grows over time
- OOM errors
- Slow response times

**Possible causes and solutions:**

1. **Too many agents**
   - Limit concurrent agents
   - Implement agent pooling

2. **Event log growth**
   - Consider event log compaction
   - Archive old events

3. **Message queue buildup**
   - Ensure agents process messages
   - Check for message leaks

### Slow task queries

**Symptoms:**
- `list()` takes long time
- `listReady()` timing out
- Database queries slow

**Possible causes and solutions:**

1. **Missing indexes**
   - Event store creates indexes automatically
   - Check index health: `PRAGMA index_list(tasks);`

2. **Large result sets**
   ```typescript
   // Use pagination
   const tasks = await backend.list({
     limit: 100,
     offset: 0,
   });
   ```

3. **Complex blocker chains**
   - Deep dependency trees slow down `listReady()`
   - Consider caching blocker state

## Debugging Tips

### Enable debug logging

```bash
# All debug output
DEBUG=macro-agent:* npx multiagent

# Specific modules
DEBUG=macro-agent:agent-manager,macro-agent:message-router npx multiagent
```

### Inspect event store

```bash
# Connect to SQLite database
sqlite3 ./data/events.db

# View recent events
SELECT * FROM events ORDER BY timestamp DESC LIMIT 10;

# View agent states
SELECT * FROM agents;

# View task states
SELECT * FROM tasks WHERE status != 'completed';
```

### Monitor WebSocket traffic

```javascript
// In browser console
const ws = new WebSocket('ws://localhost:3001/acp');
ws.onmessage = (e) => console.log('Received:', JSON.parse(e.data));
```

### Test context injection

```bash
# Via REST API
curl -X POST http://localhost:3000/api/agents/{agentId}/inject \
  -H "Content-Type: application/json" \
  -d '{"content": "Test injection", "urgent": true}'
```

## Getting Help

1. **Check logs** - Most issues leave traces in debug logs
2. **Inspect event store** - Event log is source of truth
3. **Run tests** - `npm test` catches regressions
4. **File issue** - Report bugs at https://github.com/anthropics/macro-agent/issues

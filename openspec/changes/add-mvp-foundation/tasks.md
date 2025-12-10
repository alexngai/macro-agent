## Phase 1: Foundation (Sequential) ✅ COMPLETE

### 1. Event Store
- [x] 1.1 Set up TinyBase with SQLite persistence
- [x] 1.2 Create events table schema (id, timestamp, type, source, target, payload, metadata)
- [x] 1.3 Implement emit() function with auto-generated ID and timestamp
- [x] 1.4 Implement query() function with type/source/time filtering
- [x] 1.5 Create agents materialized view with projection logic
- [x] 1.6 Create tasks materialized view with projection logic
- [x] 1.7 Create messages materialized view (per-agent queues)
- [x] 1.8 Create subscriptions materialized view
- [x] 1.9 Implement subscribe() for reactive view updates
- [x] 1.10 Write tests for event emission and view projections (27 tests passing)

---

## Phase 2: Core Managers (Parallel - 3 Streams)

### Stream A: Agent Manager
- [ ] 2A.1 Define AgentManager interface (spawn, terminate, get, list, getChildren, getHierarchy)
- [ ] 2A.2 Implement spawn() with ID generation and event emission
- [ ] 2A.3 Integrate with ACP wrapper for session creation (stub initially)
- [ ] 2A.4 Implement default subscription setup on spawn
- [ ] 2A.5 Implement terminate() with event emission and task status update
- [ ] 2A.6 Implement get() and list() queries from agents view
- [ ] 2A.7 Implement getChildren() and getHierarchy()
- [ ] 2A.8 Implement getOrCreateHeadManager()
- [ ] 2A.9 Implement system prompt generator with templates
- [ ] 2A.10 Write tests for agent lifecycle

### Stream B: Task Manager
- [ ] 2B.1 Define TaskManager interface (create, get, list, update, assign, updateStatus)
- [ ] 2B.2 Implement create() with ID generation and event emission
- [ ] 2B.3 Implement get() and list() queries from tasks view
- [ ] 2B.4 Implement assign() and unassign() with event emission
- [ ] 2B.5 Implement updateStatus() with valid transitions
- [ ] 2B.6 Implement update() for metadata (outputs, artifacts)
- [ ] 2B.7 Implement createSubtask() and getSubtasks()
- [ ] 2B.8 Write tests for task lifecycle

### Stream C: Message Router
- [ ] 2C.1 Define MessageRouter interface (send, getMessages, subscribe, unsubscribe)
- [ ] 2C.2 Implement send() with target resolution (agent, task, topic)
- [ ] 2C.3 Implement message queue routing logic
- [ ] 2C.4 Implement getMessages() with limit and getFullMessage()
- [ ] 2C.5 Implement subscribe() and unsubscribe() for topics
- [ ] 2C.6 Implement getSubscriptions()
- [ ] 2C.7 Implement automatic subscription setup helper
- [ ] 2C.8 Implement status event routing to subtree subscribers
- [ ] 2C.9 Implement message truncation for large content
- [ ] 2C.10 Write tests for message routing

---

## Phase 3: MCP Tools (Parallel - by tool)

### 3. MCP Server & Tools
- [ ] 3.1 Set up MCP server with tool registration
- [ ] 3.2 Implement tool context injection (agent_id, session_id)
- [ ] 3.3 Implement spawn_agent tool
- [ ] 3.4 Implement emit_status tool
- [ ] 3.5 Implement send_message tool
- [ ] 3.6 Implement check_messages tool
- [ ] 3.7 Implement query_index tool
- [ ] 3.8 Implement get_hierarchy tool
- [ ] 3.9 Implement get_agent_summary tool
- [ ] 3.10 Implement stop_agent tool (with subtree ownership check)
- [ ] 3.11 Implement create_task tool
- [ ] 3.12 Implement get_task tool
- [ ] 3.13 Write tests for all MCP tools

---

## Phase 4: API & CLI (Sequential)

### 4. API Layer
- [ ] 4.1 Set up Express/Fastify server
- [ ] 4.2 Implement POST /api/init
- [ ] 4.3 Implement GET /api/status
- [ ] 4.4 Implement POST /api/conversation/message
- [ ] 4.5 Implement GET /api/conversation/history
- [ ] 4.6 Implement GET /api/agents and /api/agents/:id
- [ ] 4.7 Implement GET /api/agents/:id/hierarchy
- [ ] 4.8 Implement GET /api/tasks and /api/tasks/:id
- [ ] 4.9 Implement GET /api/events with filters
- [ ] 4.10 Set up WebSocket server
- [ ] 4.11 Implement WebSocket subscription channels (agents, tasks, conversation)
- [ ] 4.12 Implement TinyBase → WebSocket bridge for real-time updates
- [ ] 4.13 Write tests for API endpoints

### 5. CLI
- [ ] 5.1 Set up CLI framework (Commander/Yargs)
- [ ] 5.2 Implement `multiagent start` command
- [ ] 5.3 Implement `multiagent chat` command with real-time updates
- [ ] 5.4 Implement `multiagent status` command
- [ ] 5.5 Implement `multiagent agents` and `multiagent agents <id>` commands
- [ ] 5.6 Implement `multiagent tasks` and `multiagent tasks <id>` commands
- [ ] 5.7 Implement `multiagent hierarchy` command with tree visualization
- [ ] 5.8 Implement `multiagent clear` command
- [ ] 5.9 Implement `multiagent stop` command
- [ ] 5.10 Write tests for CLI commands

---

## Phase 5: Integration & Validation

### 6. End-to-End Integration
- [ ] 6.1 Integrate ACP wrapper with real Claude Code
- [ ] 6.2 End-to-end test: user → head manager → child agent → result
- [ ] 6.3 Test status flow from child to parent
- [ ] 6.4 Test persistence across restart
- [ ] 6.5 Fix integration bugs
- [ ] 6.6 Update documentation

---

## Dependency Graph

```
Phase 1: [1.1-1.10] Event Store
              │
              ├─────────────────┬─────────────────┐
              ▼                 ▼                 ▼
Phase 2: [2A.1-2A.10]     [2B.1-2B.8]      [2C.1-2C.10]
         Agent Manager    Task Manager     Message Router
              │                 │                 │
              └─────────────────┴─────────────────┘
                                │
                                ▼
Phase 3:                [3.1-3.13] MCP Tools
                                │
                                ▼
Phase 4:                [4.1-4.13] API Layer
                                │
                                ▼
                        [5.1-5.10] CLI
                                │
                                ▼
Phase 5:                [6.1-6.6] Integration
```

## Parallelization Notes

- **Phase 2 streams can run fully in parallel** once Phase 1 is complete
- **Phase 3 tools can be partially parallelized** (tools 3.3-3.12 are independent once 3.1-3.2 done)
- **Phase 4-5 are sequential** (CLI depends on API, API depends on MCP tools)
- **Testing within each phase can run in parallel** with implementation

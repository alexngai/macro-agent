# mcp-tools Specification

## Purpose
TBD - created by archiving change add-mvp-foundation. Update Purpose after archive.
## Requirements
### Requirement: MCP Server Setup

The system SHALL provide an MCP server that exposes multi-agent tools to agents.

#### Scenario: Start MCP server
- **GIVEN** the multi-agent system is initialized
- **WHEN** the MCP server is started
- **THEN** the server registers all available tools
- **AND** agents can discover tools via the MCP protocol

#### Scenario: Tool context injection
- **GIVEN** an agent with id 'agent_1' and session 'sess_123'
- **WHEN** the agent calls any MCP tool
- **THEN** the tool handler receives context { agent_id: 'agent_1', session_id: 'sess_123' }
- **AND** the tool can use this context for authorization and attribution

---

### Requirement: spawn_agent Tool

The system SHALL provide a tool for agents to spawn child agents.

#### Scenario: Spawn child agent
- **GIVEN** an agent 'manager_1' calls spawn_agent
- **WHEN** spawn_agent({ task: 'Implement feature X' }) is invoked
- **THEN** a new agent is spawned with parent 'manager_1'
- **AND** the tool returns { agent_id, task_id }

#### Scenario: Spawn with subscribe_parent false
- **GIVEN** an agent calls spawn_agent with fire-and-forget intent
- **WHEN** spawn_agent({ task: 'Background task', subscribe_parent: false }) is invoked
- **THEN** the parent is NOT subscribed to the child's subtree
- **AND** the child operates independently

#### Scenario: Spawn with custom config
- **GIVEN** an agent needs a specific model for a child
- **WHEN** spawn_agent({ task: 'Complex analysis', config: { model: 'claude-opus-4-20250514' } }) is invoked
- **THEN** the child agent uses the specified model

---

### Requirement: emit_status Tool

The system SHALL provide a tool for agents to report status milestones.

#### Scenario: Emit started status
- **GIVEN** agent 'worker_1' beginning work
- **WHEN** emit_status({ status_type: 'started', summary: 'Beginning implementation' }) is invoked
- **THEN** a status event is emitted with source agent_id 'worker_1'
- **AND** the tool returns { event_id }

#### Scenario: Emit checkpoint status
- **GIVEN** agent 'worker_1' reaching a milestone
- **WHEN** emit_status({ status_type: 'checkpoint', summary: '50% complete', details: { progress: '50%' } }) is invoked
- **THEN** the status event includes the details
- **AND** subscribers (e.g., parent) receive the update

#### Scenario: Emit completed status
- **GIVEN** agent 'worker_1' finishing work
- **WHEN** emit_status({ status_type: 'completed', summary: 'Task finished', details: { artifacts: [...] } }) is invoked
- **THEN** the completion is recorded
- **AND** the agent's task status is updated

---

### Requirement: send_message Tool

The system SHALL provide a tool for agents to send messages.

#### Scenario: Send direct message
- **GIVEN** agent 'agent_1' wants to message 'agent_2'
- **WHEN** send_message({ to: { agent_id: 'agent_2' }, content: 'Need your input' }) is invoked
- **THEN** the message is routed to agent_2
- **AND** the tool returns { message_id }

#### Scenario: Send message to topic
- **GIVEN** agent 'agent_1' wants to broadcast to a topic
- **WHEN** send_message({ to: { topic: 'discoveries' }, content: 'Found issue X' }) is invoked
- **THEN** all agents subscribed to 'discoveries' receive the message

#### Scenario: Send reply with correlation
- **GIVEN** agent received message 'msg_123'
- **WHEN** send_message({ to: { agent_id: 'sender' }, content: 'Response', correlation_id: 'msg_123' }) is invoked
- **THEN** the response is threaded with the original message

---

### Requirement: check_messages Tool

The system SHALL provide a tool for agents to check their message queue.

#### Scenario: Check messages with default limit
- **GIVEN** agent 'agent_1' has pending messages
- **WHEN** check_messages({}) is invoked by agent_1
- **THEN** up to 10 messages are returned (default limit)
- **AND** messages include id, from, content, timestamp, truncated flag

#### Scenario: Check messages with custom limit
- **GIVEN** agent 'agent_1' has many pending messages
- **WHEN** check_messages({ limit: 5 }) is invoked
- **THEN** only 5 messages are returned

#### Scenario: No pending messages
- **GIVEN** agent 'agent_1' has no pending messages
- **WHEN** check_messages({}) is invoked
- **THEN** an empty messages array is returned

---

### Requirement: query_index Tool

The system SHALL provide a tool for agents to search for agents and tasks.

#### Scenario: Query running agents
- **GIVEN** multiple agents in various states
- **WHEN** query_index({ type: 'agents', filter: { state: 'running' } }) is invoked
- **THEN** only running agents are returned
- **AND** the tool returns { entries, total, has_more }

#### Scenario: Query tasks by status
- **GIVEN** tasks in various statuses
- **WHEN** query_index({ type: 'tasks', filter: { status: 'in_progress' } }) is invoked
- **THEN** only in-progress tasks are returned

#### Scenario: Search with text query
- **GIVEN** agents and tasks with various descriptions
- **WHEN** query_index({ type: 'all', search: 'authentication' }) is invoked
- **THEN** entries matching 'authentication' are returned
- **AND** results are sorted by relevance/recency

---

### Requirement: get_hierarchy Tool

The system SHALL provide a tool for agents to view the agent tree.

#### Scenario: Get full hierarchy
- **GIVEN** a multi-level agent hierarchy
- **WHEN** get_hierarchy({}) is invoked
- **THEN** the complete tree from head manager is returned
- **AND** each node includes agent_id, task, state, children

#### Scenario: Get hierarchy from specific root
- **GIVEN** agent 'manager_1' with children
- **WHEN** get_hierarchy({ root: 'manager_1' }) is invoked
- **THEN** only the subtree under manager_1 is returned

#### Scenario: Get hierarchy with depth limit
- **GIVEN** a deep hierarchy
- **WHEN** get_hierarchy({ depth: 2 }) is invoked
- **THEN** only 2 levels of the hierarchy are returned

---

### Requirement: get_agent_summary Tool

The system SHALL provide a tool for quick agent lookup.

#### Scenario: Get agent summary
- **GIVEN** agent 'worker_1' exists with recent activity
- **WHEN** get_agent_summary({ agent_id: 'worker_1' }) is invoked
- **THEN** the summary includes id, session_id, task, state, parent, children_count, last_activity, recent_status

#### Scenario: Get non-existent agent
- **GIVEN** no agent with id 'nonexistent'
- **WHEN** get_agent_summary({ agent_id: 'nonexistent' }) is invoked
- **THEN** an error is returned indicating agent not found

---

### Requirement: stop_agent Tool

The system SHALL provide a tool for agents to terminate their children.

#### Scenario: Stop own child
- **GIVEN** agent 'manager_1' spawned 'worker_1'
- **WHEN** manager_1 invokes stop_agent({ agent_id: 'worker_1' })
- **THEN** worker_1 is terminated with reason 'stopped'
- **AND** the tool returns { success: true }

#### Scenario: Stop grandchild
- **GIVEN** hierarchy: manager_1 → worker_1 → helper_1
- **WHEN** manager_1 invokes stop_agent({ agent_id: 'helper_1' })
- **THEN** helper_1 is terminated (manager_1 owns the subtree)

#### Scenario: Cannot stop agent outside subtree
- **GIVEN** agent 'agent_A' not in 'agent_B's subtree
- **WHEN** agent_B invokes stop_agent({ agent_id: 'agent_A' })
- **THEN** the operation fails with error 'Cannot stop agent outside your subtree'

---

### Requirement: create_task Tool

The system SHALL provide a tool for agents to create explicit tasks.

#### Scenario: Create task
- **GIVEN** agent 'manager_1' wants to create a task
- **WHEN** create_task({ description: 'Review code changes' }) is invoked by manager_1
- **THEN** a new task is created with created_by: 'manager_1'
- **AND** the tool returns { task_id }

#### Scenario: Create subtask
- **GIVEN** parent task 'task_1' exists
- **WHEN** create_task({ description: 'Subtask', parent_task: 'task_1' }) is invoked
- **THEN** the task is created with parent_task reference

---

### Requirement: get_task Tool

The system SHALL provide a tool for agents to lookup task details.

#### Scenario: Get task details
- **GIVEN** task 'task_1' exists
- **WHEN** get_task({ task_id: 'task_1' }) is invoked
- **THEN** the full task record is returned including description, status, assigned_agent, inputs, outputs, artifacts

#### Scenario: Get non-existent task
- **GIVEN** no task with id 'nonexistent'
- **WHEN** get_task({ task_id: 'nonexistent' }) is invoked
- **THEN** an error is returned indicating task not found


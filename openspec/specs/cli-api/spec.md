# cli-api Specification

## Purpose
TBD - created by archiving change add-mvp-foundation. Update Purpose after archive.
## Requirements
### Requirement: API Server Initialization

The system SHALL provide an HTTP/WebSocket server for CLI and client communication.

#### Scenario: Start API server
- **GIVEN** the multi-agent system is configured
- **WHEN** the API server is started
- **THEN** REST endpoints are available at the configured port (default 3000)
- **AND** WebSocket connections are accepted for real-time updates

#### Scenario: Server configuration
- **GIVEN** config specifies port 4000 and host 'localhost'
- **WHEN** the API server is started
- **THEN** the server listens on localhost:4000

---

### Requirement: System Endpoints

The system SHALL provide endpoints for system management.

#### Scenario: Initialize system
- **GIVEN** a fresh system start
- **WHEN** POST /api/init is called
- **THEN** the event store is initialized
- **AND** configuration is loaded
- **AND** the system is ready to accept commands

#### Scenario: Get system status
- **GIVEN** a running system with agents
- **WHEN** GET /api/status is called
- **THEN** the response includes system state (running/stopped)
- **AND** head manager info (id, state)
- **AND** aggregate counts (agents running, tasks in progress)

---

### Requirement: Conversation Endpoints

The system SHALL provide endpoints for user conversation with the head manager.

#### Scenario: Send message to head manager
- **GIVEN** the system is running
- **WHEN** POST /api/conversation/message with { content: 'Hello' } is called
- **THEN** the head manager is created if not exists
- **AND** the message is sent to the head manager via ACP
- **AND** the response includes { status: 'sent', agent_id }

#### Scenario: Get conversation history
- **GIVEN** previous messages with the head manager
- **WHEN** GET /api/conversation/history is called
- **THEN** the conversation history is returned
- **AND** messages include role (user/assistant), content, timestamp

---

### Requirement: Agent Endpoints

The system SHALL provide read-only endpoints for agent information.

#### Scenario: List agents
- **GIVEN** multiple agents in the system
- **WHEN** GET /api/agents is called
- **THEN** all agents are returned with id, state, task summary, parent

#### Scenario: List agents with filter
- **GIVEN** agents in various states
- **WHEN** GET /api/agents?state=running is called
- **THEN** only running agents are returned

#### Scenario: Get agent details
- **GIVEN** agent 'agent_1' exists
- **WHEN** GET /api/agents/agent_1 is called
- **THEN** full agent details are returned including config, timestamps, children

#### Scenario: Get agent hierarchy
- **GIVEN** agent 'agent_1' with children
- **WHEN** GET /api/agents/agent_1/hierarchy is called
- **THEN** the subtree under agent_1 is returned as a tree structure

---

### Requirement: Task Endpoints

The system SHALL provide read-only endpoints for task information.

#### Scenario: List tasks
- **GIVEN** multiple tasks in the system
- **WHEN** GET /api/tasks is called
- **THEN** all tasks are returned with id, description, status, assigned_agent

#### Scenario: List tasks with filter
- **GIVEN** tasks in various statuses
- **WHEN** GET /api/tasks?status=in_progress is called
- **THEN** only in-progress tasks are returned

#### Scenario: Get task details
- **GIVEN** task 'task_1' exists
- **WHEN** GET /api/tasks/task_1 is called
- **THEN** full task details are returned including inputs, outputs, artifacts, agent_history

---

### Requirement: Event Endpoints

The system SHALL provide endpoints for event queries (debugging).

#### Scenario: Query events
- **GIVEN** events in the event store
- **WHEN** GET /api/events?type=status is called
- **THEN** status events are returned in chronological order

#### Scenario: Query events with time range
- **GIVEN** events spanning multiple timestamps
- **WHEN** GET /api/events?after=timestamp1&before=timestamp2 is called
- **THEN** only events within the time range are returned

---

### Requirement: WebSocket Real-time Updates

The system SHALL provide WebSocket channels for real-time updates.

#### Scenario: Subscribe to agent updates
- **GIVEN** a WebSocket connection
- **WHEN** client sends { type: 'subscribe', channel: 'agents' }
- **THEN** the client receives agent:update events when agents change state

#### Scenario: Subscribe to task updates
- **GIVEN** a WebSocket connection
- **WHEN** client sends { type: 'subscribe', channel: 'tasks' }
- **THEN** the client receives task:update events when tasks change

#### Scenario: Subscribe to conversation
- **GIVEN** a WebSocket connection
- **WHEN** client sends { type: 'subscribe', channel: 'conversation' }
- **THEN** the client receives conversation:message events for head manager responses

#### Scenario: TinyBase to WebSocket bridge
- **GIVEN** a client subscribed to 'agents' channel
- **WHEN** a spawn event is emitted and the agents view updates
- **THEN** the WebSocket client receives the agent:update event in real-time

---

### Requirement: CLI Start Command

The system SHALL provide a command to start the multi-agent system.

#### Scenario: Start system
- **GIVEN** the CLI is installed
- **WHEN** `multiagent start` is executed
- **THEN** the API server starts
- **AND** the event store is initialized
- **AND** the MCP server starts
- **AND** a success message is displayed

#### Scenario: Start with custom port
- **GIVEN** the CLI is installed
- **WHEN** `multiagent start --port 4000` is executed
- **THEN** the API server starts on port 4000

---

### Requirement: CLI Chat Command

The system SHALL provide an interactive chat mode.

#### Scenario: Enter chat mode
- **GIVEN** the system is running
- **WHEN** `multiagent chat` is executed
- **THEN** a prompt appears for user input
- **AND** a WebSocket connection is established for real-time updates

#### Scenario: Send message in chat
- **GIVEN** chat mode is active
- **WHEN** user types a message and presses enter
- **THEN** the message is sent to the head manager
- **AND** the response streams back and is displayed

#### Scenario: Real-time status in chat
- **GIVEN** chat mode is active with verbose flag
- **WHEN** an agent status changes
- **THEN** a status line is displayed: [status] Agent X: running

---

### Requirement: CLI Status Commands

The system SHALL provide commands to view system state.

#### Scenario: System status
- **GIVEN** the system is running
- **WHEN** `multiagent status` is executed
- **THEN** system status is displayed (running/stopped)
- **AND** head manager info is displayed
- **AND** aggregate counts are displayed (agents, tasks)

#### Scenario: List agents
- **GIVEN** agents exist in the system
- **WHEN** `multiagent agents` is executed
- **THEN** a table of agents is displayed with id, state, task

#### Scenario: Agent details
- **GIVEN** agent 'agent_1' exists
- **WHEN** `multiagent agents agent_1` is executed
- **THEN** detailed agent info is displayed

#### Scenario: List tasks
- **GIVEN** tasks exist in the system
- **WHEN** `multiagent tasks` is executed
- **THEN** a table of tasks is displayed with id, status, assigned_agent

#### Scenario: Task details
- **GIVEN** task 'task_1' exists
- **WHEN** `multiagent tasks task_1` is executed
- **THEN** detailed task info is displayed

---

### Requirement: CLI Hierarchy Command

The system SHALL provide a command to visualize the agent tree.

#### Scenario: Display hierarchy
- **GIVEN** a multi-level agent hierarchy
- **WHEN** `multiagent hierarchy` is executed
- **THEN** a tree visualization is displayed:
```
agent_abc123 (head_manager) [running]
├── agent_def456 (architect) [completed]
├── agent_ghi789 (implementer) [running]
│   ├── agent_jkl012 (auth_module) [completed]
│   └── agent_mno345 (api_routes) [running]
└── agent_pqr678 (reviewer) [stopped]
```

---

### Requirement: CLI Management Commands

The system SHALL provide commands for system management.

#### Scenario: Clear system
- **GIVEN** the system has history
- **WHEN** `multiagent clear` is executed
- **THEN** the user is prompted for confirmation
- **AND** if confirmed, the event store is cleared
- **AND** a new head manager will be created on next interaction

#### Scenario: Stop system
- **GIVEN** the system is running
- **WHEN** `multiagent stop` is executed
- **THEN** all running agents are terminated gracefully
- **AND** the API server stops
- **AND** state is persisted


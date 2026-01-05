## ADDED Requirements

### Requirement: Agent Spawning

The system SHALL spawn new agents with unique IDs, session management, and event emission.

#### Scenario: Spawn a child agent
- **GIVEN** an initialized AgentManager and a running parent agent 'parent_1'
- **WHEN** spawn({ task: 'implement auth', parent: 'parent_1' }) is called
- **THEN** a unique agent_id is generated
- **AND** a task is created for the agent (if task_id not provided)
- **AND** an ACP session is started for the agent
- **AND** a spawn event is emitted to the event store
- **AND** default subscriptions are set up (agent, task, lineage)
- **AND** the parent is subscribed to the child's subtree (unless subscribe_parent: false)
- **AND** the function returns the new agent record

#### Scenario: Spawn with custom configuration
- **GIVEN** an initialized AgentManager
- **WHEN** spawn({ task: 'review code', parent: 'parent_1', config: { model: 'claude-opus-4-20250514', timeout: 3600000 } }) is called
- **THEN** the agent is created with the specified model and timeout
- **AND** these config values are included in the spawn event payload

#### Scenario: Spawn with explicit task_id
- **GIVEN** an existing task 'task_123'
- **WHEN** spawn({ task: 'implement feature', parent: 'parent_1', task_id: 'task_123' }) is called
- **THEN** the agent is assigned to task 'task_123'
- **AND** no new task is created

---

### Requirement: Agent Termination

The system SHALL terminate agents and update their state appropriately.

#### Scenario: Terminate a running agent
- **GIVEN** a running agent 'agent_1' with session 'sess_123'
- **WHEN** terminate('agent_1', 'completed') is called
- **THEN** the ACP session is terminated
- **AND** a terminate event is emitted with reason 'completed'
- **AND** the agent's state in the view changes to 'stopped'
- **AND** the agent's associated task status is updated to 'completed'

#### Scenario: Terminate with failure
- **GIVEN** a running agent 'agent_1'
- **WHEN** terminate('agent_1', 'failed') is called
- **THEN** a terminate event is emitted with reason 'failed'
- **AND** the agent's associated task status is updated to 'failed'

#### Scenario: Terminate non-existent agent
- **GIVEN** no agent with id 'nonexistent'
- **WHEN** terminate('nonexistent', 'stopped') is called
- **THEN** an error is returned indicating agent not found

---

### Requirement: Agent Queries

The system SHALL support querying agents by various criteria.

#### Scenario: Get agent by ID
- **GIVEN** an agent 'agent_1' exists
- **WHEN** get('agent_1') is called
- **THEN** the full agent record is returned including id, session_id, parent, state, task, config, timestamps

#### Scenario: Get non-existent agent
- **GIVEN** no agent with id 'nonexistent'
- **WHEN** get('nonexistent') is called
- **THEN** null is returned

#### Scenario: List agents with filter
- **GIVEN** agents in various states (running, stopped)
- **WHEN** list({ state: 'running' }) is called
- **THEN** only agents in 'running' state are returned

#### Scenario: List agents by parent
- **GIVEN** parent agent 'parent_1' with children 'child_1' and 'child_2'
- **WHEN** list({ parent: 'parent_1' }) is called
- **THEN** both 'child_1' and 'child_2' are returned

---

### Requirement: Agent Hierarchy

The system SHALL track and query the agent hierarchy.

#### Scenario: Get children of an agent
- **GIVEN** agent 'manager_1' has spawned 'worker_1' and 'worker_2'
- **WHEN** getChildren('manager_1') is called
- **THEN** both 'worker_1' and 'worker_2' are returned

#### Scenario: Get hierarchy tree
- **GIVEN** a hierarchy: head_manager → manager_1 → [worker_1, worker_2]
- **WHEN** getHierarchy('head_manager') is called
- **THEN** a tree structure is returned with head_manager at root
- **AND** manager_1 as a child with worker_1 and worker_2 as its children
- **AND** each node includes agent_id, task, and state

#### Scenario: Get hierarchy with depth limit
- **GIVEN** a deep hierarchy (4+ levels)
- **WHEN** getHierarchy('root', { depth: 2 }) is called
- **THEN** only 2 levels of the hierarchy are returned

---

### Requirement: Head Manager Bootstrap

The system SHALL create or retrieve the head manager agent on demand.

#### Scenario: Create head manager on first interaction
- **GIVEN** no agents exist in the system
- **WHEN** getOrCreateHeadManager() is called
- **THEN** a new head manager agent is spawned with parent: null
- **AND** the agent's task is set to the system head_manager_task from config
- **AND** the agent is returned

#### Scenario: Return existing head manager
- **GIVEN** a running head manager agent exists
- **WHEN** getOrCreateHeadManager() is called
- **THEN** the existing head manager is returned
- **AND** no new agent is spawned

#### Scenario: Create new head manager after previous stopped
- **GIVEN** a stopped head manager agent exists (no running head manager)
- **WHEN** getOrCreateHeadManager() is called
- **THEN** a new head manager agent is spawned
- **AND** the new agent is returned

---

### Requirement: System Prompt Generation

The system SHALL generate appropriate system prompts for spawned agents.

#### Scenario: Generate prompt for child agent
- **GIVEN** spawning a child agent with parent 'manager_1' and task 'implement auth'
- **WHEN** the system prompt is generated
- **THEN** the prompt includes the agent_id and session_id
- **AND** the prompt includes the task description
- **AND** the prompt includes the parent agent_id
- **AND** the prompt includes the lineage chain
- **AND** the prompt includes available MCP tools
- **AND** the prompt includes guidance for status reporting and messaging

#### Scenario: Generate prompt for head manager
- **GIVEN** spawning the head manager (parent: null)
- **WHEN** the system prompt is generated
- **THEN** the prompt includes head manager specific responsibilities
- **AND** the prompt indicates this agent interacts directly with users
- **AND** the prompt includes guidance for task decomposition and child spawning

## ADDED Requirements

### Requirement: claim_task Tool

The system SHALL expose a `claim_task` MCP tool gated by the `task.claim` capability. The tool finds and atomically claims the next available task matching optional filters.

#### Scenario: Claim next available task
- **GIVEN** an agent with `task.claim` capability
- **WHEN** the agent calls `claim_task` with no arguments
- **THEN** the next pending task is claimed and returned with its ID, description, tags, and metadata

#### Scenario: Claim with tag filter
- **GIVEN** an agent calls `claim_task` with `{ tags: ["backend"] }`
- **WHEN** matching pending tasks exist
- **THEN** the highest-priority matching task is claimed and returned

#### Scenario: No tasks available
- **GIVEN** an agent calls `claim_task`
- **WHEN** no pending tasks match the filters
- **THEN** the tool returns `{ claimed: false, message: "No tasks available" }`

#### Scenario: Agent lacks capability
- **GIVEN** an agent without `task.claim` capability
- **WHEN** the agent attempts to use `claim_task`
- **THEN** the tool is not available in the agent's MCP tool list

### Requirement: unclaim_task Tool

The system SHALL expose an `unclaim_task` MCP tool gated by the `task.claim` capability. The tool returns a claimed task to the pending pool.

#### Scenario: Unclaim a task
- **GIVEN** an agent has claimed `task-1`
- **WHEN** the agent calls `unclaim_task` with `{ task_id: "task-1", reason: "blocked on dependency" }`
- **THEN** the task returns to `pending` status and the reason is recorded

#### Scenario: Cannot unclaim another agent's task
- **GIVEN** `task-1` is claimed by a different agent
- **WHEN** the calling agent attempts `unclaim_task` for `task-1`
- **THEN** the tool returns an error indicating the agent is not the task owner

### Requirement: list_claimable_tasks Tool

The system SHALL expose a `list_claimable_tasks` MCP tool gated by the `task.claim` capability. The tool returns a list of pending tasks available for claiming, without claiming them.

#### Scenario: List available tasks
- **GIVEN** 5 pending tasks exist
- **WHEN** an agent calls `list_claimable_tasks` with `{ limit: 10 }`
- **THEN** the tool returns up to 10 pending tasks with their IDs, descriptions, and tags

#### Scenario: List with tag filter
- **GIVEN** pending tasks with various tags exist
- **WHEN** an agent calls `list_claimable_tasks` with `{ tags: ["frontend"], limit: 5 }`
- **THEN** only tasks matching the tag filter are returned

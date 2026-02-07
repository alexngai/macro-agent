## ADDED Requirements

### Requirement: Team-Aware Agent Spawning

The AgentManager SHALL accept an optional team context when spawning agents. When a team is active, spawned agents inherit the team's configuration (integration strategy, task mode, team name) via environment variables and system prompt context.

#### Scenario: Spawn agent within a team
- **GIVEN** team `self-driving` is active with integration strategy `trunk` and task mode `pull`
- **WHEN** a planner spawns a worker
- **THEN** the worker's environment includes `MACRO_TEAM_NAME=self-driving`, `MACRO_INTEGRATION_STRATEGY=trunk`, `MACRO_TASK_MODE=pull`, and the system prompt includes team context

#### Scenario: Spawn agent without a team
- **GIVEN** no team is loaded
- **WHEN** an agent is spawned
- **THEN** the spawn proceeds with default behavior (no team environment variables, default integration strategy `queue`, default task mode `push`)

### Requirement: Agent Session Resumption

The AgentManager SHALL support resuming an agent from persisted session history. The `resume(agentId, options?)` method spawns a new agent process with the prior agent's session history loaded as initial context.

#### Scenario: Resume a terminated agent
- **GIVEN** agent `worker-1` terminated and has persisted session history
- **WHEN** `resume("worker-1", { task: "Continue the previous work" })` is called
- **THEN** a new agent process is spawned with the same role and capabilities, the prior session history is loaded as context, and a resume prompt is prepended explaining the continuation

#### Scenario: Resume with context window limits
- **GIVEN** agent `worker-1` has 200 messages of session history and the configured max is 50
- **WHEN** the agent is resumed
- **THEN** the most recent 50 messages are loaded, with a summary of earlier context prepended

#### Scenario: Resume preserves team context
- **GIVEN** agent `worker-1` was part of team `self-driving`
- **WHEN** the agent is resumed
- **THEN** the resumed agent inherits the same team context (integration strategy, task mode, team name)

## MODIFIED Requirements

### Requirement: System Prompt Generation

The system SHALL generate appropriate system prompts for spawned agents, including team-specific context when a team is active.

#### Scenario: Generate prompt for child agent
- **GIVEN** spawning a child agent with parent 'manager_1' and task 'implement auth'
- **WHEN** the system prompt is generated
- **THEN** the prompt includes the agent_id and session_id
- **AND** the prompt includes the task description
- **AND** the prompt includes the parent agent_id
- **AND** the prompt includes the lineage chain
- **AND** the prompt includes available MCP tools
- **AND** the prompt includes guidance for status reporting and messaging
- **AND** when a team is active, the prompt includes a team context section with the team name, integration strategy, and task mode

#### Scenario: Generate prompt for head manager
- **GIVEN** spawning the head manager (parent: null)
- **WHEN** the system prompt is generated
- **THEN** the prompt includes head manager specific responsibilities
- **AND** the prompt indicates this agent interacts directly with users
- **AND** the prompt includes guidance for task decomposition and child spawning
- **AND** when a team is active, the prompt includes team bootstrap context listing companion roles and the team's operational philosophy

#### Scenario: Generate prompt with team prompt template
- **GIVEN** spawning an agent in a team where the role specifies `prompt: "prompts/planner.md"`
- **WHEN** the system prompt is generated
- **THEN** the contents of the team's prompt template file are included in the agent's system prompt alongside the standard sections

## ADDED Requirements

### Requirement: Team Template Loading

The system SHALL support loading team templates from a directory structure under `.macro-agent/teams/<team-name>/` containing a `team.yaml` manifest and optional role definitions and prompt templates.

#### Scenario: Load team template from directory
- **GIVEN** a directory `.macro-agent/teams/self-driving/` exists with a valid `team.yaml`
- **WHEN** the system starts with `--team self-driving`
- **THEN** the TeamLoader reads `team.yaml`, registers all declared roles into the RoleRegistry, configures the integration strategy on the WorkspaceManager, and sets the task mode on the TaskBackend

#### Scenario: Team template with custom roles
- **GIVEN** a team template with `roles/planner.yaml` that declares `extends: coordinator`
- **WHEN** the team is loaded
- **THEN** the role `planner` is registered in the RoleRegistry with the coordinator's capabilities merged with any overrides from `planner.yaml`

#### Scenario: Team template not found
- **GIVEN** no directory exists at `.macro-agent/teams/nonexistent/`
- **WHEN** the system starts with `--team nonexistent`
- **THEN** the system SHALL emit an error and refuse to start

### Requirement: Team Manifest Schema

The `team.yaml` manifest SHALL declare: team name, description, version, roles list, bootstrap configuration (root agent and companions), integration strategy, task mode, and observability settings.

#### Scenario: Minimal valid manifest
- **GIVEN** a `team.yaml` with only `name`, `roles`, and `bootstrap.root`
- **WHEN** the manifest is parsed
- **THEN** defaults are applied: integration strategy `queue`, task mode `push`, observability disabled

#### Scenario: Full manifest with all sections
- **GIVEN** a `team.yaml` declaring integration strategy `trunk`, task mode `pull`, and observability with a 3600s metrics window
- **WHEN** the manifest is parsed
- **THEN** all declared settings override defaults and are propagated to the respective subsystems

### Requirement: Team Bootstrap

When a team is loaded, the system SHALL automatically spawn the bootstrap agents declared in the manifest: a root agent and zero or more companion agents.

#### Scenario: Bootstrap with root and companion
- **GIVEN** a team manifest declaring root role `planner` and companion role `judge`
- **WHEN** the team is initialized
- **THEN** the system spawns a planner agent as the root, then spawns a judge agent as a peer, both receiving the team context in their system prompts

#### Scenario: Bootstrap with custom prompt template
- **GIVEN** a team manifest where root declares `prompt: "prompts/planner.md"`
- **WHEN** the root agent is spawned
- **THEN** the contents of `prompts/planner.md` from the team template directory are included in the agent's system prompt

### Requirement: Team Context Propagation

All agents spawned within a team SHALL receive the team name, integration strategy, and task mode as part of their environment and system prompt context.

#### Scenario: Worker spawned within a team
- **GIVEN** a planner in team `self-driving` spawns a worker
- **WHEN** the worker's system prompt is generated
- **THEN** the prompt includes the team name, the active integration strategy (`trunk`), and the task mode (`pull`), so the worker knows how to operate

#### Scenario: Agent environment includes team context
- **GIVEN** an agent is spawned within team `self-driving`
- **WHEN** the agent process starts
- **THEN** environment variables `MACRO_TEAM_NAME` and `MACRO_INTEGRATION_STRATEGY` and `MACRO_TASK_MODE` are set

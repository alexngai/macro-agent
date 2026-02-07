## ADDED Requirements

### Requirement: Team CLI Flag

The CLI `start` command SHALL accept a `--team <name>` flag that loads the specified team template before initializing the system.

#### Scenario: Start with team flag
- **GIVEN** a team template `self-driving` exists at `.macro-agent/teams/self-driving/`
- **WHEN** the user runs `macro-agent start --team self-driving`
- **THEN** the system loads the team template, registers its roles, applies its configuration, and boots the team's root and companion agents

#### Scenario: Start without team flag
- **GIVEN** no `--team` flag is provided
- **WHEN** the user runs `macro-agent start`
- **THEN** the system starts with default configuration and no team template (existing behavior)

### Requirement: Metrics API Endpoints

The API server SHALL expose endpoints for querying observability metrics when observability is enabled.

#### Scenario: GET throughput metrics
- **GIVEN** the API server is running with observability enabled
- **WHEN** a client calls `GET /api/metrics/throughput?window=3600`
- **THEN** the server returns `{ tasksCompleted, tasksCreated, commits, window }` for the specified period

#### Scenario: GET utilization metrics
- **GIVEN** the API server is running
- **WHEN** a client calls `GET /api/metrics/utilization`
- **THEN** the server returns `{ active, idle, blocked, total }` agent counts

#### Scenario: GET error metrics
- **GIVEN** the API server is running
- **WHEN** a client calls `GET /api/metrics/errors?window=3600`
- **THEN** the server returns `{ taskFailures, conflicts, errorRate, window }`

### Requirement: Team Status Endpoint

The API server SHALL expose an endpoint for querying the active team configuration.

#### Scenario: GET team status
- **GIVEN** team `self-driving` is active
- **WHEN** a client calls `GET /api/team`
- **THEN** the server returns the team name, active roles, integration strategy, task mode, and bootstrap agent IDs

#### Scenario: No team active
- **GIVEN** no team is loaded
- **WHEN** a client calls `GET /api/team`
- **THEN** the server returns `{ active: false }`

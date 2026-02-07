## ADDED Requirements

### Requirement: Throughput Metrics View

The EventStore SHALL maintain a materialized view that tracks task and commit throughput over a configurable sliding window.

#### Scenario: Query task throughput
- **GIVEN** 15 tasks were completed in the last hour
- **WHEN** the throughput view is queried with a 3600s window
- **THEN** the view returns `{ tasksCompleted: 15, tasksCreated: N, tasksPerHour: 15 }` for that window

#### Scenario: Query commit throughput
- **GIVEN** workers made 42 commits in the last hour
- **WHEN** the throughput view is queried
- **THEN** the view returns `{ commits: 42, commitsPerHour: 42 }` including merge commits and direct pushes

#### Scenario: Empty window
- **GIVEN** no activity occurred in the last hour
- **WHEN** the throughput view is queried
- **THEN** the view returns zero counts without error

### Requirement: Agent Utilization View

The EventStore SHALL maintain a view that tracks agent utilization: how many agents are active (executing tasks), idle (waiting for tasks), or blocked.

#### Scenario: Query utilization
- **GIVEN** 8 agents are running: 5 executing tasks, 2 waiting for claims, 1 blocked
- **WHEN** the utilization view is queried
- **THEN** the view returns `{ active: 5, idle: 2, blocked: 1, total: 8 }`

#### Scenario: Utilization history
- **GIVEN** utilization snapshots are recorded every 5 minutes
- **WHEN** the utilization view is queried with `history: true` and a time range
- **THEN** the view returns a time series of utilization snapshots within that range

### Requirement: Error Rate View

The EventStore SHALL maintain a view that tracks error rates: task failures, build failures, and conflict frequency over a sliding window.

#### Scenario: Query error rate
- **GIVEN** 3 tasks failed and 2 merge conflicts occurred in the last hour out of 50 total task attempts
- **WHEN** the error rate view is queried
- **THEN** the view returns `{ taskFailures: 3, conflicts: 2, totalAttempts: 50, errorRate: 0.06 }`

#### Scenario: Error rate trending
- **GIVEN** error rates are computed per window
- **WHEN** the view is queried with multiple consecutive windows
- **THEN** the trend (increasing, stable, decreasing) can be derived from the returned data

### Requirement: Metrics API Endpoints

The API server SHALL expose REST endpoints for querying observability metrics.

#### Scenario: GET throughput metrics
- **GIVEN** the API server is running
- **WHEN** a client calls `GET /api/metrics/throughput?window=3600`
- **THEN** the server returns the current throughput metrics for the specified window

#### Scenario: GET utilization metrics
- **GIVEN** the API server is running
- **WHEN** a client calls `GET /api/metrics/utilization`
- **THEN** the server returns the current agent utilization breakdown

#### Scenario: GET error rate metrics
- **GIVEN** the API server is running
- **WHEN** a client calls `GET /api/metrics/errors?window=3600`
- **THEN** the server returns error rate metrics for the specified window

### Requirement: Metrics Event Emission

Agents SHALL emit structured metric events that feed the observability views, using the existing EventStore event emission mechanism.

#### Scenario: Task completion emits metric event
- **GIVEN** a worker completes a task
- **WHEN** the done() handler runs
- **THEN** a metric event is emitted with type `metric.task_completed` including task duration and agent ID

#### Scenario: Commit emits metric event
- **GIVEN** a worker pushes a commit (trunk or optimistic strategy)
- **WHEN** the push succeeds
- **THEN** a metric event is emitted with type `metric.commit_pushed` including commit SHA and branch

#### Scenario: Conflict emits metric event
- **GIVEN** a worker encounters a merge conflict during push
- **WHEN** the conflict is detected
- **THEN** a metric event is emitted with type `metric.conflict_detected` including the affected files and resolution action taken

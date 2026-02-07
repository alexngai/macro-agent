## ADDED Requirements

### Requirement: Integration Strategy Configuration

The WorkspaceManager SHALL support configurable integration strategies that determine how worker changes are merged into the integration branch. The strategy is set at the team or stream level.

#### Scenario: Default strategy is queue
- **GIVEN** no team template is loaded and no explicit strategy is configured
- **WHEN** the WorkspaceManager initializes
- **THEN** the integration strategy defaults to `queue` (existing merge queue behavior)

#### Scenario: Team sets trunk strategy
- **GIVEN** a team template declares `integration.strategy: trunk`
- **WHEN** the WorkspaceManager initializes for that team
- **THEN** the trunk integration strategy is active for all streams in that team

### Requirement: Trunk Integration Strategy

When integration strategy is `trunk`, workers SHALL commit and push directly to the integration branch. On conflict, the worker rebases and retries up to a configurable maximum.

#### Scenario: Successful direct push
- **GIVEN** integration strategy is `trunk`
- **WHEN** a worker calls `done()` with status `completed`
- **THEN** the worker's changes are committed and pushed directly to the integration branch

#### Scenario: Push conflict with successful rebase
- **GIVEN** integration strategy is `trunk` and another worker pushed since this worker's last pull
- **WHEN** the worker attempts to push
- **THEN** the worker rebases onto the latest integration branch and retries the push

#### Scenario: Push conflict exceeds max retries
- **GIVEN** integration strategy is `trunk` with `maxRetries: 3`
- **WHEN** the worker fails to push after 3 rebase-and-retry cycles
- **THEN** the worker's `done()` handler takes the configured `conflictAction`: either `abandon` (task returns to pending) or `resolve` (emit CONFLICT_DETECTED for manual resolution)

#### Scenario: Concurrent pushes from multiple workers
- **GIVEN** integration strategy is `trunk` with 10 active workers
- **WHEN** multiple workers attempt to push simultaneously
- **THEN** each worker independently rebases and retries; the system does NOT serialize pushes through a queue

### Requirement: Optimistic Integration Strategy

When integration strategy is `optimistic`, workers SHALL push to the integration branch immediately. A background validation process checks build/test status asynchronously and creates fixup tasks for failures.

#### Scenario: Optimistic push succeeds validation
- **GIVEN** integration strategy is `optimistic`
- **WHEN** a worker pushes changes and the background validator runs build+tests
- **THEN** the push is confirmed and no further action is taken

#### Scenario: Optimistic push fails validation
- **GIVEN** integration strategy is `optimistic`
- **WHEN** a worker pushes changes and the background validator detects a build or test failure
- **THEN** a new task is auto-created with tag `fixup`, referencing the failing commit, and made available for workers to claim

#### Scenario: Green branch snapshotting
- **GIVEN** integration strategy is `optimistic` and the integration branch passes validation
- **WHEN** the validator confirms a clean state
- **THEN** the current commit is tagged or branched as the latest "green" snapshot (e.g., `green/latest`)

### Requirement: Queue Integration Strategy Preserved

The existing merge queue integration strategy SHALL continue to function unchanged as the `queue` strategy, maintaining full backward compatibility.

#### Scenario: Queue strategy behavior unchanged
- **GIVEN** integration strategy is `queue`
- **WHEN** a worker calls `done()` with status `completed`
- **THEN** a merge request is submitted to the merge queue, the integrator processes it serially, and conflicts spawn resolver workers — identical to current behavior

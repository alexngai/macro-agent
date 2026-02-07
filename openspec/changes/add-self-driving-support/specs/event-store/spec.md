## ADDED Requirements

### Requirement: Session History Storage

The EventStore SHALL support storing and retrieving agent session transcripts (conversation history) for session continuation purposes.

#### Scenario: Store session transcript
- **GIVEN** agent `worker-1` terminates
- **WHEN** the session history is persisted
- **THEN** the EventStore stores the transcript as a `session_history` event associated with `worker-1`, including message count and total token estimate

#### Scenario: Retrieve session transcript
- **GIVEN** agent `worker-1` has a stored session transcript
- **WHEN** `getSessionHistory("worker-1")` is called
- **THEN** the transcript messages are returned in chronological order

#### Scenario: Retrieve session transcript with limit
- **GIVEN** agent `worker-1` has 200 stored messages
- **WHEN** `getSessionHistory("worker-1", { limit: 50 })` is called
- **THEN** the most recent 50 messages are returned

### Requirement: Metrics Materialized Views

The EventStore SHALL maintain materialized views for throughput, utilization, and error rate metrics, computed from existing event streams.

#### Scenario: Throughput view updated on task completion
- **GIVEN** a `task.completed` event is emitted
- **WHEN** the event is processed
- **THEN** the throughput materialized view is updated to reflect the new completion count within the current window

#### Scenario: Utilization view updated on agent state change
- **GIVEN** an agent transitions from idle to active (claims a task)
- **WHEN** the state change event is processed
- **THEN** the utilization materialized view is updated to reflect the new active/idle/blocked counts

#### Scenario: Error rate view updated on failure
- **GIVEN** a `task.failed` event is emitted
- **WHEN** the event is processed
- **THEN** the error rate materialized view is updated with the new failure count and recalculated rate

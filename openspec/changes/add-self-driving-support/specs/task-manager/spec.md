## ADDED Requirements

### Requirement: Task Claiming

The TaskBackend SHALL support an atomic `claim(agentId, filters?)` method that finds a pending task matching the optional filters, atomically transitions it to `assigned` with the claiming agent, and returns the task. Returns null if no matching task is available or if another agent claimed it first (optimistic locking).

#### Scenario: Claim with optimistic locking
- **GIVEN** a pending task `task-1` exists
- **WHEN** agent `worker-1` calls `claim("worker-1")`
- **THEN** `task-1` transitions to `assigned`, `assigned_to` becomes `worker-1`, and the task object is returned

#### Scenario: Claim returns null on contention
- **GIVEN** a single pending task exists
- **WHEN** two agents call `claim()` concurrently
- **THEN** one receives the task and the other receives null

### Requirement: Task Unclaiming

The TaskBackend SHALL support an `unclaim(agentId, taskId, reason?)` method that returns an assigned task back to `pending` status, clearing the assignment and recording the reason.

#### Scenario: Unclaim returns task to pool
- **GIVEN** agent `worker-1` is assigned to `task-1`
- **WHEN** `worker-1` calls `unclaim("worker-1", "task-1", "blocked")`
- **THEN** `task-1` transitions to `pending` with no assigned agent

### Requirement: Task Tags

Tasks SHALL support an optional `tags` field (array of strings) for categorization and filtered claiming.

#### Scenario: Create task with tags
- **GIVEN** a coordinator creates a task with `tags: ["frontend", "urgent"]`
- **WHEN** the task is retrieved
- **THEN** the task object includes the tags array

#### Scenario: Claim filtered by tags
- **GIVEN** tasks exist with tags `["frontend"]` and `["backend"]`
- **WHEN** an agent calls `claim` with filter `{ tags: ["backend"] }`
- **THEN** only the backend-tagged task is considered

## MODIFIED Requirements

### Requirement: Task Status Updates

The system SHALL support updating task status with appropriate transitions, including the new `assigned` to `pending` transition (via unclaim) that enables the task pull model.

#### Scenario: Start task
- **GIVEN** a task 'task_1' in 'assigned' status
- **WHEN** updateStatus('task_1', 'in_progress') is called
- **THEN** a task event with action 'status_change' is emitted
- **AND** the task's status changes to 'in_progress'
- **AND** started_at is set if not already set

#### Scenario: Complete task
- **GIVEN** a task 'task_1' in 'in_progress' status
- **WHEN** updateStatus('task_1', 'completed') is called
- **THEN** a task event with action 'completed' is emitted
- **AND** the task's status changes to 'completed'
- **AND** completed_at is set to current timestamp

#### Scenario: Fail task
- **GIVEN** a task 'task_1' in 'in_progress' status
- **WHEN** updateStatus('task_1', 'failed') is called
- **THEN** a task event with action 'failed' is emitted
- **AND** the task's status changes to 'failed'

#### Scenario: Unclaim task
- **GIVEN** a task 'task_1' in 'assigned' status with an assigned agent
- **WHEN** the assigned agent calls unclaim('task_1')
- **THEN** a task event with action 'status_change' is emitted
- **AND** the task's status changes back to 'pending'
- **AND** assigned_to is cleared
- **AND** the task becomes available for claiming by other agents

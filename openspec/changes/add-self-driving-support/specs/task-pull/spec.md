## ADDED Requirements

### Requirement: Task Claiming

The TaskBackend SHALL support an atomic `claim(agentId, filters?)` operation that finds a claimable task matching the filters, transitions it from `pending` to `assigned`, and returns it to the claiming agent. If no matching task is available or another agent claims it first, the operation returns null.

#### Scenario: Successful task claim
- **GIVEN** a task exists with status `pending` and no assigned agent
- **WHEN** agent `worker-1` calls `claim()` with no filters
- **THEN** the task status transitions to `assigned`, `assigned_to` is set to `worker-1`, and the task is returned

#### Scenario: Concurrent claim contention
- **GIVEN** a single pending task exists
- **WHEN** agent `worker-1` and agent `worker-2` both call `claim()` simultaneously
- **THEN** exactly one agent receives the task and the other receives null

#### Scenario: Claim with tag filter
- **GIVEN** tasks exist with tags `["frontend"]` and `["backend"]`
- **WHEN** agent calls `claim({ tags: ["backend"] })`
- **THEN** only the backend-tagged task is considered for claiming

#### Scenario: No claimable tasks
- **GIVEN** all tasks are either assigned, in_progress, or completed
- **WHEN** an agent calls `claim()`
- **THEN** null is returned

### Requirement: Task Unclaiming

The TaskBackend SHALL support an `unclaim(agentId, taskId, reason?)` operation that returns a claimed task to `pending` status, making it available for other agents.

#### Scenario: Agent unclaims a task
- **GIVEN** agent `worker-1` has claimed task `task-1`
- **WHEN** `worker-1` calls `unclaim("task-1", "task is blocked")`
- **THEN** the task status transitions back to `pending`, `assigned_to` is cleared, and the reason is recorded in task history

#### Scenario: Cannot unclaim task assigned to another agent
- **GIVEN** agent `worker-2` has claimed task `task-1`
- **WHEN** agent `worker-1` calls `unclaim("task-1")`
- **THEN** the operation fails with an authorization error

### Requirement: claim_task MCP Tool

The system SHALL expose a `claim_task` MCP tool that allows agents to discover and claim available tasks.

#### Scenario: Worker claims next available task
- **GIVEN** an agent with `task.claim` capability calls `claim_task` with no filters
- **WHEN** a pending task exists
- **THEN** the tool returns the claimed task's ID, description, and metadata

#### Scenario: Worker claims with filters
- **GIVEN** an agent calls `claim_task` with `{ tags: ["frontend"], priority: "high" }`
- **WHEN** matching pending tasks exist
- **THEN** the highest-priority matching task is claimed and returned

#### Scenario: No tasks available
- **GIVEN** an agent calls `claim_task`
- **WHEN** no claimable tasks exist
- **THEN** the tool returns a message indicating no tasks are available, and the agent MAY choose to wait or self-terminate

### Requirement: unclaim_task MCP Tool

The system SHALL expose an `unclaim_task` MCP tool that allows agents to return a claimed task to the available pool.

#### Scenario: Worker returns a task
- **GIVEN** an agent has a claimed task `task-1`
- **WHEN** the agent calls `unclaim_task` with `{ task_id: "task-1", reason: "blocked on dependency" }`
- **THEN** the task returns to `pending` status and becomes claimable by other agents

### Requirement: Worker Pull Loop Lifecycle

When task mode is `pull`, workers SHALL operate in a claim-execute-complete loop: claim a task, execute it, call `done()`, then attempt to claim the next task. Workers self-terminate after an idle timeout if no tasks are available.

#### Scenario: Worker completes task and claims next
- **GIVEN** a worker in pull mode has completed a task via `done()`
- **WHEN** additional pending tasks exist
- **THEN** the worker's done handler does NOT terminate the agent; instead, the worker claims the next task and continues

#### Scenario: Worker idle timeout
- **GIVEN** a worker in pull mode calls `claim_task` and receives null
- **WHEN** no tasks become available within the configured `idleTimeout` (default 300s)
- **THEN** the worker self-terminates with status `completed` and summary indicating idle exit

#### Scenario: Pull mode coexists with push mode
- **GIVEN** the team task mode is `pull`
- **WHEN** a coordinator explicitly spawns a worker with a task assignment (push)
- **THEN** the worker executes that task normally, and upon completion either enters pull mode or terminates based on configuration

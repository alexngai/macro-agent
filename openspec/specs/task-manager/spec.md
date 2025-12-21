# task-manager Specification

## Purpose
TBD - created by archiving change add-mvp-foundation. Update Purpose after archive.
## Requirements
### Requirement: Task Creation

The system SHALL create tasks with unique IDs and emit task events.

#### Scenario: Create a new task
- **GIVEN** an initialized TaskManager
- **WHEN** create({ description: 'Implement user authentication', created_by: 'agent_1' }) is called
- **THEN** a unique task_id is generated
- **AND** a task event with action 'created' is emitted
- **AND** the task appears in the tasks view with status 'pending'
- **AND** the function returns the new task record

#### Scenario: Create task with inputs
- **GIVEN** an initialized TaskManager
- **WHEN** create({ description: 'Review PR #123', created_by: 'manager_1', inputs: { pr_number: 123, repo: 'my-repo' } }) is called
- **THEN** the task is created with the provided inputs
- **AND** the inputs are stored in the task record

---

### Requirement: Task Retrieval

The system SHALL support retrieving tasks by ID and filtering.

#### Scenario: Get task by ID
- **GIVEN** a task 'task_1' exists
- **WHEN** get('task_1') is called
- **THEN** the full task record is returned including id, description, status, assigned_agent, timestamps

#### Scenario: Get non-existent task
- **GIVEN** no task with id 'nonexistent'
- **WHEN** get('nonexistent') is called
- **THEN** null is returned

#### Scenario: List tasks with status filter
- **GIVEN** tasks in various statuses (pending, in_progress, completed)
- **WHEN** list({ status: 'in_progress' }) is called
- **THEN** only tasks with status 'in_progress' are returned

#### Scenario: List tasks by assigned agent
- **GIVEN** agent 'worker_1' assigned to tasks 'task_1' and 'task_2'
- **WHEN** list({ assigned_agent: 'worker_1' }) is called
- **THEN** both 'task_1' and 'task_2' are returned

---

### Requirement: Task Assignment

The system SHALL support assigning and unassigning agents to tasks.

#### Scenario: Assign agent to task
- **GIVEN** a task 'task_1' in 'pending' status
- **WHEN** assign('task_1', 'worker_1') is called
- **THEN** a task event with action 'assigned' is emitted
- **AND** the task's assigned_agent is set to 'worker_1'
- **AND** the task's status changes to 'assigned'
- **AND** an entry is added to the task's agent_history

#### Scenario: Assign with role
- **GIVEN** a task 'task_1' in 'pending' status
- **WHEN** assign('task_1', 'reviewer_1', 'reviewer') is called
- **THEN** the agent_history entry includes role 'reviewer'

#### Scenario: Unassign agent from task
- **GIVEN** a task 'task_1' assigned to 'worker_1'
- **WHEN** unassign('task_1', 'worker_1') is called
- **THEN** a task event with action 'unassigned' is emitted
- **AND** the task's assigned_agent is cleared
- **AND** the agent_history entry's ended_at is set

---

### Requirement: Task Status Updates

The system SHALL support updating task status with appropriate transitions.

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

---

### Requirement: Task Updates

The system SHALL support updating task metadata.

#### Scenario: Update task outputs
- **GIVEN** a task 'task_1' in 'in_progress' status
- **WHEN** update('task_1', { outputs: { result: 'success', files_changed: 5 } }) is called
- **THEN** the task's outputs are updated
- **AND** the change is reflected in the tasks view

#### Scenario: Add artifact to task
- **GIVEN** a task 'task_1'
- **WHEN** update('task_1', { artifacts: [{ type: 'file', ref: 'src/auth.ts' }] }) is called
- **THEN** the artifact is added to the task's artifacts array

---

### Requirement: Subtask Management

The system SHALL support hierarchical task decomposition.

#### Scenario: Create subtask
- **GIVEN** a parent task 'task_1'
- **WHEN** createSubtask('task_1', { description: 'Implement JWT validation', created_by: 'manager_1' }) is called
- **THEN** a new task is created with parent_task set to 'task_1'
- **AND** the new task_id is added to task_1's subtasks array

#### Scenario: Get subtasks
- **GIVEN** task 'task_1' with subtasks 'task_2' and 'task_3'
- **WHEN** getSubtasks('task_1') is called
- **THEN** both 'task_2' and 'task_3' task records are returned

#### Scenario: Subtask status rollup
- **GIVEN** task 'task_1' with subtasks 'task_2' (completed) and 'task_3' (in_progress)
- **WHEN** querying task 'task_1'
- **THEN** the parent task can derive aggregate status from subtask statuses


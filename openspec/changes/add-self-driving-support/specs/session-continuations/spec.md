## ADDED Requirements

### Requirement: Session History Persistence

The system SHALL persist agent session history (conversation transcript) to the EventStore so that agents can be resumed after process termination.

#### Scenario: Session history saved on agent completion
- **GIVEN** an agent has been running and accumulating conversation history
- **WHEN** the agent terminates (via `done()`, crash, or external stop)
- **THEN** the session transcript is persisted as a session event in the EventStore, associated with the agent ID

#### Scenario: Session history saved periodically
- **GIVEN** an agent is running with session continuation enabled
- **WHEN** a configurable checkpoint interval elapses (default: after each tool call round-trip)
- **THEN** the latest session state is persisted, so that a crash loses at most one round-trip of history

### Requirement: Agent Session Resumption

The system SHALL support resuming an agent from its persisted session history, spawning a new process that continues where the previous session left off.

#### Scenario: Resume agent after graceful termination
- **GIVEN** agent `worker-1` completed a task and has persisted session history
- **WHEN** `worker-1` is resumed with a new task
- **THEN** a new agent process is spawned with the prior session history loaded as context, and a resume prompt explaining the continuation

#### Scenario: Resume agent after crash
- **GIVEN** agent `worker-1` crashed mid-task with persisted checkpoints
- **WHEN** the system detects the crash (via health check timeout) and resumes the agent
- **THEN** a new process is spawned with the last checkpointed session history, and a resume prompt explaining the crash recovery and current task state

#### Scenario: Resume with context window management
- **GIVEN** an agent's full session history exceeds the model's context window
- **WHEN** the agent is resumed
- **THEN** only the most recent N messages are loaded (configurable), with a summary of earlier context prepended

### Requirement: Session Continuation Configuration

Session continuation behavior SHALL be configurable per team or per role.

#### Scenario: Enable continuations for a role
- **GIVEN** a role definition includes `lifecycle.continuation: true`
- **WHEN** agents with that role terminate
- **THEN** their session history is persisted for potential resumption

#### Scenario: Disable continuations (default)
- **GIVEN** a role definition does not specify `lifecycle.continuation`
- **WHEN** agents with that role terminate
- **THEN** no session history is persisted beyond normal event logging

#### Scenario: Configure history retention
- **GIVEN** a team template declares `continuations.maxHistory: 50` (messages)
- **WHEN** an agent is resumed
- **THEN** at most 50 messages from the prior session are loaded into the new session context

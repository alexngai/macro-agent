## ADDED Requirements

### Requirement: Event Store Initialization

The system SHALL provide an EventStore that initializes TinyBase with persistent storage.

#### Scenario: Store initialization with default config
- **GIVEN** no existing store file
- **WHEN** createEventStore() is called with default config
- **THEN** a new TinyBase store is created at ~/.multiagent/store.db
- **AND** the events table is created with the correct schema
- **AND** materialized view tables are initialized (agents, tasks, messages, subscriptions)

#### Scenario: Store initialization with existing data
- **GIVEN** an existing store file with previous events
- **WHEN** createEventStore() is called
- **THEN** the existing store is loaded
- **AND** materialized views are rebuilt from the event log

---

### Requirement: Event Emission

The system SHALL emit events to an append-only log with auto-generated IDs and timestamps.

#### Scenario: Emit a spawn event
- **GIVEN** an initialized EventStore
- **WHEN** emit({ type: 'spawn', source: { agent_id: 'parent_1' }, payload: { agent_id: 'child_1', task: 'do work' } }) is called
- **THEN** an event is created with a unique event_id
- **AND** the event has a timestamp set to the current time
- **AND** the event is appended to the events table
- **AND** the function returns the complete event with id and timestamp

#### Scenario: Event immutability
- **GIVEN** an event has been emitted
- **WHEN** any attempt is made to modify the event
- **THEN** the modification fails or is rejected
- **AND** the original event remains unchanged

---

### Requirement: Event Querying

The system SHALL support querying events with filters.

#### Scenario: Query events by type
- **GIVEN** an EventStore with spawn, status, and message events
- **WHEN** query({ type: 'status' }) is called
- **THEN** only status events are returned
- **AND** events are returned in chronological order

#### Scenario: Query events by source agent
- **GIVEN** an EventStore with events from multiple agents
- **WHEN** query({ source_agent_id: 'agent_1' }) is called
- **THEN** only events where source.agent_id equals 'agent_1' are returned

#### Scenario: Query events by time range
- **GIVEN** an EventStore with events spanning multiple timestamps
- **WHEN** query({ after: timestamp1, before: timestamp2 }) is called
- **THEN** only events within the time range are returned

---

### Requirement: Agent View Projection

The system SHALL maintain a materialized view of agents derived from events.

#### Scenario: Agent created on spawn event
- **GIVEN** an empty agents view
- **WHEN** a spawn event is emitted for agent_id 'agent_1'
- **THEN** the agents view contains an entry for 'agent_1'
- **AND** the entry has state 'spawning'
- **AND** the entry includes session_id, parent, task, and created_at from the event

#### Scenario: Agent state updated on status event
- **GIVEN** an agent in 'spawning' state
- **WHEN** a status event with status_type 'started' is emitted for that agent
- **THEN** the agent's state changes to 'running'
- **AND** started_at is set to the event timestamp

#### Scenario: Agent state updated on terminate event
- **GIVEN** an agent in 'running' state
- **WHEN** a terminate event is emitted for that agent with reason 'completed'
- **THEN** the agent's state changes to 'stopped'
- **AND** stop_reason is set to 'completed'
- **AND** stopped_at is set to the event timestamp

---

### Requirement: Task View Projection

The system SHALL maintain a materialized view of tasks derived from events.

#### Scenario: Task created on task event
- **GIVEN** an empty tasks view
- **WHEN** a task event with action 'created' is emitted
- **THEN** the tasks view contains an entry for the task_id
- **AND** the entry has status 'pending'
- **AND** the entry includes description and created_by from the event

#### Scenario: Task assigned on task event
- **GIVEN** a task in 'pending' status
- **WHEN** a task event with action 'assigned' is emitted
- **THEN** the task's status changes to 'assigned'
- **AND** assigned_agent is set to the agent_id from the event

#### Scenario: Task status change
- **GIVEN** a task in 'assigned' status
- **WHEN** a task event with action 'status_change' and status 'in_progress' is emitted
- **THEN** the task's status changes to 'in_progress'

---

### Requirement: Message Queue Projection

The system SHALL maintain a materialized view of pending messages per agent.

#### Scenario: Message added to recipient queue
- **GIVEN** an agent 'agent_1' with an empty message queue
- **WHEN** a message event is emitted with target.agent_id 'agent_1'
- **THEN** the message appears in agent_1's pending messages
- **AND** the message includes id, from, content, timestamp

#### Scenario: Message delivered to multiple recipients
- **GIVEN** agents 'agent_1' and 'agent_2' subscribed to topic 'updates'
- **WHEN** a message event is emitted with target.topic 'updates'
- **THEN** the message appears in both agent_1's and agent_2's pending queues

---

### Requirement: Subscription Projection

The system SHALL maintain a materialized view of agent subscriptions.

#### Scenario: Subscription added
- **GIVEN** an agent 'agent_1' with no subscriptions
- **WHEN** a subscription is registered for { type: 'topic', target: 'errors' }
- **THEN** the subscriptions view shows agent_1 subscribed to topic 'errors'

#### Scenario: Query subscribers by topic
- **GIVEN** multiple agents subscribed to topic 'discoveries'
- **WHEN** getSubscribers({ type: 'topic', target: 'discoveries' }) is called
- **THEN** all agent_ids subscribed to that topic are returned

---

### Requirement: Real-time View Updates

The system SHALL provide reactive updates when views change.

#### Scenario: Subscribe to agent view changes
- **GIVEN** a subscription to agent view changes
- **WHEN** a spawn event is emitted
- **THEN** the subscriber callback is invoked with the updated agent entry

#### Scenario: Subscribe to specific agent changes
- **GIVEN** a subscription to changes for agent 'agent_1'
- **WHEN** a status event is emitted for 'agent_1'
- **THEN** the subscriber callback is invoked
- **AND** changes to other agents do not trigger the callback

# message-router Specification

## Purpose
TBD - created by archiving change add-mvp-foundation. Update Purpose after archive.
## Requirements
### Requirement: Message Sending

The system SHALL route messages to recipients based on target specification.

#### Scenario: Send direct message to agent
- **GIVEN** agents 'sender_1' and 'recipient_1' exist
- **WHEN** send({ from: { agent_id: 'sender_1' }, to: { agent_id: 'recipient_1' }, content: 'Hello' }) is called
- **THEN** a message event is emitted
- **AND** the message appears in recipient_1's pending queue
- **AND** the function returns the message with id and timestamp

#### Scenario: Send message to task
- **GIVEN** task 'task_1' assigned to agent 'worker_1'
- **WHEN** send({ from: { agent_id: 'sender_1' }, to: { task_id: 'task_1' }, content: 'Status update needed' }) is called
- **THEN** the message is routed to 'worker_1' (the assigned agent)
- **AND** the message appears in worker_1's pending queue

#### Scenario: Send message to topic
- **GIVEN** agents 'agent_1' and 'agent_2' subscribed to topic 'errors'
- **WHEN** send({ from: { agent_id: 'sender_1' }, to: { topic: 'errors' }, content: 'Error detected' }) is called
- **THEN** the message appears in both agent_1's and agent_2's pending queues

#### Scenario: Send message with correlation_id
- **GIVEN** an original message with id 'msg_123'
- **WHEN** send({ from: { agent_id: 'responder' }, to: { agent_id: 'requester' }, content: 'Response', correlation_id: 'msg_123' }) is called
- **THEN** the message includes correlation_id 'msg_123' for threading

---

### Requirement: Message Retrieval

The system SHALL allow agents to retrieve their pending messages.

#### Scenario: Get pending messages
- **GIVEN** agent 'agent_1' has 3 pending messages
- **WHEN** getMessages('agent_1') is called
- **THEN** all 3 messages are returned in chronological order
- **AND** each message includes id, from, content, timestamp

#### Scenario: Get messages with limit
- **GIVEN** agent 'agent_1' has 10 pending messages
- **WHEN** getMessages('agent_1', { limit: 5 }) is called
- **THEN** only the 5 oldest messages are returned

#### Scenario: Get full message content
- **GIVEN** a message 'msg_1' with truncated content in the queue
- **WHEN** getFullMessage('msg_1') is called
- **THEN** the complete message content is returned

#### Scenario: Empty message queue
- **GIVEN** agent 'agent_1' has no pending messages
- **WHEN** getMessages('agent_1') is called
- **THEN** an empty array is returned

---

### Requirement: Subscription Management

The system SHALL manage agent subscriptions to message channels.

#### Scenario: Subscribe to topic
- **GIVEN** agent 'agent_1' with no topic subscriptions
- **WHEN** subscribe('agent_1', { type: 'topic', target: 'discoveries' }) is called
- **THEN** agent_1 is subscribed to topic 'discoveries'
- **AND** future messages to topic 'discoveries' are routed to agent_1

#### Scenario: Subscribe to agent channel
- **GIVEN** agent 'agent_1'
- **WHEN** subscribe('agent_1', { type: 'agent', target: 'agent_1' }) is called
- **THEN** agent_1 receives direct messages addressed to it

#### Scenario: Subscribe to subtree
- **GIVEN** manager 'manager_1' spawned child 'child_1'
- **WHEN** subscribe('manager_1', { type: 'subtree', target: 'child_1' }) is called
- **THEN** manager_1 receives all events from child_1 and its descendants

#### Scenario: Unsubscribe from topic
- **GIVEN** agent 'agent_1' subscribed to topic 'updates'
- **WHEN** unsubscribe('agent_1', { type: 'topic', target: 'updates' }) is called
- **THEN** agent_1 no longer receives messages to topic 'updates'

#### Scenario: Get agent subscriptions
- **GIVEN** agent 'agent_1' with multiple subscriptions
- **WHEN** getSubscriptions('agent_1') is called
- **THEN** all subscriptions are returned as an array of { type, target }

---

### Requirement: Automatic Subscription Setup

The system SHALL configure default subscriptions when agents spawn.

#### Scenario: Default subscriptions on spawn
- **GIVEN** spawning agent 'child_1' with parent 'parent_1'
- **WHEN** default subscriptions are set up
- **THEN** child_1 is subscribed to { type: 'agent', target: 'child_1' }
- **AND** child_1 is subscribed to { type: 'lineage', target: 'child_1' }
- **AND** if task_id provided, child_1 is subscribed to { type: 'task', target: task_id }

#### Scenario: Parent subtree subscription
- **GIVEN** spawning agent 'child_1' with parent 'parent_1' and subscribe_parent: true
- **WHEN** default subscriptions are set up
- **THEN** parent_1 is subscribed to { type: 'subtree', target: 'child_1' }

#### Scenario: Skip parent subscription
- **GIVEN** spawning agent 'child_1' with parent 'parent_1' and subscribe_parent: false
- **WHEN** default subscriptions are set up
- **THEN** parent_1 is NOT subscribed to child_1's subtree

---

### Requirement: Status Event Routing

The system SHALL route status events to appropriate subscribers.

#### Scenario: Route status to parent
- **GIVEN** agent 'child_1' with parent 'parent_1' subscribed to subtree
- **WHEN** child_1 emits a status event (e.g., 'checkpoint')
- **THEN** the status event appears in parent_1's message queue
- **AND** the event includes agent_id, task_id, status_type, summary

#### Scenario: Route completed status
- **GIVEN** agent 'worker_1' with manager 'manager_1' subscribed to subtree
- **WHEN** worker_1 emits status { status_type: 'completed', summary: 'Task done' }
- **THEN** manager_1 receives the completion notification
- **AND** can query worker_1 for detailed results

#### Scenario: Route failed status
- **GIVEN** agent 'worker_1' with manager 'manager_1' subscribed to subtree
- **WHEN** worker_1 emits status { status_type: 'failed', summary: 'Error occurred' }
- **THEN** manager_1 receives the failure notification
- **AND** the event includes error details for manager to decide on recovery

---

### Requirement: Message Truncation

The system SHALL truncate large messages in the queue with reference to full content.

#### Scenario: Truncate large message
- **GIVEN** a message with content exceeding the configured limit (e.g., 1000 tokens)
- **WHEN** the message is added to a recipient's queue
- **THEN** the queued message content is truncated
- **AND** the message is marked with truncated: true
- **AND** the full content is retrievable via getFullMessage(message_id)

#### Scenario: Small message not truncated
- **GIVEN** a message with content under the configured limit
- **WHEN** the message is added to a recipient's queue
- **THEN** the full content is included
- **AND** the message is marked with truncated: false


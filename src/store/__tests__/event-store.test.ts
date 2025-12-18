/**
 * Event Store Tests
 *
 * Tests for event emission, querying, and materialized view projections
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEventStore, EventStore } from '../event-store.js';

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(async () => {
    // Create in-memory store for testing
    store = await createEventStore({ inMemory: true });
  });

  afterEach(async () => {
    await store.close();
  });

  describe('Event Emission', () => {
    it('should emit events with auto-generated ID, version, and timestamp', () => {
      const event = store.emit({
        type: 'spawn',
        source: { agent_id: 'parent_1' },
        payload: {
          agent_id: 'child_1',
          session_id: 'sess_123',
          task: 'do work',
        },
      });

      expect(event.id).toMatch(/^evt_/);
      expect(event.version).toBe(1);
      expect(event.timestamp).toBeGreaterThan(0);
      expect(event.type).toBe('spawn');
      expect(event.payload.agent_id).toBe('child_1');
    });

    it('should store events in chronological order', async () => {
      store.emit({
        type: 'spawn',
        source: { agent_id: 'parent' },
        payload: { agent_id: 'agent_1', session_id: 'sess_1', task: 'task 1' },
      });

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      store.emit({
        type: 'spawn',
        source: { agent_id: 'parent' },
        payload: { agent_id: 'agent_2', session_id: 'sess_2', task: 'task 2' },
      });

      const events = store.query();
      expect(events.length).toBe(2);
      expect(events[0].timestamp).toBeLessThanOrEqual(events[1].timestamp);
    });
  });

  describe('Event Querying', () => {
    beforeEach(() => {
      // Emit various event types
      store.emit({
        type: 'spawn',
        source: { agent_id: 'parent' },
        payload: { agent_id: 'agent_1', session_id: 'sess_1', task: 'task 1' },
      });
      store.emit({
        type: 'status',
        source: { agent_id: 'agent_1' },
        payload: { status_type: 'started', summary: 'Starting work' },
      });
      store.emit({
        type: 'message',
        source: { agent_id: 'agent_1' },
        target: { agent_id: 'parent' },
        payload: { content: 'Hello' },
      });
    });

    it('should query events by type', () => {
      const statusEvents = store.query({ type: 'status' });
      expect(statusEvents.length).toBe(1);
      expect(statusEvents[0].type).toBe('status');
    });

    it('should query events by source agent', () => {
      const agentEvents = store.query({ source_agent_id: 'agent_1' });
      expect(agentEvents.length).toBe(2); // status and message
    });

    it('should query events by time range', () => {
      const now = Date.now();
      const events = store.query({ after: now - 10000, before: now + 10000 });
      expect(events.length).toBe(3);
    });

    it('should return events in chronological order', () => {
      const events = store.query();
      for (let i = 1; i < events.length; i++) {
        expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
      }
    });
  });

  describe('Agent View Projection', () => {
    it('should create agent on spawn event', () => {
      store.emit({
        type: 'spawn',
        source: { agent_id: 'parent' },
        payload: {
          agent_id: 'agent_1',
          session_id: 'sess_123',
          task: 'implement feature',
          parent: 'parent',
        },
      });

      const agent = store.getAgent('agent_1');
      expect(agent).not.toBeNull();
      expect(agent!.id).toBe('agent_1');
      expect(agent!.session_id).toBe('sess_123');
      expect(agent!.task).toBe('implement feature');
      expect(agent!.state).toBe('spawning');
      expect(agent!.parent).toBe('parent');
    });

    it('should update agent state on status started event', () => {
      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'agent_1', session_id: 'sess_1', task: 'work' },
      });

      store.emit({
        type: 'status',
        source: { agent_id: 'agent_1' },
        payload: { status_type: 'started', summary: 'Starting' },
      });

      const agent = store.getAgent('agent_1');
      expect(agent!.state).toBe('running');
      expect(agent!.started_at).toBeGreaterThan(0);
    });

    it('should update agent state on terminate event', () => {
      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'agent_1', session_id: 'sess_1', task: 'work' },
      });

      store.emit({
        type: 'status',
        source: { agent_id: 'agent_1' },
        payload: { status_type: 'started', summary: 'Starting' },
      });

      store.emit({
        type: 'terminate',
        source: { agent_id: 'agent_1' },
        payload: { reason: 'completed' },
      });

      const agent = store.getAgent('agent_1');
      expect(agent!.state).toBe('stopped');
      expect(agent!.stop_reason).toBe('completed');
      expect(agent!.stopped_at).toBeGreaterThan(0);
    });

    it('should compute lineage correctly', () => {
      // Create head manager
      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'head', session_id: 'sess_head', task: 'manage', parent: null },
      });

      // Create child
      store.emit({
        type: 'spawn',
        source: { agent_id: 'head' },
        payload: { agent_id: 'child', session_id: 'sess_child', task: 'work', parent: 'head' },
      });

      // Create grandchild
      store.emit({
        type: 'spawn',
        source: { agent_id: 'child' },
        payload: { agent_id: 'grandchild', session_id: 'sess_grand', task: 'subwork', parent: 'child' },
      });

      const grandchild = store.getAgent('grandchild');
      expect(grandchild!.lineage).toEqual(['head', 'child']);
    });

    it('should list agents with filter', () => {
      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'agent_1', session_id: 'sess_1', task: 'work 1' },
      });
      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'agent_2', session_id: 'sess_2', task: 'work 2' },
      });
      store.emit({
        type: 'status',
        source: { agent_id: 'agent_1' },
        payload: { status_type: 'started', summary: 'Starting' },
      });

      const runningAgents = store.listAgents({ state: 'running' });
      expect(runningAgents.length).toBe(1);
      expect(runningAgents[0].id).toBe('agent_1');

      const spawningAgents = store.listAgents({ state: 'spawning' });
      expect(spawningAgents.length).toBe(1);
      expect(spawningAgents[0].id).toBe('agent_2');
    });
  });

  describe('Task View Projection', () => {
    it('should create task on task created event', () => {
      store.emit({
        type: 'task',
        source: { agent_id: 'manager' },
        payload: {
          task_id: 'task_1',
          action: 'created',
          details: { description: 'Implement auth' },
        },
      });

      const task = store.getTask('task_1');
      expect(task).not.toBeNull();
      expect(task!.id).toBe('task_1');
      expect(task!.description).toBe('Implement auth');
      expect(task!.status).toBe('pending');
      expect(task!.created_by).toBe('manager');
    });

    it('should update task on assigned event', () => {
      store.emit({
        type: 'task',
        source: { agent_id: 'manager' },
        payload: {
          task_id: 'task_1',
          action: 'created',
          details: { description: 'Work' },
        },
      });

      store.emit({
        type: 'task',
        source: { agent_id: 'manager' },
        payload: {
          task_id: 'task_1',
          action: 'assigned',
          details: { agent_id: 'worker_1' },
        },
      });

      const task = store.getTask('task_1');
      expect(task!.status).toBe('assigned');
      expect(task!.assigned_agent).toBe('worker_1');
    });

    it('should update task status', () => {
      store.emit({
        type: 'task',
        source: { agent_id: 'manager' },
        payload: {
          task_id: 'task_1',
          action: 'created',
          details: { description: 'Work' },
        },
      });

      store.emit({
        type: 'task',
        source: { agent_id: 'worker' },
        payload: {
          task_id: 'task_1',
          action: 'status_change',
          details: { status: 'in_progress' },
        },
      });

      const task = store.getTask('task_1');
      expect(task!.status).toBe('in_progress');
      expect(task!.started_at).toBeGreaterThan(0);
    });

    it('should list tasks with filter', () => {
      store.emit({
        type: 'task',
        source: { agent_id: 'manager' },
        payload: { task_id: 'task_1', action: 'created', details: { description: 'Task 1' } },
      });
      store.emit({
        type: 'task',
        source: { agent_id: 'manager' },
        payload: { task_id: 'task_2', action: 'created', details: { description: 'Task 2' } },
      });
      store.emit({
        type: 'task',
        source: {},
        payload: { task_id: 'task_1', action: 'status_change', details: { status: 'in_progress' } },
      });

      const inProgressTasks = store.listTasks({ status: 'in_progress' });
      expect(inProgressTasks.length).toBe(1);
      expect(inProgressTasks[0].id).toBe('task_1');
    });
  });

  describe('Message Queue Projection', () => {
    it('should add message to recipient queue', () => {
      store.emit({
        type: 'message',
        source: { agent_id: 'sender' },
        target: { agent_id: 'recipient' },
        payload: { content: 'Hello there!' },
      });

      const messages = store.getMessages('recipient');
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('Hello there!');
      expect(messages[0].from.agent_id).toBe('sender');
    });

    it('should deliver message to topic subscribers', () => {
      // Subscribe agents to topic
      store.addSubscription('agent_1', { type: 'topic', target: 'updates' });
      store.addSubscription('agent_2', { type: 'topic', target: 'updates' });

      store.emit({
        type: 'message',
        source: { agent_id: 'broadcaster' },
        target: { topic: 'updates' },
        payload: { content: 'Important update' },
      });

      const messages1 = store.getMessages('agent_1');
      const messages2 = store.getMessages('agent_2');

      expect(messages1.length).toBe(1);
      expect(messages2.length).toBe(1);
      expect(messages1[0].content).toBe('Important update');
    });

    it('should truncate large messages', () => {
      const longContent = 'x'.repeat(2000);

      store.emit({
        type: 'message',
        source: { agent_id: 'sender' },
        target: { agent_id: 'recipient' },
        payload: { content: longContent },
      });

      const messages = store.getMessages('recipient');
      expect(messages[0].truncated).toBe(true);
      expect(messages[0].content.length).toBeLessThan(longContent.length);
    });

    it('should retrieve full message content', () => {
      const longContent = 'x'.repeat(2000);

      const event = store.emit({
        type: 'message',
        source: { agent_id: 'sender' },
        target: { agent_id: 'recipient' },
        payload: { content: longContent },
      });

      const fullContent = store.getFullMessage(event.id);
      expect(fullContent).toBe(longContent);
    });
  });

  describe('Subscription Management', () => {
    it('should add and get subscriptions', () => {
      store.addSubscription('agent_1', { type: 'topic', target: 'errors' });
      store.addSubscription('agent_1', { type: 'agent', target: 'agent_1' });

      const subs = store.getSubscriptions('agent_1');
      expect(subs.length).toBe(2);
      expect(subs).toContainEqual({ type: 'topic', target: 'errors' });
      expect(subs).toContainEqual({ type: 'agent', target: 'agent_1' });
    });

    it('should remove subscriptions', () => {
      store.addSubscription('agent_1', { type: 'topic', target: 'errors' });
      store.removeSubscription('agent_1', { type: 'topic', target: 'errors' });

      const subs = store.getSubscriptions('agent_1');
      expect(subs.length).toBe(0);
    });

    it('should get subscribers by subscription', () => {
      store.addSubscription('agent_1', { type: 'topic', target: 'discoveries' });
      store.addSubscription('agent_2', { type: 'topic', target: 'discoveries' });
      store.addSubscription('agent_3', { type: 'topic', target: 'other' });

      const subscribers = store.getSubscribers({ type: 'topic', target: 'discoveries' });
      expect(subscribers).toContain('agent_1');
      expect(subscribers).toContain('agent_2');
      expect(subscribers).not.toContain('agent_3');
    });
  });

  describe('Reactive Updates', () => {
    it('should notify on agent changes', () => {
      const changes: Array<{ agentId: string; state: string | undefined }> = [];

      store.onAgentChange((agentId, agent) => {
        changes.push({ agentId, state: agent?.state });
      });

      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'agent_1', session_id: 'sess_1', task: 'work' },
      });

      expect(changes.length).toBe(1);
      expect(changes[0].agentId).toBe('agent_1');
      expect(changes[0].state).toBe('spawning');
    });

    it('should notify on specific agent changes', () => {
      const changes: string[] = [];

      store.onAgentChange('agent_1', () => {
        changes.push('agent_1 changed');
      });

      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'agent_1', session_id: 'sess_1', task: 'work' },
      });

      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'agent_2', session_id: 'sess_2', task: 'other work' },
      });

      // Only agent_1 changes should be notified
      expect(changes.length).toBe(1);
    });

    it('should notify on task changes', () => {
      const changes: string[] = [];

      store.onTaskChange((taskId) => {
        changes.push(taskId);
      });

      store.emit({
        type: 'task',
        source: { agent_id: 'manager' },
        payload: { task_id: 'task_1', action: 'created', details: { description: 'Work' } },
      });

      expect(changes).toContain('task_1');
    });

    it('should notify on message changes', () => {
      const messages: string[] = [];

      store.onMessageChange('recipient', (agentId, msgs) => {
        messages.push(`${agentId}: ${msgs.length} messages`);
      });

      store.emit({
        type: 'message',
        source: { agent_id: 'sender' },
        target: { agent_id: 'recipient' },
        payload: { content: 'Hello' },
      });

      expect(messages.length).toBe(1);
      expect(messages[0]).toBe('recipient: 1 messages');
    });

    it('should unsubscribe from changes', () => {
      const changes: string[] = [];

      const unsubscribe = store.onAgentChange(() => {
        changes.push('changed');
      });

      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'agent_1', session_id: 'sess_1', task: 'work' },
      });

      unsubscribe();

      store.emit({
        type: 'spawn',
        source: {},
        payload: { agent_id: 'agent_2', session_id: 'sess_2', task: 'more work' },
      });

      // Should only have one change (before unsubscribe)
      expect(changes.length).toBe(1);
    });
  });
});

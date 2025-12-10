/**
 * Event Store module exports
 */

export { createEventStore } from './event-store.js';
export type { EventStore, Unsubscribe, AgentChangeCallback, TaskChangeCallback, MessageCallback } from './event-store.js';
export * from './types/index.js';
export { CURRENT_EVENT_VERSION } from './types/events.js';
export { migrateEvent, needsMigration, getCurrentVersion } from './migrations.js';

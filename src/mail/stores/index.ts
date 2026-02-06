/**
 * EventStore-backed mail store adapters.
 *
 * These implement MAP-compatible store interfaces backed by
 * the EventStore's append-only event log and materialized views.
 */

export * from "./types.js";
export { EventStoreConversationStore } from "./eventstore-conversation-store.js";
export { EventStoreTurnStore } from "./eventstore-turn-store.js";
export { EventStoreThreadStore } from "./eventstore-thread-store.js";
export { EventStoreParticipantStore } from "./eventstore-participant-store.js";

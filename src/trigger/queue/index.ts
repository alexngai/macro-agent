/**
 * System Event Queue
 *
 * Per-agent ephemeral event queue for storing pending system events.
 *
 * @module trigger/queue
 */

export {
  createSystemEventQueue,
  formatQueuedEventsAsSystemMessage,
  formatQueuedTextsAsBlock,
} from "./system-event-queue.js";

export type {
  SystemEventQueue,
  QueuedSystemEvent,
  SessionQueue,
  EnqueueOptions,
  DrainOptions,
} from "./types.js";

/**
 * Mail module — structured conversation tracking for macro-agent.
 *
 * Provides MAP-compatible mail stores backed by the EventStore,
 * and the MailService facade for conversation lifecycle management.
 */

export * from "./stores/index.js";
export {
  createMailService,
  type MailService,
  type MailServiceConfig,
  type CreateConversationOptions,
  type RecordTurnOptions,
  type CloseConversationOptions,
  type JoinConversationOptions,
} from "./mail-service.js";
export {
  createConversationMap,
  type ConversationMap,
} from "./conversation-map.js";
export {
  createTurnRecorder,
  type TurnRecorderDeps,
} from "./turn-recorder.js";

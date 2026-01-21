/**
 * Message Router module exports
 */

// Original types and router (backward compatible)
export * from './types.js';
export * from './message-router.js';

// Enhanced signal types (s-9rld)
export type {
  SignalType,
  SignalPayload,
  SignalPayloadMap,
  WorkerDonePayload,
  TaskDonePayload,
  WorkAssignedPayload,
  MergeRequestPayload,
  MergeCompletePayload,
  LandCompletePayload,
  ConflictDetectedPayload,
  HelpPayload,
  HelpClaimedPayload,
  HandoffPayload,
  StatusPayload,
  HealthCheckPayload,
  HealthCheckTimerPayload,
  GuppViolationPayload,
  PriorityChangePayload,
  ForceTerminateRequestPayload,
  WorkerSpawnedPayload,
  IntegratorDonePayload,
  AgentTimeoutPayload,
  AssignmentExpiredPayload,
} from './signals.js';

export { SIGNALS, ALL_SIGNALS, isValidSignal } from './signals.js';

// Enhanced channel types (s-9rld) - use "Enhanced" prefix to avoid conflicts
export type {
  ChannelType as EnhancedChannelType,
  Channel as EnhancedChannel,
  AgentChannel,
  TaskChannel,
  LineageChannel,
  SubtreeChannel,
  TopicChannel,
  BroadcastChannel,
  RoleChannel,
  MessagePriority,
  DeliveryMode,
  GroupResolution,
} from './channels.js';

export {
  PRIORITY_VALUES,
  comparePriority,
  agentChannel,
  taskChannel,
  topicChannel,
  broadcastChannel,
  roleChannel,
  lineageChannel,
  subtreeChannel,
  parseRoleSyntax,
  isAgentChannel,
  isTaskChannel,
  isTopicChannel,
  isBroadcastChannel,
  isRoleChannel,
  isMulticastChannel,
} from './channels.js';

// Enhanced message types (s-9rld) - use prefixes to avoid conflicts
export type {
  LegacyMessageTarget,
  SignalMessage,
  ContentMessage,
  Message,
  SendSignalRequest,
  SendContentRequest,
  MessageTarget as EnhancedMessageTarget,
  SendMessageRequest as EnhancedSendMessageRequest,
  SentMessage as EnhancedSentMessage,
  ReceivedMessage as EnhancedReceivedMessage,
} from './message-types.js';

export {
  isSignalMessage,
  isContentMessage,
  isSendSignalRequest,
  isSendContentRequest,
  isLegacyTarget,
  isChannelTarget,
  createSignalMessage,
  createContentMessage,
} from './message-types.js';

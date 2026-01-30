/**
 * Message Router module exports
 */

// Original types and router (backward compatible)
export * from "./types.js";
export * from "./message-router.js";

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
  StaleAgentPayload,
  PriorityChangePayload,
  ForceTerminateRequestPayload,
  WorkerSpawnedPayload,
  IntegratorDonePayload,
  AgentTimeoutPayload,
  AssignmentExpiredPayload,
} from "./signals.js";

export { SIGNALS, ALL_SIGNALS, isValidSignal } from "./signals.js";

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
} from "./channels.js";

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
} from "./channels.js";

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
} from "./message-types.js";

export {
  isSignalMessage,
  isContentMessage,
  isSendSignalRequest,
  isSendContentRequest,
  isLegacyTarget,
  isChannelTarget,
  createSignalMessage,
  createContentMessage,
} from "./message-types.js";

// Broadcast channel resolution (Phase 5)
export {
  matchesBroadcastScope,
  getBroadcastRecipients,
  resolveBroadcastTarget,
} from "./broadcast.js";

export type { BroadcastAgentInfo, BroadcastAgentSource } from "./broadcast.js";

// Role channel resolution (Phase 5)
export {
  matchesRole,
  getSubtreeIds,
  resolveRoleTarget,
  getAgentsByRole,
} from "./role-resolver.js";

export type { RoleAgentInfo, RoleAgentSource } from "./role-resolver.js";

// Priority-based wake decisions (Phase 5)
export {
  determineWakeAction,
  getWakeDecision,
  getWakeDecisionWithHint,
  shouldWakeAgent,
  shouldInterruptAgent,
  comparePriority as compareMessagePriority,
  PRIORITY_VALUES as MESSAGE_PRIORITY_VALUES,
} from "./wake.js";

export type { SessionChecker, WakeDecision, WakeOptions } from "./wake.js";

// Wake handler type from message router
export type { WakeHandler } from "./message-router.js";

// Address resolver for hierarchical addresses (MAP Phase 2)
export {
  resolveParent,
  resolveChildren,
  resolveAncestors,
  resolveDescendants,
  resolveSiblings,
  resolveHierarchicalAddress,
  hasRecipients,
} from "./address-resolver.js";

export type {
  HierarchyAgentInfo,
  HierarchySource,
  ResolvedAddress,
} from "./address-resolver.js";

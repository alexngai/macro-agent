/**
 * Enhanced Message Types
 *
 * Message types for agent communication with signal support,
 * priority, and enhanced channel targeting.
 *
 * @module router/message-types
 * @see s-9rld In-Flight Steering spec
 */

import type { AgentId, TaskId, EventId, Timestamp } from "../store/types/index.js";
import type { SignalType, SignalPayload, SignalPayloadMap } from "./signals.js";
import type {
  Channel,
  MessagePriority,
  DeliveryMode,
  GroupResolution,
} from "./channels.js";

// =============================================================================
// Message Sender/Target (backward compatible)
// =============================================================================

/**
 * Message sender identification (backward compatible)
 */
export interface MessageSender {
  agent_id: AgentId;
  task_id?: TaskId;
}

/**
 * Legacy message target (backward compatible)
 */
export interface LegacyMessageTarget {
  agent_id?: AgentId;
  task_id?: TaskId;
  topic?: string;
}

// =============================================================================
// Enhanced Message Types
// =============================================================================

/**
 * Enhanced message target with channel support
 */
export type MessageTarget = LegacyMessageTarget | Channel;

/**
 * Signal message - typed message with specific signal and payload
 */
export interface SignalMessage<T extends SignalType = SignalType> {
  /** Message ID */
  id?: EventId;

  /** Sender information */
  from: MessageSender;

  /** Target channel or legacy target */
  to: MessageTarget;

  /** Signal type */
  signal: T;

  /** Signal-specific payload */
  payload: SignalPayload<T>;

  /** Message priority (default: normal) */
  priority?: MessagePriority;

  /** Delivery mode (default: queue) */
  deliveryMode?: DeliveryMode;

  /** Correlation ID for threading/reply tracking */
  correlation_id?: string;

  /** Timestamp */
  timestamp?: Timestamp;
}

/**
 * Content message - unstructured text message (backward compatible)
 */
export interface ContentMessage {
  /** Message ID */
  id?: EventId;

  /** Sender information */
  from: MessageSender;

  /** Target channel or legacy target */
  to: MessageTarget;

  /** Message content */
  content: string;

  /** Message priority (default: normal) */
  priority?: MessagePriority;

  /** Delivery mode (default: queue) */
  deliveryMode?: DeliveryMode;

  /** Correlation ID for threading/reply tracking */
  correlation_id?: string;

  /** Timestamp */
  timestamp?: Timestamp;
}

/**
 * Union of all message types
 */
export type Message = SignalMessage | ContentMessage;

// =============================================================================
// Send Message Request
// =============================================================================

/**
 * Request to send a signal message
 */
export interface SendSignalRequest<T extends SignalType = SignalType> {
  from: MessageSender;
  to: MessageTarget;
  signal: T;
  payload: SignalPayload<T>;
  priority?: MessagePriority;
  deliveryMode?: DeliveryMode;
  correlation_id?: string;
  groupResolution?: GroupResolution;
}

/**
 * Request to send a content message (backward compatible)
 */
export interface SendContentRequest {
  from: MessageSender;
  to: MessageTarget;
  content: string;
  priority?: MessagePriority;
  deliveryMode?: DeliveryMode;
  correlation_id?: string;
  groupResolution?: GroupResolution;
}

/**
 * Union of send requests
 */
export type SendMessageRequest = SendSignalRequest | SendContentRequest;

// =============================================================================
// Sent/Received Messages
// =============================================================================

/**
 * Sent message result
 */
export interface SentMessage {
  id: EventId;
  from: MessageSender;
  to: MessageTarget;
  signal?: SignalType;
  payload?: SignalPayloadMap[keyof SignalPayloadMap];
  content?: string;
  priority: MessagePriority;
  timestamp: Timestamp;
  correlation_id?: string;
  /** Number of recipients (for multicast) */
  recipientCount?: number;
}

/**
 * Received message in queue
 */
export interface ReceivedMessage {
  id: EventId;
  from: MessageSender;
  signal?: SignalType;
  payload?: SignalPayloadMap[keyof SignalPayloadMap];
  content?: string;
  priority: MessagePriority;
  timestamp: Timestamp;
  truncated: boolean;
  correlation_id?: string;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a message is a signal message
 */
export function isSignalMessage(
  message: Message | SendMessageRequest
): message is SignalMessage {
  return "signal" in message && "payload" in message;
}

/**
 * Check if a message is a content message
 */
export function isContentMessage(
  message: Message | SendMessageRequest
): message is ContentMessage {
  return "content" in message && !("signal" in message);
}

/**
 * Check if a request is a send signal request
 */
export function isSendSignalRequest(
  request: SendMessageRequest
): request is SendSignalRequest {
  return "signal" in request && "payload" in request;
}

/**
 * Check if a request is a send content request
 */
export function isSendContentRequest(
  request: SendMessageRequest
): request is SendContentRequest {
  return "content" in request && !("signal" in request);
}

/**
 * Check if target is a legacy target
 */
export function isLegacyTarget(
  target: MessageTarget
): target is LegacyMessageTarget {
  return !("type" in target);
}

/**
 * Check if target is a channel
 */
export function isChannelTarget(target: MessageTarget): target is Channel {
  return "type" in target;
}

// =============================================================================
// Message Builder Helpers
// =============================================================================

/**
 * Create a signal message
 */
export function createSignalMessage<T extends SignalType>(
  signal: T,
  payload: SignalPayload<T>,
  options: {
    from: MessageSender;
    to: MessageTarget;
    priority?: MessagePriority;
    deliveryMode?: DeliveryMode;
    correlation_id?: string;
  }
): SignalMessage<T> {
  return {
    signal,
    payload,
    from: options.from,
    to: options.to,
    priority: options.priority,
    deliveryMode: options.deliveryMode,
    correlation_id: options.correlation_id,
  };
}

/**
 * Create a content message
 */
export function createContentMessage(
  content: string,
  options: {
    from: MessageSender;
    to: MessageTarget;
    priority?: MessagePriority;
    deliveryMode?: DeliveryMode;
    correlation_id?: string;
  }
): ContentMessage {
  return {
    content,
    from: options.from,
    to: options.to,
    priority: options.priority,
    deliveryMode: options.deliveryMode,
    correlation_id: options.correlation_id,
  };
}

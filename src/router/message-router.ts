/**
 * MessageRouter - High-level message routing service
 *
 * Provides message routing between agents with support for:
 * - Direct agent-to-agent messaging
 * - Task-based routing (to assigned agent)
 * - Topic-based pub/sub
 * - Lineage routing (ancestors to descendants)
 * - Subtree routing (status events to parent subscribers)
 * - Message acknowledgment
 */

import { nanoid } from "nanoid";
import type { EventStore } from "../store/event-store.js";
import type {
  AgentId,
  TaskId,
  EventId,
  Timestamp,
} from "../store/types/index.js";
import type {
  MessageTarget,
  MessageSender,
  SendMessageRequest,
  SentMessage,
  ReceivedMessage,
  GetMessagesOptions,
  Channel,
  ChannelType,
  DefaultSubscriptionOptions,
  EmitStatusRequest,
  StatusNotification,
  TruncationConfig,
} from "./types.js";
import { RoutingError, DEFAULT_TRUNCATION_CONFIG } from "./types.js";

/**
 * MessageRouter interface
 */
export interface MessageRouter {
  // ─────────────────────────────────────────────────────────────────
  // Message Operations
  // ─────────────────────────────────────────────────────────────────

  /**
   * Send a message to target(s).
   * Routes based on target type: agent_id, task_id, or topic.
   * @throws RoutingError if target cannot be resolved
   */
  send(request: SendMessageRequest): SentMessage;

  /**
   * Emit a status event from an agent.
   * Automatically routes to subtree subscribers (parents watching this agent).
   */
  emitStatus(request: EmitStatusRequest): void;

  // ─────────────────────────────────────────────────────────────────
  // Message Retrieval
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get pending messages for an agent.
   * By default excludes acknowledged messages.
   */
  getMessages(
    agentId: AgentId,
    options?: GetMessagesOptions
  ): ReceivedMessage[];

  /**
   * Get full content of a message (if it was truncated).
   */
  getFullMessage(messageId: EventId): string | null;

  // ─────────────────────────────────────────────────────────────────
  // Message Acknowledgment
  // ─────────────────────────────────────────────────────────────────

  /**
   * Acknowledge a single message as read.
   * Acknowledged messages are kept but excluded from getMessages().
   */
  acknowledgeMessage(agentId: AgentId, messageId: EventId): void;

  /**
   * Acknowledge multiple messages as read.
   */
  acknowledgeMessages(agentId: AgentId, messageIds: EventId[]): void;

  // ─────────────────────────────────────────────────────────────────
  // Subscription Management
  // ─────────────────────────────────────────────────────────────────

  /**
   * Subscribe an agent to a channel.
   * Channel types: agent, task, lineage, subtree, topic, broadcast
   */
  subscribe(agentId: AgentId, channel: Channel): void;

  /**
   * Unsubscribe an agent from a channel.
   */
  unsubscribe(agentId: AgentId, channel: Channel): void;

  /**
   * Get all channels an agent is subscribed to.
   */
  getSubscriptions(agentId: AgentId): Channel[];

  /**
   * Get all agents subscribed to a channel.
   */
  getSubscribers(channel: Channel): AgentId[];

  // ─────────────────────────────────────────────────────────────────
  // Setup Helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Set up default subscriptions for a newly spawned agent.
   * - Subscribes agent to its own agent channel
   * - Subscribes agent to lineage (receives messages from ancestors)
   * - Subscribes agent to task channel if task_id provided
   * - Optionally subscribes parent to agent's subtree
   */
  setupDefaultSubscriptions(options: DefaultSubscriptionOptions): void;
}

/**
 * MessageRouter configuration
 */
export interface MessageRouterConfig {
  truncation?: TruncationConfig;
}

/**
 * Create a MessageRouter instance
 */
export function createMessageRouter(
  eventStore: EventStore,
  config: MessageRouterConfig = {}
): MessageRouter {
  const truncationConfig = config.truncation ?? DEFAULT_TRUNCATION_CONFIG;

  // Track acknowledged messages: Map<agentId, Set<messageId>>
  const acknowledgedMessages = new Map<AgentId, Set<EventId>>();

  // ─────────────────────────────────────────────────────────────────
  // Message Operations
  // ─────────────────────────────────────────────────────────────────

  function send(request: SendMessageRequest): SentMessage {
    const { from, to, content, correlation_id } = request;

    // Validate target
    if (!to.agent_id && !to.task_id && !to.topic) {
      throw new RoutingError("No target specified", "NO_TARGET", to);
    }

    // Resolve recipients and build effective target
    const resolvedTarget = resolveTarget(to);

    // Emit message event with resolved target
    const event = eventStore.emit({
      type: "message",
      source: {
        agent_id: from.agent_id,
        task_id: from.task_id,
      },
      target: resolvedTarget,
      payload: {
        content,
        correlation_id,
        // Keep original target info for context
        original_target: to.task_id ? { task_id: to.task_id } : undefined,
      },
    });

    // Route to lineage subscribers if this is from an ancestor
    // (children with lineage subscription to themselves receive messages from ancestors)
    routeToLineageSubscribers(
      from.agent_id,
      event.id,
      from,
      content,
      event.timestamp,
      correlation_id
    );

    return {
      id: event.id,
      from,
      to,
      content,
      timestamp: event.timestamp,
      correlation_id,
    };
  }

  function emitStatus(request: EmitStatusRequest): void {
    const { from, status_type, summary, details } = request;

    // Emit status event to event store
    const event = eventStore.emit({
      type: "status",
      source: {
        agent_id: from.agent_id,
        task_id: from.task_id,
      },
      payload: {
        status_type,
        summary,
        details,
      },
    });

    // Route to subtree subscribers
    routeStatusToSubtreeSubscribers(from.agent_id, {
      agent_id: from.agent_id,
      task_id: from.task_id,
      status_type,
      summary,
      details,
      timestamp: event.timestamp,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Message Retrieval
  // ─────────────────────────────────────────────────────────────────

  function getMessages(
    agentId: AgentId,
    options?: GetMessagesOptions
  ): ReceivedMessage[] {
    const limit = options?.limit;
    const includeAcknowledged = options?.includeAcknowledged ?? false;

    // Get all messages from event store
    const allMessages = eventStore.getMessages(agentId, undefined);

    // Filter out acknowledged unless requested
    const acknowledged = acknowledgedMessages.get(agentId) ?? new Set();
    const filtered = includeAcknowledged
      ? allMessages
      : allMessages.filter((msg) => !acknowledged.has(msg.id));

    // Apply limit
    const limited = limit ? filtered.slice(0, limit) : filtered;

    return limited;
  }

  function getFullMessage(messageId: EventId): string | null {
    return eventStore.getFullMessage(messageId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Message Acknowledgment
  // ─────────────────────────────────────────────────────────────────

  function acknowledgeMessage(agentId: AgentId, messageId: EventId): void {
    if (!acknowledgedMessages.has(agentId)) {
      acknowledgedMessages.set(agentId, new Set());
    }
    acknowledgedMessages.get(agentId)!.add(messageId);
  }

  function acknowledgeMessages(agentId: AgentId, messageIds: EventId[]): void {
    if (!acknowledgedMessages.has(agentId)) {
      acknowledgedMessages.set(agentId, new Set());
    }
    const set = acknowledgedMessages.get(agentId)!;
    for (const id of messageIds) {
      set.add(id);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Subscription Management
  // ─────────────────────────────────────────────────────────────────

  function subscribe(agentId: AgentId, channel: Channel): void {
    eventStore.addSubscription(agentId, {
      type: channel.type,
      target: channel.target,
    });
  }

  function unsubscribe(agentId: AgentId, channel: Channel): void {
    eventStore.removeSubscription(agentId, {
      type: channel.type,
      target: channel.target,
    });
  }

  function getSubscriptions(agentId: AgentId): Channel[] {
    const subs = eventStore.getSubscriptions(agentId);
    return subs.map((s) => ({
      type: s.type as ChannelType,
      target: s.target,
    }));
  }

  function getSubscribers(channel: Channel): AgentId[] {
    return eventStore.getSubscribers({
      type: channel.type,
      target: channel.target,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Setup Helpers
  // ─────────────────────────────────────────────────────────────────

  function setupDefaultSubscriptions(
    options: DefaultSubscriptionOptions
  ): void {
    const {
      agent_id,
      parent_id,
      task_id,
      subscribe_parent = true,
      additional_topics = [],
    } = options;

    // 1. Subscribe agent to its own direct channel
    subscribe(agent_id, { type: "agent", target: agent_id });

    // 2. Subscribe agent to lineage (receives messages from ancestors)
    subscribe(agent_id, { type: "lineage", target: agent_id });

    // 3. Subscribe agent to task channel if task_id provided
    if (task_id) {
      subscribe(agent_id, { type: "task", target: task_id });
    }

    // 4. Subscribe parent to agent's subtree if requested
    if (parent_id && subscribe_parent) {
      subscribe(parent_id, { type: "subtree", target: agent_id });
    }

    // 5. Subscribe to additional topics
    for (const topic of additional_topics) {
      subscribe(agent_id, { type: "topic", target: topic });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Resolve message target to event target.
   * Converts task_id to assigned agent_id.
   * Returns target suitable for EventStore emission.
   */
  function resolveTarget(target: MessageTarget): {
    agent_id?: string;
    topic?: string;
  } {
    const resolved: { agent_id?: string; topic?: string } = {};

    // Direct agent target
    if (target.agent_id) {
      const agent = eventStore.getAgent(target.agent_id);
      if (!agent) {
        throw new RoutingError(
          `Agent not found: ${target.agent_id}`,
          "AGENT_NOT_FOUND",
          target
        );
      }
      resolved.agent_id = target.agent_id;
    }

    // Task target - resolve to assigned agent
    if (target.task_id) {
      const task = eventStore.getTask(target.task_id);
      if (!task) {
        throw new RoutingError(
          `Task not found: ${target.task_id}`,
          "TASK_NOT_FOUND",
          target
        );
      }
      if (!task.assigned_agent) {
        // TODO: When AgentManager is available, implement:
        // 1. Find last agent that worked on this task
        // 2. Wake that agent session
        // 3. If unavailable, spawn new agent with task history
        throw new RoutingError(
          `Task ${target.task_id} has no assigned agent`,
          "TASK_UNASSIGNED",
          target
        );
      }
      // Route to the assigned agent
      resolved.agent_id = task.assigned_agent;
    }

    // Topic target - pass through for EventStore to handle
    if (target.topic) {
      resolved.topic = target.topic;
    }

    return resolved;
  }

  /**
   * Route message to lineage subscribers.
   * When an agent sends a message, children who have subscribed to lineage
   * will receive the message.
   */
  function routeToLineageSubscribers(
    senderAgentId: AgentId,
    messageId: EventId,
    from: MessageSender,
    content: string,
    timestamp: Timestamp,
    correlation_id?: string
  ): void {
    // Find all agents that have this sender in their lineage
    const allAgents = eventStore.listAgents();

    for (const agent of allAgents) {
      // Skip sender
      if (agent.id === senderAgentId) continue;

      // Check if sender is in this agent's lineage (is an ancestor)
      if (agent.lineage.includes(senderAgentId)) {
        // Check if agent has lineage subscription to themselves
        const subs = eventStore.getSubscriptions(agent.id);
        const hasLineageSub = subs.some(
          (s) => s.type === "lineage" && s.target === agent.id
        );

        if (hasLineageSub) {
          // Route message to this descendant
          // This is done by emitting a separate message event to the descendant
          eventStore.emit({
            type: "message",
            source: {
              agent_id: from.agent_id,
              task_id: from.task_id,
            },
            target: {
              agent_id: agent.id,
            },
            payload: {
              content: `[Lineage] ${content}`,
              correlation_id,
              original_message_id: messageId,
              via: "lineage",
            },
          });
        }
      }
    }
  }

  /**
   * Route status event to subtree subscribers.
   * Parents who have subscribed to an agent's subtree receive status notifications.
   */
  function routeStatusToSubtreeSubscribers(
    agentId: AgentId,
    status: StatusNotification
  ): void {
    const agent = eventStore.getAgent(agentId);
    if (!agent) return;

    // Find all agents with subtree subscription that includes this agent
    // This includes:
    // 1. Direct subtree subscription to this agent
    // 2. Subtree subscription to any ancestor of this agent

    const agentsToNotify = new Set<AgentId>();

    // Check direct subtree subscribers
    const directSubscribers = eventStore.getSubscribers({
      type: "subtree",
      target: agentId,
    });
    for (const sub of directSubscribers) {
      agentsToNotify.add(sub);
    }

    // Check subtree subscribers of ancestors (they also want events from descendants)
    for (const ancestorId of agent.lineage) {
      const ancestorSubscribers = eventStore.getSubscribers({
        type: "subtree",
        target: ancestorId,
      });
      // Only add if the subscriber is an ancestor of the current agent
      // (meaning they subscribed to one of our ancestors' subtrees)
      for (const sub of ancestorSubscribers) {
        // Check if sub is an ancestor of agentId
        if (agent.lineage.includes(sub)) {
          agentsToNotify.add(sub);
        }
      }
    }

    // Send status notification to each subscriber
    for (const subscriberId of agentsToNotify) {
      // Skip self-notification
      if (subscriberId === agentId) continue;

      const statusContent = JSON.stringify({
        type: "status_notification",
        ...status,
      });

      eventStore.emit({
        type: "message",
        source: {
          agent_id: agentId,
        },
        target: {
          agent_id: subscriberId,
        },
        payload: {
          content: statusContent,
          via: "subtree",
        },
      });
    }
  }

  return {
    send,
    emitStatus,
    getMessages,
    getFullMessage,
    acknowledgeMessage,
    acknowledgeMessages,
    subscribe,
    unsubscribe,
    getSubscriptions,
    getSubscribers,
    setupDefaultSubscriptions,
  };
}

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
  AgentSpawner,
  AgentSessionChecker,
  MessagePriority,
  WakeAction,
} from "./types.js";
import { RoutingError, DEFAULT_TRUNCATION_CONFIG } from "./types.js";
import {
  resolveBroadcastTarget,
  type BroadcastAgentSource,
} from "./broadcast.js";
import {
  resolveRoleTarget,
  type RoleAgentSource,
} from "./role-resolver.js";
import {
  getWakeDecision,
  type SessionChecker,
  type WakeDecision,
} from "./wake.js";

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
   * If the target is a task with no assigned agent, may spawn a new agent.
   * @throws RoutingError if target cannot be resolved
   */
  send(request: SendMessageRequest): Promise<SentMessage>;

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
 * Callback invoked when a message determines a wake action
 */
export type WakeHandler = (
  agentId: AgentId,
  decision: WakeDecision,
  messageId: EventId
) => void;

/**
 * MessageRouter configuration
 */
export interface MessageRouterConfig {
  truncation?: TruncationConfig;
  /**
   * Optional callback to spawn an agent for a task.
   * Used when routing to a task with no assigned agent.
   */
  agentSpawner?: AgentSpawner;
  /**
   * Optional callback to check if an agent has an active session.
   * Used to determine if a previous agent can be reused.
   */
  agentSessionChecker?: AgentSessionChecker;
  /**
   * Optional session checker for priority-based wake decisions.
   * Provides information about agent session state.
   */
  sessionChecker?: SessionChecker;
  /**
   * Optional callback invoked when a message triggers a wake action.
   * Used to actually wake/inject/interrupt agents.
   */
  wakeHandler?: WakeHandler;
}

/**
 * Create a MessageRouter instance
 */
export function createMessageRouter(
  eventStore: EventStore,
  config: MessageRouterConfig = {}
): MessageRouter {
  const truncationConfig = config.truncation ?? DEFAULT_TRUNCATION_CONFIG;
  const agentSpawner = config.agentSpawner;
  const agentSessionChecker = config.agentSessionChecker;
  const sessionChecker = config.sessionChecker;
  const wakeHandler = config.wakeHandler;

  // Track acknowledged messages: Map<agentId, Set<messageId>>
  const acknowledgedMessages = new Map<AgentId, Set<EventId>>();

  // ─────────────────────────────────────────────────────────────────
  // Message Operations
  // ─────────────────────────────────────────────────────────────────

  async function send(request: SendMessageRequest): Promise<SentMessage> {
    const { from, to, content, correlation_id, priority = "normal" } = request;

    // Validate target - at least one target type must be specified
    if (!to.agent_id && !to.task_id && !to.topic && !to.broadcast && !to.role) {
      throw new RoutingError("No target specified", "NO_TARGET", to);
    }

    // ─────────────────────────────────────────────────────────────────
    // Handle multicast targets (broadcast, role)
    // ─────────────────────────────────────────────────────────────────

    if (to.broadcast || to.role) {
      return sendMulticast(request, priority);
    }

    // ─────────────────────────────────────────────────────────────────
    // Handle unicast targets (agent_id, task_id, topic)
    // ─────────────────────────────────────────────────────────────────

    // Resolve recipients and build effective target
    const resolvedTarget = await resolveTarget(to);

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
        priority,
        // Keep original target info for context
        original_target: to.task_id ? { task_id: to.task_id } : undefined,
      },
    });

    // Handle priority-based wake for direct agent target
    if (resolvedTarget.agent_id && sessionChecker && wakeHandler) {
      const decision = getWakeDecision(resolvedTarget.agent_id, priority, sessionChecker);
      if (decision.shouldWake || decision.shouldInterrupt) {
        wakeHandler(resolvedTarget.agent_id, decision, event.id);
      }
    }

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

  /**
   * Send a message to multiple recipients (broadcast or role channels).
   * Fans out to all matching agents at send time.
   */
  async function sendMulticast(
    request: SendMessageRequest,
    priority: MessagePriority
  ): Promise<SentMessage> {
    const { from, to, content, correlation_id } = request;

    // Create agent source adapter for resolution functions
    const agentSource: BroadcastAgentSource & RoleAgentSource = {
      listAgents: () => eventStore.listAgents(),
      getAgent: (id) => eventStore.getAgent(id),
    };

    // Resolve recipients based on target type
    let recipientIds: AgentId[] = [];

    if (to.broadcast) {
      recipientIds = resolveBroadcastTarget(agentSource, to.broadcast);
    } else if (to.role) {
      recipientIds = resolveRoleTarget(agentSource, to.role);
    }

    // Emit a single message event with multicast metadata
    const event = eventStore.emit({
      type: "message",
      source: {
        agent_id: from.agent_id,
        task_id: from.task_id,
      },
      target: {
        // For multicast, we emit to each recipient individually
        // The original multicast info is preserved in payload
      },
      payload: {
        content,
        correlation_id,
        priority,
        multicast: {
          type: to.broadcast ? "broadcast" : "role",
          scope: to.broadcast?.scope,
          role: to.role?.role,
          coordinatorId: to.role?.coordinatorId,
          recipientCount: recipientIds.length,
        },
      },
    });

    // Fan out: emit individual message events to each recipient
    for (const recipientId of recipientIds) {
      eventStore.emit({
        type: "message",
        source: {
          agent_id: from.agent_id,
          task_id: from.task_id,
        },
        target: {
          agent_id: recipientId,
        },
        payload: {
          content,
          correlation_id,
          priority,
          via: to.broadcast ? "broadcast" : "role",
          original_message_id: event.id,
        },
      });

      // Handle priority-based wake for each recipient
      if (sessionChecker && wakeHandler) {
        const decision = getWakeDecision(recipientId, priority, sessionChecker);
        if (decision.shouldWake || decision.shouldInterrupt) {
          wakeHandler(recipientId, decision, event.id);
        }
      }
    }

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
      role,
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

    // 6. Auto-subscribe to role channel if role is provided (Tier 1: Gastown model)
    if (role) {
      subscribe(agent_id, { type: "role", target: role });
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
  async function resolveTarget(target: MessageTarget): Promise<{
    agent_id?: string;
    topic?: string;
  }> {
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
        // Try to find or spawn an agent for this task
        const agentId = await resolveOrSpawnAgentForTask(task);
        resolved.agent_id = agentId;
      } else {
        // Route to the assigned agent
        resolved.agent_id = task.assigned_agent;
      }
    }

    // Topic target - pass through for EventStore to handle
    if (target.topic) {
      resolved.topic = target.topic;
    }

    return resolved;
  }

  /**
   * Resolve or spawn an agent for an unassigned task.
   * 1. Check if last assigned agent is still running → use it
   * 2. Otherwise, spawn new agent with task description
   * 3. The new agent gets assigned to the task by the spawner
   */
  async function resolveOrSpawnAgentForTask(task: {
    id: TaskId;
    description: string;
    agent_history?: Array<{ agent_id: AgentId }>;
  }): Promise<AgentId> {
    // 1. Check if last assigned agent from history is still running
    if (task.agent_history && task.agent_history.length > 0) {
      const lastEntry = task.agent_history[task.agent_history.length - 1];
      const lastAgentId = lastEntry.agent_id;

      // Check if agent exists and has an active session
      const lastAgent = eventStore.getAgent(lastAgentId);
      if (lastAgent && lastAgent.state === "running") {
        // Verify with session checker if available
        if (!agentSessionChecker || agentSessionChecker(lastAgentId)) {
          return lastAgentId;
        }
      }
    }

    // 2. No running previous agent - spawn a new one
    if (!agentSpawner) {
      throw new RoutingError(
        `Task ${task.id} has no assigned agent and no agent spawner configured`,
        "TASK_UNASSIGNED",
        { task_id: task.id }
      );
    }

    try {
      const result = await agentSpawner(task.id, task.description);
      return result.agent_id;
    } catch (error) {
      throw new RoutingError(
        `Failed to spawn agent for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        "SPAWN_FAILED",
        { task_id: task.id }
      );
    }
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

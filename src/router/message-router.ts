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
  SendToAddressRequest,
  AddressSendResult,
  Address,
} from "./types.js";
import { RoutingError, AddressRoutingError, DEFAULT_TRUNCATION_CONFIG } from "./types.js";
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
  getWakeDecisionWithHint,
  type SessionChecker,
  type WakeDecision,
} from "./wake.js";
import {
  isAgentAddress,
  isAgentsAddress,
  isScopeAddress,
  isRoleAddress,
  isTaskAddress,
  isBroadcastAddress,
  isHierarchicalAddress,
  isFederatedAddress,
  describeAddress,
} from "../map/types.js";
import type { FederationHandler } from "../map/federation/types.js";
import { getSystemFromAddress } from "../map/federation/federation-handler.js";
import {
  addressToChannel,
  isLegacyCompatible,
  getLegacyIncompatibilities,
} from "../map/utils/address-translation.js";
import {
  resolveHierarchicalAddress,
  type HierarchySource,
} from "./address-resolver.js";

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
   * Send a message using MAP Address-based routing.
   *
   * This is the new MAP-native method that accepts Address types directly.
   * It supports all legacy-compatible addresses and will throw for
   * hierarchical addresses until full resolution is implemented.
   *
   * @param request - The send request with MAP Address
   * @returns Result with delivery confirmation
   * @throws AddressRoutingError if address cannot be resolved
   */
  sendToAddress(request: SendToAddressRequest): Promise<AddressSendResult>;

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
  /**
   * Optional federation handler for cross-system messaging.
   * Required when sending to federated addresses.
   */
  federationHandler?: FederationHandler;
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
  const federationHandler = config.federationHandler;

  // Track acknowledged messages: Map<agentId, Set<messageId>>
  const acknowledgedMessages = new Map<AgentId, Set<EventId>>();

  // Deprecation warning flags (emit once per session)
  let sendDeprecationWarned = false;

  // ─────────────────────────────────────────────────────────────────
  // Message Operations
  // ─────────────────────────────────────────────────────────────────

  async function send(request: SendMessageRequest): Promise<SentMessage> {
    // Emit deprecation warning once per session
    if (!sendDeprecationWarned) {
      sendDeprecationWarned = true;
      console.warn(
        "[macro-agent] DEPRECATION WARNING: send() with channel-based MessageTarget is deprecated. " +
          "Use sendToAddress() with MAP Address type instead. " +
          "See MAP Integration spec (s-5qir) for migration guide."
      );
    }

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

  /**
   * Send a message using MAP Address-based routing.
   * This is the new MAP-native method.
   */
  async function sendToAddress(
    request: SendToAddressRequest
  ): Promise<AddressSendResult> {
    const { from, to, content, options = {} } = request;
    const { priority = "normal", delivery, correlationId } = options;

    // Handle hierarchical addresses using the resolver
    if (isHierarchicalAddress(to)) {
      return sendToHierarchicalAddress(from, to, content, options);
    }

    // Handle multi-agent addresses (not legacy compatible, handle directly)
    if (isAgentsAddress(to)) {
      return sendToMultipleAgents(from, to, content, options);
    }

    // Handle federated addresses (cross-system routing)
    if (isFederatedAddress(to)) {
      if (!federationHandler) {
        throw new AddressRoutingError(
          "Federation not configured for cross-system messaging",
          "FEDERATION_NOT_AVAILABLE",
          to
        );
      }

      const systemId = getSystemFromAddress(to);
      if (!federationHandler.isConnected(systemId)) {
        throw new AddressRoutingError(
          `Not connected to federated system: ${systemId}`,
          "FEDERATION_NOT_AVAILABLE",
          to,
          { systemId }
        );
      }

      // Send via federation handler
      await federationHandler.sendMessage(systemId, {
        type: "map/send",
        from,
        to,
        content,
        options,
      });

      // Return result (no delivery confirmation for federated messages)
      return {
        id: `fed-${nanoid()}` as EventId,
        from,
        to,
        content,
        timestamp: Date.now() as Timestamp,
        delivered: [], // Cannot confirm delivery for federated messages
        correlationId,
      };
    }

    // Check if this is a legacy-compatible address
    if (!isLegacyCompatible(to)) {
      throw new AddressRoutingError(
        `Address type not supported: ${describeAddress(to)}`,
        "ADDRESS_NOT_SUPPORTED",
        to
      );
    }

    // Translate Address to legacy format and delegate to existing routing
    const delivered: AgentId[] = [];

    // Handle different address types
    if (isAgentAddress(to)) {
      // Direct agent address
      const agent = eventStore.getAgent(to.agent);
      if (!agent) {
        throw new AddressRoutingError(
          `Agent not found: ${to.agent}`,
          "AGENT_NOT_FOUND",
          to
        );
      }

      const event = eventStore.emit({
        type: "message",
        source: { agent_id: from },
        target: {
          agent_id: to.agent,
          address: to,
          delivered: [to.agent],
        },
        payload: {
          content,
          correlation_id: correlationId,
          priority,
          delivery_hint: delivery,
        },
      });

      // Handle wake decision
      if (sessionChecker && wakeHandler) {
        const decision = getWakeDecisionWithHint(
          to.agent,
          { priority: priority as MessagePriority, deliveryHint: delivery as import("../map/types.js").DeliveryHint | undefined },
          sessionChecker
        );
        if (decision.shouldWake || decision.shouldInterrupt) {
          wakeHandler(to.agent, decision, event.id);
        }
      }

      delivered.push(to.agent);

      return {
        id: event.id,
        from,
        to,
        content,
        timestamp: event.timestamp,
        delivered,
        correlationId,
      };
    }

    if (isTaskAddress(to)) {
      // Task address - resolve to assigned agent
      const task = eventStore.getTask(to.task);
      if (!task) {
        throw new AddressRoutingError(
          `Task not found: ${to.task}`,
          "TASK_NOT_FOUND",
          to
        );
      }

      let targetAgentId: AgentId;
      if (!task.assigned_agent) {
        // Try to spawn an agent for unassigned task
        if (!agentSpawner) {
          throw new AddressRoutingError(
            `Task ${to.task} has no assigned agent`,
            "TASK_UNASSIGNED",
            to
          );
        }
        const result = await agentSpawner(to.task, task.description);
        targetAgentId = result.agent_id;
      } else {
        targetAgentId = task.assigned_agent;
      }

      const event = eventStore.emit({
        type: "message",
        source: { agent_id: from },
        target: {
          agent_id: targetAgentId,
          address: to,
          delivered: [targetAgentId],
        },
        payload: {
          content,
          correlation_id: correlationId,
          priority,
          delivery_hint: delivery,
          original_target: { task: to.task },
        },
      });

      // Handle wake decision
      if (sessionChecker && wakeHandler) {
        const decision = getWakeDecisionWithHint(
          targetAgentId,
          { priority: priority as MessagePriority, deliveryHint: delivery as import("../map/types.js").DeliveryHint | undefined },
          sessionChecker
        );
        if (decision.shouldWake || decision.shouldInterrupt) {
          wakeHandler(targetAgentId, decision, event.id);
        }
      }

      delivered.push(targetAgentId);

      return {
        id: event.id,
        from,
        to,
        content,
        timestamp: event.timestamp,
        delivered,
        correlationId,
      };
    }

    if (isScopeAddress(to)) {
      // Scope address - route to topic subscribers
      const subscribers = eventStore.getSubscribers({
        type: "topic",
        target: to.scope,
      });

      if (subscribers.length === 0) {
        throw new AddressRoutingError(
          `Scope has no subscribers: ${to.scope}`,
          "NO_RECIPIENTS",
          to
        );
      }

      const event = eventStore.emit({
        type: "message",
        source: { agent_id: from },
        target: {
          topic: to.scope,
          address: to,
          delivered: subscribers,
        },
        payload: {
          content,
          correlation_id: correlationId,
          priority,
          delivery_hint: delivery,
        },
      });

      // Fan out to each subscriber
      for (const subscriberId of subscribers) {
        eventStore.emit({
          type: "message",
          source: { agent_id: from },
          target: {
            agent_id: subscriberId,
            address: { agent: subscriberId },
          },
          payload: {
            content,
            correlation_id: correlationId,
            priority,
            delivery_hint: delivery,
            via: "scope",
            original_message_id: event.id,
          },
        });

        // Handle wake decision for each recipient
        if (sessionChecker && wakeHandler) {
          const decision = getWakeDecisionWithHint(
            subscriberId,
            { priority: priority as MessagePriority, deliveryHint: delivery as import("../map/types.js").DeliveryHint | undefined },
            sessionChecker
          );
          if (decision.shouldWake || decision.shouldInterrupt) {
            wakeHandler(subscriberId, decision, event.id);
          }
        }

        delivered.push(subscriberId);
      }

      return {
        id: event.id,
        from,
        to,
        content,
        timestamp: event.timestamp,
        delivered,
        correlationId,
      };
    }

    if (isRoleAddress(to)) {
      // Role address - resolve to matching agents
      const agentSource: RoleAgentSource = {
        listAgents: () => eventStore.listAgents(),
        getAgent: (id) => eventStore.getAgent(id),
      };

      const recipientIds = resolveRoleTarget(agentSource, {
        role: to.role,
        coordinatorId: to.within,
      });

      if (recipientIds.length === 0) {
        throw new AddressRoutingError(
          `No agents found for role: ${to.role}${to.within ? ` within ${to.within}` : ""}`,
          "NO_RECIPIENTS",
          to
        );
      }

      const event = eventStore.emit({
        type: "message",
        source: { agent_id: from },
        target: {
          address: to,
          delivered: recipientIds,
        },
        payload: {
          content,
          correlation_id: correlationId,
          priority,
          delivery_hint: delivery,
          multicast: {
            type: "role",
            role: to.role,
            coordinatorId: to.within,
            recipientCount: recipientIds.length,
          },
        },
      });

      // Fan out to each recipient
      for (const recipientId of recipientIds) {
        eventStore.emit({
          type: "message",
          source: { agent_id: from },
          target: {
            agent_id: recipientId,
            address: { agent: recipientId },
          },
          payload: {
            content,
            correlation_id: correlationId,
            priority,
            delivery_hint: delivery,
            via: "role",
            original_message_id: event.id,
          },
        });

        // Handle wake decision
        if (sessionChecker && wakeHandler) {
          const decision = getWakeDecisionWithHint(
            recipientId,
            { priority: priority as MessagePriority, deliveryHint: delivery as import("../map/types.js").DeliveryHint | undefined },
            sessionChecker
          );
          if (decision.shouldWake || decision.shouldInterrupt) {
            wakeHandler(recipientId, decision, event.id);
          }
        }

        delivered.push(recipientId);
      }

      return {
        id: event.id,
        from,
        to,
        content,
        timestamp: event.timestamp,
        delivered,
        correlationId,
      };
    }

    if (isBroadcastAddress(to)) {
      // Broadcast to all agents
      const agentSource: BroadcastAgentSource = {
        listAgents: () => eventStore.listAgents(),
      };

      const recipientIds = resolveBroadcastTarget(agentSource, { scope: "all" });

      const event = eventStore.emit({
        type: "message",
        source: { agent_id: from },
        target: {
          address: to,
          delivered: recipientIds,
        },
        payload: {
          content,
          correlation_id: correlationId,
          priority,
          delivery_hint: delivery,
          multicast: {
            type: "broadcast",
            scope: "all",
            recipientCount: recipientIds.length,
          },
        },
      });

      // Fan out to each recipient
      for (const recipientId of recipientIds) {
        eventStore.emit({
          type: "message",
          source: { agent_id: from },
          target: {
            agent_id: recipientId,
            address: { agent: recipientId },
          },
          payload: {
            content,
            correlation_id: correlationId,
            priority,
            delivery_hint: delivery,
            via: "broadcast",
            original_message_id: event.id,
          },
        });

        // Handle wake decision
        if (sessionChecker && wakeHandler) {
          const decision = getWakeDecisionWithHint(
            recipientId,
            { priority: priority as MessagePriority, deliveryHint: delivery as import("../map/types.js").DeliveryHint | undefined },
            sessionChecker
          );
          if (decision.shouldWake || decision.shouldInterrupt) {
            wakeHandler(recipientId, decision, event.id);
          }
        }

        delivered.push(recipientId);
      }

      return {
        id: event.id,
        from,
        to,
        content,
        timestamp: event.timestamp,
        delivered,
        correlationId,
      };
    }

    // Should not reach here for legacy-compatible addresses
    throw new AddressRoutingError(
      `Unhandled address type: ${describeAddress(to)}`,
      "ADDRESS_NOT_SUPPORTED",
      to
    );
  }

  /**
   * Send a message to a hierarchical address (parent, children, ancestors, descendants, siblings).
   * Uses the address resolver to convert the relative address to concrete agent IDs.
   */
  async function sendToHierarchicalAddress(
    from: AgentId,
    to: Address,
    content: string,
    options: { priority?: string; delivery?: string; correlationId?: string } = {}
  ): Promise<AddressSendResult> {
    const { priority = "normal", delivery, correlationId } = options;
    const delivered: AgentId[] = [];

    // Create hierarchy source from EventStore
    const hierarchySource: HierarchySource = {
      getAgent: (id) => {
        const agent = eventStore.getAgent(id);
        if (!agent) return undefined;
        return {
          id: agent.id,
          parent: agent.parent ?? undefined,
          lineage: agent.lineage,
          state: agent.state,
        };
      },
      listAgents: () =>
        eventStore.listAgents().map((agent) => ({
          id: agent.id,
          parent: agent.parent ?? undefined,
          lineage: agent.lineage,
          state: agent.state,
        })),
    };

    // Resolve the hierarchical address
    const resolved = resolveHierarchicalAddress(
      to as import("../map/types.js").HierarchicalAddress,
      from,
      hierarchySource
    );

    if (resolved.agentIds.length === 0) {
      throw new AddressRoutingError(
        `No recipients found for hierarchical address: ${describeAddress(to)}`,
        "NO_RECIPIENTS",
        to
      );
    }

    // Emit a primary event for the hierarchical send
    const event = eventStore.emit({
      type: "message",
      source: { agent_id: from },
      target: {
        address: to,
        delivered: resolved.agentIds,
      },
      payload: {
        content,
        correlation_id: correlationId,
        priority,
        delivery_hint: delivery,
        multicast: {
          type: "hierarchical",
          address: describeAddress(to),
          recipientCount: resolved.agentIds.length,
        },
      },
    });

    // Fan out to each resolved recipient
    for (const recipientId of resolved.agentIds) {
      eventStore.emit({
        type: "message",
        source: { agent_id: from },
        target: {
          agent_id: recipientId,
          address: { agent: recipientId },
        },
        payload: {
          content,
          correlation_id: correlationId,
          priority,
          delivery_hint: delivery,
          via: "hierarchical",
          original_message_id: event.id,
        },
      });

      // Handle wake decision
      if (sessionChecker && wakeHandler) {
        const decision = getWakeDecisionWithHint(
          recipientId,
          {
            priority: priority as MessagePriority,
            deliveryHint: delivery as import("../map/types.js").DeliveryHint | undefined,
          },
          sessionChecker
        );
        if (decision.shouldWake || decision.shouldInterrupt) {
          wakeHandler(recipientId, decision, event.id);
        }
      }

      delivered.push(recipientId);
    }

    return {
      id: event.id,
      from,
      to,
      content,
      timestamp: event.timestamp,
      delivered,
      correlationId,
    };
  }

  /**
   * Send a message to multiple specific agents.
   * Used for { agents: [...] } addresses.
   */
  async function sendToMultipleAgents(
    from: AgentId,
    to: import("../map/types.js").AgentsAddress,
    content: string,
    options: { priority?: string; delivery?: string; correlationId?: string } = {}
  ): Promise<AddressSendResult> {
    const { priority = "normal", delivery, correlationId } = options;
    const delivered: AgentId[] = [];
    const recipientIds = to.agents;

    if (recipientIds.length === 0) {
      throw new AddressRoutingError(
        "Empty agents array",
        "NO_RECIPIENTS",
        to
      );
    }

    // Verify all agents exist first
    for (const agentId of recipientIds) {
      const agent = eventStore.getAgent(agentId);
      if (!agent) {
        throw new AddressRoutingError(
          `Agent not found: ${agentId}`,
          "AGENT_NOT_FOUND",
          to
        );
      }
    }

    // Emit primary event for the multi-agent send
    const event = eventStore.emit({
      type: "message",
      source: { agent_id: from },
      target: {
        address: to,
        delivered: recipientIds,
      },
      payload: {
        content,
        correlation_id: correlationId,
        priority,
        delivery_hint: delivery,
        multicast: {
          type: "agents",
          recipientCount: recipientIds.length,
        },
      },
    });

    // Fan out to each recipient
    for (const recipientId of recipientIds) {
      eventStore.emit({
        type: "message",
        source: { agent_id: from },
        target: {
          agent_id: recipientId,
          address: { agent: recipientId },
        },
        payload: {
          content,
          correlation_id: correlationId,
          priority,
          delivery_hint: delivery,
          via: "agents",
          original_message_id: event.id,
        },
      });

      // Handle wake decision
      if (sessionChecker && wakeHandler) {
        const decision = getWakeDecisionWithHint(
          recipientId,
          {
            priority: priority as MessagePriority,
            deliveryHint: delivery as
              | import("../map/types.js").DeliveryHint
              | undefined,
          },
          sessionChecker
        );
        if (decision.shouldWake || decision.shouldInterrupt) {
          wakeHandler(recipientId, decision, event.id);
        }
      }

      delivered.push(recipientId);
    }

    return {
      id: event.id,
      from,
      to,
      content,
      timestamp: event.timestamp,
      delivered,
      correlationId,
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
    sendToAddress,
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

/**
 * PeerManager - Manages peer-to-peer communication between macro-agents
 *
 * Provides:
 * - Transport registration and management
 * - Inbound message/request routing to internal agents
 * - Outbound message/request sending via transport
 * - Request/response correlation
 * - Optional persistence via EventStore
 */

import { nanoid } from "nanoid";
import type { EventStore } from "../store/event-store.js";
import type { MessageRouter } from "../router/message-router.js";
import type { AgentId } from "../store/types/index.js";
import type {
  PeerTransport,
  PeerHandler,
  PeerConfig,
  PeerMessage,
  PeerRequest,
  PeerResponse,
  PeerAddress,
  ParsedPeerAddress,
  PendingRequest,
  PeerInboxMessage,
} from "./types.js";
import { PeerError } from "./types.js";

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<PeerConfig> = {
  persistMessages: false,
  persistRequests: false,
  defaultRequestTimeout: 30000,
};

/**
 * PeerManager interface
 */
export interface PeerManager {
  /**
   * Register a transport for peer communication.
   * @param transport - The transport implementation
   * @returns Handler for routing inbound messages to this macro-agent
   */
  registerTransport(transport: PeerTransport): PeerHandler;

  /**
   * Check if a transport is registered.
   */
  hasTransport(): boolean;

  /**
   * Send a message to a peer (fire-and-forget).
   * Called by internal agents via MCP tools.
   * @param from - Source agent ID within this macro-agent
   * @param to - Target peer address
   * @param message - The message to send
   */
  sendMessage(from: AgentId, to: PeerAddress, message: PeerMessage): Promise<void>;

  /**
   * Send a request to a peer and wait for response.
   * Called by internal agents via MCP tools.
   * @param from - Source agent ID within this macro-agent
   * @param to - Target peer address
   * @param request - The request to send
   * @returns The peer's response
   */
  sendRequest(from: AgentId, to: PeerAddress, request: PeerRequest): Promise<PeerResponse>;

  /**
   * Respond to a pending inbound request.
   * Called by internal agents via MCP tools.
   * @param agentId - Agent responding
   * @param requestId - ID of the request to respond to
   * @param response - The response (result or error)
   */
  respondToRequest(
    agentId: AgentId,
    requestId: string,
    response: Omit<PeerResponse, "error"> & { error?: PeerResponse["error"] }
  ): void;

  /**
   * Get pending peer messages for an agent.
   * @param agentId - Agent to get messages for
   * @param options - Options for filtering
   */
  getPeerMessages(
    agentId: AgentId,
    options?: { includeRequests?: boolean }
  ): PeerInboxMessage[];

  /**
   * Acknowledge peer messages as read.
   * @param agentId - Agent acknowledging
   * @param messageIds - IDs of messages to acknowledge
   */
  acknowledgePeerMessages(agentId: AgentId, messageIds: string[]): void;

  /**
   * Parse a peer address into components.
   * @param address - Address to parse
   * @returns Parsed address with peerId and optional agentId
   */
  parseAddress(address: PeerAddress): ParsedPeerAddress;

  /**
   * Deliver an inbound message from a peer (for ACP integration).
   * This queues the message for the target agent without needing a transport.
   * @param from - Source peer address
   * @param message - The message to deliver
   * @param targetAgentId - Optional target agent ID (defaults to root)
   * @returns The message ID
   */
  deliverMessage(
    from: PeerAddress,
    message: PeerMessage,
    targetAgentId?: AgentId
  ): string;

  /**
   * Deliver an inbound request from a peer (for ACP integration).
   * This queues the request and returns a promise that resolves when responded to.
   * @param from - Source peer address
   * @param request - The request to deliver
   * @param targetAgentId - Optional target agent ID (defaults to root)
   * @returns Promise that resolves with the response
   */
  deliverRequest(
    from: PeerAddress,
    request: PeerRequest,
    targetAgentId?: AgentId
  ): Promise<PeerResponse>;
}

/**
 * Create a PeerManager instance
 */
export function createPeerManager(
  eventStore: EventStore,
  messageRouter: MessageRouter,
  rootAgentId: AgentId,
  config: PeerConfig = {}
): PeerManager {
  const effectiveConfig = { ...DEFAULT_CONFIG, ...config };

  // Registered transport (only one allowed)
  let transport: PeerTransport | null = null;

  // Pending inbound requests awaiting response from internal agents
  const pendingRequests = new Map<string, PendingRequest>();

  // Per-agent peer message queues
  const peerMessageQueues = new Map<AgentId, PeerInboxMessage[]>();

  // Acknowledged message IDs per agent
  const acknowledgedMessages = new Map<AgentId, Set<string>>();

  /**
   * Parse a peer address into peerId and optional agentId
   */
  function parseAddress(address: PeerAddress): ParsedPeerAddress {
    const slashIndex = address.indexOf("/");
    if (slashIndex === -1) {
      return { peerId: address };
    }
    return {
      peerId: address.substring(0, slashIndex),
      agentId: address.substring(slashIndex + 1) as AgentId,
    };
  }

  /**
   * Get the target agent ID from an inbound address.
   * If no agent specified, routes to root agent.
   */
  function getTargetAgentId(from: PeerAddress): AgentId {
    const parsed = parseAddress(from);
    if (parsed.agentId) {
      // Verify the agent exists
      const agent = eventStore.getAgent(parsed.agentId);
      if (!agent) {
        throw new PeerError(
          `Agent not found: ${parsed.agentId}`,
          "AGENT_NOT_FOUND",
          { address: from }
        );
      }
      return parsed.agentId;
    }
    return rootAgentId;
  }

  /**
   * Add a message to an agent's peer message queue
   */
  function queuePeerMessage(agentId: AgentId, message: PeerInboxMessage): void {
    if (!peerMessageQueues.has(agentId)) {
      peerMessageQueues.set(agentId, []);
    }
    peerMessageQueues.get(agentId)!.push(message);

    // Persist if configured
    if (effectiveConfig.persistMessages) {
      eventStore.emit({
        type: "peer_message",
        source: { peer: message.from },
        target: { agent_id: agentId },
        payload: {
          type: message.type,
          payload: message.payload,
          correlationId: message.correlationId,
          isRequest: message.isRequest,
          requestId: message.requestId,
        },
      });
    }
  }

  /**
   * Register a transport for peer communication
   */
  function registerTransport(peerTransport: PeerTransport): PeerHandler {
    transport = peerTransport;

    return {
      handleMessage(from: PeerAddress, message: PeerMessage): void {
        const targetAgentId = getTargetAgentId(from);

        const inboxMessage: PeerInboxMessage = {
          id: `peer_${nanoid(12)}`,
          from: `peer:${from}`,
          type: message.type,
          payload: message.payload,
          timestamp: message.metadata?.timestamp ?? Date.now(),
          correlationId: message.metadata?.correlationId,
        };

        queuePeerMessage(targetAgentId, inboxMessage);
      },

      async handleRequest(from: PeerAddress, request: PeerRequest): Promise<PeerResponse> {
        const targetAgentId = getTargetAgentId(from);
        const requestId = `req_${nanoid(12)}`;
        const timeout = request.timeout ?? effectiveConfig.defaultRequestTimeout;

        return new Promise<PeerResponse>((resolve) => {
          // Set up timeout
          const timeoutHandle = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              error: {
                code: -32000,
                message: "Request timeout",
              },
            });
          }, timeout);

          // Store pending request
          const pendingRequest: PendingRequest = {
            requestId,
            from,
            request,
            resolve,
            timeout: timeoutHandle,
            targetAgentId,
            timestamp: Date.now(),
          };
          pendingRequests.set(requestId, pendingRequest);

          // Queue as message so agent can see it
          const inboxMessage: PeerInboxMessage = {
            id: requestId,
            from: `peer:${from}`,
            type: `request:${request.method}`,
            payload: request.params,
            timestamp: Date.now(),
            isRequest: true,
            requestId,
          };

          queuePeerMessage(targetAgentId, inboxMessage);

          // Persist if configured
          if (effectiveConfig.persistRequests) {
            eventStore.emit({
              type: "peer_request",
              source: { peer: from },
              target: { agent_id: targetAgentId },
              payload: {
                requestId,
                method: request.method,
                params: request.params,
              },
            });
          }
        });
      },
    };
  }

  /**
   * Check if a transport is registered
   */
  function hasTransport(): boolean {
    return transport !== null;
  }

  /**
   * Send a message to a peer
   */
  async function sendMessage(
    from: AgentId,
    to: PeerAddress,
    message: PeerMessage
  ): Promise<void> {
    if (!transport) {
      throw new PeerError("No transport registered", "NO_TRANSPORT");
    }

    // Add timestamp if not present
    const messageWithTimestamp: PeerMessage = {
      ...message,
      metadata: {
        ...message.metadata,
        timestamp: message.metadata?.timestamp ?? Date.now(),
        sourceAgent: from,
      },
    };

    try {
      await transport.sendMessage(to, messageWithTimestamp);
    } catch (error) {
      throw new PeerError(
        `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
        "TRANSPORT_ERROR",
        { to, error }
      );
    }
  }

  /**
   * Send a request to a peer
   */
  async function sendRequest(
    from: AgentId,
    to: PeerAddress,
    request: PeerRequest
  ): Promise<PeerResponse> {
    if (!transport) {
      throw new PeerError("No transport registered", "NO_TRANSPORT");
    }

    try {
      return await transport.sendRequest(to, request);
    } catch (error) {
      throw new PeerError(
        `Failed to send request: ${error instanceof Error ? error.message : String(error)}`,
        "TRANSPORT_ERROR",
        { to, error }
      );
    }
  }

  /**
   * Respond to a pending inbound request
   */
  function respondToRequest(
    agentId: AgentId,
    requestId: string,
    response: Omit<PeerResponse, "error"> & { error?: PeerResponse["error"] }
  ): void {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      throw new PeerError(
        `Request not found: ${requestId}`,
        "REQUEST_NOT_FOUND",
        { requestId }
      );
    }

    // Verify the responding agent is the target
    if (pending.targetAgentId !== agentId) {
      throw new PeerError(
        `Agent ${agentId} cannot respond to request targeted at ${pending.targetAgentId}`,
        "AGENT_NOT_FOUND",
        { requestId, agentId, targetAgentId: pending.targetAgentId }
      );
    }

    // Clear timeout and resolve
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    pending.resolve(response);
  }

  /**
   * Get pending peer messages for an agent
   */
  function getPeerMessages(
    agentId: AgentId,
    options?: { includeRequests?: boolean }
  ): PeerInboxMessage[] {
    const queue = peerMessageQueues.get(agentId) ?? [];
    const acknowledged = acknowledgedMessages.get(agentId) ?? new Set();

    // Filter out acknowledged messages
    let messages = queue.filter((m) => !acknowledged.has(m.id));

    // Optionally filter out requests
    if (options?.includeRequests === false) {
      messages = messages.filter((m) => !m.isRequest);
    }

    return messages;
  }

  /**
   * Acknowledge peer messages as read
   */
  function acknowledgePeerMessages(agentId: AgentId, messageIds: string[]): void {
    if (!acknowledgedMessages.has(agentId)) {
      acknowledgedMessages.set(agentId, new Set());
    }
    const set = acknowledgedMessages.get(agentId)!;
    for (const id of messageIds) {
      set.add(id);
    }
  }

  /**
   * Deliver an inbound message from a peer (for ACP integration)
   */
  function deliverMessage(
    from: PeerAddress,
    message: PeerMessage,
    targetAgentId?: AgentId
  ): string {
    // Determine target agent
    const target = targetAgentId ?? rootAgentId;

    // Create inbox message
    const inboxMessage: PeerInboxMessage = {
      id: `peer_${nanoid(12)}`,
      from: `peer:${from}`,
      type: message.type,
      payload: message.payload,
      timestamp: message.metadata?.timestamp ?? Date.now(),
      correlationId: message.metadata?.correlationId,
    };

    // Queue the message
    queuePeerMessage(target, inboxMessage);

    return inboxMessage.id;
  }

  /**
   * Deliver an inbound request from a peer (for ACP integration)
   */
  function deliverRequest(
    from: PeerAddress,
    request: PeerRequest,
    targetAgentId?: AgentId
  ): Promise<PeerResponse> {
    // Determine target agent
    const target = targetAgentId ?? rootAgentId;
    const requestId = `req_${nanoid(12)}`;
    const timeout = request.timeout ?? effectiveConfig.defaultRequestTimeout;

    return new Promise<PeerResponse>((resolve) => {
      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve({
          error: {
            code: -32000,
            message: "Request timeout",
          },
        });
      }, timeout);

      // Store pending request
      const pendingRequest: PendingRequest = {
        requestId,
        from,
        request,
        resolve,
        timeout: timeoutHandle,
        targetAgentId: target,
        timestamp: Date.now(),
      };
      pendingRequests.set(requestId, pendingRequest);

      // Queue as message so agent can see it
      const inboxMessage: PeerInboxMessage = {
        id: requestId,
        from: `peer:${from}`,
        type: `request:${request.method}`,
        payload: request.params,
        timestamp: Date.now(),
        isRequest: true,
        requestId,
      };

      queuePeerMessage(target, inboxMessage);

      // Persist if configured
      if (effectiveConfig.persistRequests) {
        eventStore.emit({
          type: "peer_request",
          source: { peer: from },
          target: { agent_id: target },
          payload: {
            requestId,
            method: request.method,
            params: request.params,
          },
        });
      }
    });
  }

  return {
    registerTransport,
    hasTransport,
    sendMessage,
    sendRequest,
    respondToRequest,
    getPeerMessages,
    acknowledgePeerMessages,
    parseAddress,
    deliverMessage,
    deliverRequest,
  };
}

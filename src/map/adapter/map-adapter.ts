/**
 * MAPAdapter - External MAP Protocol Interface
 *
 * ## Routing Architecture Role
 *
 * MAPAdapter is the **external protocol translation layer** for MAP clients.
 * It translates MAP protocol messages into internal routing calls.
 *
 * ```
 * External → MAPAdapter → MessageRouter → EventStore
 * (MAP RPC)   (this)      (routing)       (persistence)
 * ```
 *
 * **Responsibilities:**
 * - Accept MAP protocol connections (JSON-RPC over WebSocket/streams)
 * - Manage participant lifecycle (connect, disconnect, capabilities)
 * - Handle authentication and permission enforcement (Layer 1)
 * - Translate MAP addresses to internal routing
 * - Stream events to subscribed participants
 * - Dispatch extension method calls (spawn, wake, tasks, etc.)
 *
 * **Delegates to internal components:**
 * - MessageRouter: For message routing and delivery (sendToAddress)
 * - AgentManager: For agent lifecycle operations
 * - EventStore: For event persistence and subscription
 *
 * **Not responsible for:**
 * - Internal agent-to-agent messaging (use MessageRouter directly)
 * - Batch event delivery (use TriggerRouter/WakeManager)
 * - Legacy channel-based routing (use MessageRouter.send())
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import { ulid } from "ulid";
import type {
  MAPAdapter,
  MAPAdapterConfig,
  Stream,
  ExtensionHandler,
  ExtensionContext,
  MessagePayload,
  SendResult,
  AgentFilter,
  AgentInfo,
  ScopeInfo,
  AdapterEvent,
  AdapterEventHandler,
} from "./interface.js";
import type {
  ParticipantId,
  ParticipantType,
  ParticipantCapabilities,
  ConnectedParticipant,
  SubscriptionId,
  SubscriptionFilter,
  EventNotification,
  AuthCredentials,
} from "./types.js";
import type { Address, SendOptions, ScopeId } from "../types.js";
import type { AgentId } from "../../store/types/index.js";
import { createConnectionManager, type ConnectionManager } from "./connection-manager.js";
import { createSubscriptionManager, type SubscriptionManager } from "./subscription-manager.js";
import {
  RPCHandler,
  createRPCHandler,
  RPCError,
  createCapabilityMiddleware,
  createNotification,
  type HandlerRegistry,
  type HandlerContext,
  type JsonRpcMessage,
} from "./rpc-handler.js";
import { EXTENSION_CAPABILITIES } from "./extensions/index.js";
import type { FederationHandler, FederationCapabilities, ConnectedPeer, MAPPeerConfig } from "../federation/types.js";

// =============================================================================
// Connection Session
// =============================================================================

/**
 * Active connection session with RPC handler and stream.
 */
interface ConnectionSession {
  participantId: ParticipantId;
  participant: ConnectedParticipant;
  rpcHandler: RPCHandler;
  stream: Stream;
  writer: WritableStreamDefaultWriter<unknown>;
  abortController: AbortController;
}

// =============================================================================
// Services Interface
// =============================================================================

/**
 * External services required by MAPAdapter.
 */
export interface MAPAdapterServices {
  /**
   * Get agent by ID.
   */
  getAgent?: (agentId: AgentId) => AgentState | undefined;

  /**
   * List agents with optional filter.
   */
  listAgents?: (filter?: AgentFilter) => AgentState[];

  /**
   * Send message via MessageRouter.
   */
  sendMessage?: (
    from: AgentId,
    to: Address,
    content: string,
    options?: SendOptions
  ) => Promise<{ delivered: AgentId[] }>;

  /**
   * Get agent's ancestors (for subscription matching).
   */
  getAncestors?: (agentId: AgentId) => AgentId[];

  /**
   * Get agent's descendants (for subscription matching).
   */
  getDescendants?: (agentId: AgentId) => AgentId[];

  /**
   * Optional federation handler for cross-system communication.
   */
  federationHandler?: FederationHandler;
}

/**
 * Internal agent state from AgentManager.
 */
interface AgentState {
  id: AgentId;
  name?: string;
  role?: string;
  state: string;
  parent?: AgentId;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

// =============================================================================
// Scope Management
// =============================================================================

/**
 * Internal scope state.
 */
interface ScopeState {
  id: ScopeId;
  name?: string;
  members: Set<AgentId>;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// MAPAdapter Implementation
// =============================================================================

/**
 * MAPAdapter implementation.
 */
export class MAPAdapterImpl implements MAPAdapter {
  readonly config: MAPAdapterConfig;

  private readonly connections: ConnectionManager;
  private readonly subscriptions: SubscriptionManager;
  private readonly sessions: Map<ParticipantId, ConnectionSession> = new Map();
  private readonly extensions: Map<string, ExtensionHandler> = new Map();
  private readonly scopes: Map<ScopeId, ScopeState> = new Map();
  private readonly eventHandlers: Set<AdapterEventHandler> = new Set();
  private readonly services: MAPAdapterServices;

  private running = false;

  constructor(config: MAPAdapterConfig = {}, services: MAPAdapterServices = {}) {
    this.config = {
      name: config.name ?? "macro-agent",
      version: config.version ?? "1.0.0",
      ...config,
    };
    this.services = services;

    // Initialize connection manager
    this.connections = createConnectionManager({
      limits: config.limits,
      anonymousCapabilities: config.anonymousCapabilities,
      defaultClientCapabilities: config.defaultClientCapabilities,
      defaultAgentCapabilities: config.defaultAgentCapabilities,
    });

    // Initialize subscription manager
    this.subscriptions = createSubscriptionManager({
      limits: config.limits,
      getAncestors: services.getAncestors,
      getDescendants: services.getDescendants,
    });

    // Forward connection events
    this.connections.onEvent((event) => {
      if (event.type === "participant.connected") {
        this.emitAdapterEvent({
          type: "participant.connected",
          participant: event.participant,
        });
      } else if (event.type === "participant.disconnected") {
        this.emitAdapterEvent({
          type: "participant.disconnected",
          participantId: event.participantId,
          reason: event.reason,
        });
      }
    });

    // Forward subscription events
    this.subscriptions.onEvent((event) => {
      if (event.type === "subscription.created") {
        this.emitAdapterEvent({
          type: "subscription.created",
          subscriptionId: event.subscription.id,
        });
      } else if (event.type === "subscription.removed") {
        this.emitAdapterEvent({
          type: "subscription.removed",
          subscriptionId: event.subscriptionId,
        });
      }
    });
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  async acceptConnection(stream: Stream): Promise<ConnectedParticipant> {
    if (!this.running) {
      throw new Error("Adapter not running");
    }

    // Create participant with default client type (will be updated after connect handshake)
    const participant = this.connections.connect({
      type: "client",
    });

    // Create RPC handler for this connection
    const rpcHandler = this.createRPCHandler(participant.id);

    // Get writer for sending responses
    const writer = stream.writable.getWriter();

    // Create abort controller for this session
    const abortController = new AbortController();

    // Track session
    const session: ConnectionSession = {
      participantId: participant.id,
      participant,
      rpcHandler,
      stream,
      writer,
      abortController,
    };
    this.sessions.set(participant.id, session);

    // Start message processing
    this.processMessages(session).catch((error) => {
      if (!abortController.signal.aborted) {
        console.error("[MAPAdapter] Message processing error:", error);
        this.disconnectParticipant(participant.id, "processing_error");
      }
    });

    return participant;
  }

  async disconnectParticipant(id: ParticipantId, reason?: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    // Abort message processing
    session.abortController.abort();

    // Clean up subscriptions
    this.subscriptions.removeAllForParticipant(id);

    // Close writer
    try {
      session.writer.releaseLock();
      const writer = session.stream.writable.getWriter();
      await writer.close();
    } catch {
      // Ignore close errors
    }

    // Remove session
    this.sessions.delete(id);

    // Disconnect from connection manager
    this.connections.disconnect(id, reason);
  }

  getParticipants(): ConnectedParticipant[] {
    return this.connections.getParticipants();
  }

  getParticipant(id: ParticipantId): ConnectedParticipant | undefined {
    return this.connections.getParticipant(id);
  }

  // ===========================================================================
  // Messaging
  // ===========================================================================

  async sendMessage(
    participantId: ParticipantId,
    to: Address,
    payload: MessagePayload,
    options?: SendOptions
  ): Promise<SendResult> {
    const participant = this.connections.getParticipant(participantId);
    if (!participant) {
      throw RPCError.notFound("participant", participantId);
    }

    if (!participant.capabilities.canMessage) {
      throw RPCError.permissionDenied("Messaging not allowed");
    }

    // For external clients, use a virtual sender ID
    const senderId = `external:${participantId}` as AgentId;

    if (!this.services.sendMessage) {
      throw RPCError.internalError("Message routing not available");
    }

    const result = await this.services.sendMessage(
      senderId,
      to,
      typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content),
      options
    );

    return {
      messageId: `msg-${ulid()}`,
      delivered: result.delivered,
    };
  }

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  async createSubscription(
    participantId: ParticipantId,
    filter?: SubscriptionFilter
  ): Promise<SubscriptionId> {
    const participant = this.connections.getParticipant(participantId);
    if (!participant) {
      throw RPCError.notFound("participant", participantId);
    }

    if (!participant.capabilities.canSubscribe) {
      throw RPCError.permissionDenied("Subscriptions not allowed");
    }

    return this.subscriptions.subscribe(participantId, filter);
  }

  async removeSubscription(subscriptionId: SubscriptionId): Promise<void> {
    this.subscriptions.unsubscribe(subscriptionId);
  }

  getSubscriptions(participantId: ParticipantId): SubscriptionId[] {
    return this.subscriptions.getSubscriptionIds(participantId);
  }

  async pauseSubscription(subscriptionId: SubscriptionId): Promise<void> {
    this.subscriptions.pause(subscriptionId);
  }

  async resumeSubscription(subscriptionId: SubscriptionId): Promise<void> {
    this.subscriptions.resume(subscriptionId);
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  listAgents(participantId: ParticipantId, filter?: AgentFilter): AgentInfo[] {
    const participant = this.connections.getParticipant(participantId);
    if (!participant) {
      return [];
    }

    if (!participant.capabilities.canQuery) {
      return [];
    }

    if (!this.services.listAgents) {
      return [];
    }

    const agents = this.services.listAgents(filter);
    return agents.map((agent) => this.toAgentInfo(agent));
  }

  getAgent(participantId: ParticipantId, agentId: AgentId): AgentInfo | undefined {
    const participant = this.connections.getParticipant(participantId);
    if (!participant) {
      return undefined;
    }

    if (!participant.capabilities.canQuery) {
      return undefined;
    }

    if (!this.services.getAgent) {
      return undefined;
    }

    const agent = this.services.getAgent(agentId);
    return agent ? this.toAgentInfo(agent) : undefined;
  }

  listScopes(participantId: ParticipantId): ScopeInfo[] {
    const participant = this.connections.getParticipant(participantId);
    if (!participant) {
      return [];
    }

    if (!participant.capabilities.canQuery) {
      return [];
    }

    return Array.from(this.scopes.values()).map((scope) => this.toScopeInfo(scope));
  }

  getScope(participantId: ParticipantId, scopeId: ScopeId): ScopeInfo | undefined {
    const participant = this.connections.getParticipant(participantId);
    if (!participant) {
      return undefined;
    }

    if (!participant.capabilities.canQuery) {
      return undefined;
    }

    const scope = this.scopes.get(scopeId);
    return scope ? this.toScopeInfo(scope) : undefined;
  }

  // ===========================================================================
  // Events
  // ===========================================================================

  emitEvent(event: EventNotification): void {
    // Match event against subscriptions
    const { subscriptions: matchingSubs, participantIds } = this.subscriptions.match(event);

    // Send to each matched participant
    for (const participantId of participantIds) {
      const session = this.sessions.get(participantId);
      if (session) {
        const notification = createNotification("map/event", event);
        this.sendToSession(session, notification).catch((error) => {
          console.error("[MAPAdapter] Failed to send event:", error);
        });
      }
    }
  }

  onEvent(handler: AdapterEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  // ===========================================================================
  // Extensions
  // ===========================================================================

  registerExtension(method: string, handler: ExtensionHandler): void {
    if (!method.startsWith("_macro/")) {
      throw new Error(`Extension method must start with "_macro/": ${method}`);
    }
    this.extensions.set(method, handler);
  }

  unregisterExtension(method: string): void {
    this.extensions.delete(method);
  }

  getExtensions(): string[] {
    return Array.from(this.extensions.keys());
  }

  hasExtension(method: string): boolean {
    return this.extensions.has(method);
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
  }

  async stop(graceful: boolean = true): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;

    // Disconnect all participants
    const reason = graceful ? "server_shutdown" : "server_stopped";
    this.connections.disconnectAll(reason);

    // Clear sessions
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  // ===========================================================================
  // Scope Management (internal)
  // ===========================================================================

  /**
   * Create a scope (internal use by RPC handlers).
   */
  createScope(name?: string, metadata?: Record<string, unknown>): ScopeId {
    const id = `scope-${ulid()}` as ScopeId;
    this.scopes.set(id, {
      id,
      name,
      members: new Set(),
      createdAt: Date.now(),
      metadata,
    });
    return id;
  }

  /**
   * Delete a scope.
   */
  deleteScope(scopeId: ScopeId): boolean {
    return this.scopes.delete(scopeId);
  }

  /**
   * Add agent to scope.
   */
  joinScope(scopeId: ScopeId, agentId: AgentId): boolean {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      return false;
    }
    scope.members.add(agentId);
    return true;
  }

  /**
   * Remove agent from scope.
   */
  leaveScope(scopeId: ScopeId, agentId: AgentId): boolean {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      return false;
    }
    return scope.members.delete(agentId);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private createRPCHandler(participantId: ParticipantId): RPCHandler {
    const handlers: HandlerRegistry = {
      // Connection
      "map/connect": async (params) => this.handleConnect(participantId, params),
      "map/disconnect": async () => this.handleDisconnect(participantId),

      // Subscriptions
      "map/subscribe": async (params) => this.handleSubscribe(participantId, params),
      "map/unsubscribe": async (params) => this.handleUnsubscribe(participantId, params),

      // Messaging
      "map/send": async (params, ctx) => this.handleSend(participantId, params, ctx),

      // Agent queries
      "map/agents/list": async (params) => this.handleListAgents(participantId, params),
      "map/agents/get": async (params) => this.handleGetAgent(participantId, params),

      // Scope queries
      "map/scopes/list": async () => this.handleListScopes(participantId),
      "map/scopes/get": async (params) => this.handleGetScope(participantId, params),
      "map/scopes/create": async (params, ctx) => this.handleCreateScope(participantId, params, ctx),
      "map/scopes/join": async (params) => this.handleJoinScope(participantId, params),
      "map/scopes/leave": async (params) => this.handleLeaveScope(participantId, params),

      // Federation methods
      "map/federation/connect": async (params) => this.handleFederationConnect(participantId, params),
      "map/federation/disconnect": async (params) => this.handleFederationDisconnect(participantId, params),
      "map/federation/list": async () => this.handleFederationList(participantId),
      "map/federation/capabilities": async (params) => this.handleFederationCapabilities(participantId, params),
    };

    // Add extension method handlers
    for (const [method, handler] of this.extensions) {
      handlers[method] = async (params, ctx) => {
        const extCtx: ExtensionContext = {
          participantId: ctx.participantId,
          capabilities: ctx.capabilities,
          sessionId: this.sessions.get(ctx.participantId)?.participant.sessionId ?? "",
        };
        return handler(extCtx, params);
      };
    }

    // Capability requirements for methods
    const capabilityRequirements: Record<string, keyof ConnectedParticipant["capabilities"]> = {
      "map/subscribe": "canSubscribe",
      "map/send": "canMessage",
      "map/agents/list": "canQuery",
      "map/agents/get": "canQuery",
      "map/scopes/list": "canQuery",
      "map/scopes/get": "canQuery",
      "map/scopes/create": "canManageScopes",
      // Federation methods
      "map/federation/connect": "canManageFederation",
      "map/federation/disconnect": "canManageFederation",
      "map/federation/list": "canQuery",
      "map/federation/capabilities": "canQuery",
    };

    // Add capability requirements for registered extension methods
    for (const method of this.extensions.keys()) {
      const capability = EXTENSION_CAPABILITIES[method];
      if (capability) {
        capabilityRequirements[method] = capability as keyof ConnectedParticipant["capabilities"];
      }
    }

    return createRPCHandler({
      handlers,
      middleware: [createCapabilityMiddleware(capabilityRequirements)],
    });
  }

  private async processMessages(session: ConnectionSession): Promise<void> {
    const reader = session.stream.readable.getReader();

    try {
      while (!session.abortController.signal.aborted) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Process the message
        const participant = this.connections.getParticipant(session.participantId);
        if (!participant) {
          break;
        }

        const result = await session.rpcHandler.process(value, {
          participantId: session.participantId,
          capabilities: participant.capabilities,
          signal: session.abortController.signal,
        });

        // Send response if needed
        if (result.type === "response") {
          await this.sendToSession(session, result.response);
        }
      }
    } catch (error) {
      if (!session.abortController.signal.aborted) {
        throw error;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async sendToSession(session: ConnectionSession, message: JsonRpcMessage): Promise<void> {
    try {
      // Use the existing writer from the session (acquired in acceptConnection)
      await session.writer.write(message);
    } catch (error) {
      console.error("[MAPAdapter] Failed to send message:", error);
      throw error;
    }
  }

  private emitAdapterEvent(event: AdapterEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[MAPAdapter] Event handler error:", error);
      }
    }
  }

  // ===========================================================================
  // RPC Handlers
  // ===========================================================================

  private async handleConnect(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ participantId: ParticipantId; capabilities: ConnectedParticipant["capabilities"] }> {
    const participant = this.connections.getParticipant(participantId);
    if (!participant) {
      throw RPCError.notFound("participant", participantId);
    }

    // Parse connect request parameters
    const connectParams = params as {
      type?: ParticipantType;
      name?: string;
      credentials?: AuthCredentials;
    } | undefined;

    const requestedType = connectParams?.type ?? participant.type;
    const credentials = connectParams?.credentials;

    // Handle authentication if handler is configured and credentials provided
    if (this.config.authenticate && credentials) {
      const authResult = await this.config.authenticate(requestedType, credentials);

      if (!authResult.allowed) {
        throw RPCError.authenticationFailed(authResult.error ?? "Authentication failed");
      }

      // Update capabilities based on auth result
      const newCapabilities = authResult.capabilities ?? this.getDefaultCapabilities(requestedType);
      this.connections.updateCapabilities(participantId, newCapabilities);

      // Return updated participant info
      const updatedParticipant = this.connections.getParticipant(participantId);
      return {
        participantId: participant.id,
        capabilities: updatedParticipant?.capabilities ?? newCapabilities,
      };
    }

    // No auth handler or no credentials - use default capabilities for the type
    if (requestedType !== participant.type) {
      const defaultCapabilities = this.getDefaultCapabilities(requestedType);
      this.connections.updateCapabilities(participantId, defaultCapabilities);

      const updatedParticipant = this.connections.getParticipant(participantId);
      return {
        participantId: participant.id,
        capabilities: updatedParticipant?.capabilities ?? defaultCapabilities,
      };
    }

    return {
      participantId: participant.id,
      capabilities: participant.capabilities,
    };
  }

  /**
   * Get default capabilities for a participant type.
   */
  private getDefaultCapabilities(type: ParticipantType): ParticipantCapabilities {
    switch (type) {
      case "agent":
        return this.config.defaultAgentCapabilities ?? {
          canQuery: true,
          canSubscribe: true,
          canMessage: true,
          canSpawn: true,
          canStop: true,
          canManageScopes: true,
          canManageTasks: true,
          canManageFederation: true,
        };
      case "gateway":
        return {
          canQuery: true,
          canSubscribe: true,
          canMessage: true,
          canSpawn: false,
          canStop: false,
          canManageScopes: false,
          canManageTasks: false,
          canManageFederation: true,
        };
      case "client":
      default:
        return this.config.defaultClientCapabilities ?? {
          canQuery: true,
          canSubscribe: true,
          canMessage: true,
          canSpawn: false,
          canStop: false,
          canManageScopes: false,
          canManageTasks: false,
        };
    }
  }

  private async handleDisconnect(participantId: ParticipantId): Promise<{ success: boolean }> {
    await this.disconnectParticipant(participantId, "client_disconnect");
    return { success: true };
  }

  private async handleSubscribe(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ subscriptionId: SubscriptionId }> {
    const filter = (params as { filter?: SubscriptionFilter })?.filter;
    const subscriptionId = await this.createSubscription(participantId, filter);
    return { subscriptionId };
  }

  private async handleUnsubscribe(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ success: boolean }> {
    const subscriptionId = (params as { subscriptionId: SubscriptionId })?.subscriptionId;
    if (!subscriptionId) {
      throw RPCError.invalidParams("subscriptionId required");
    }
    await this.removeSubscription(subscriptionId);
    return { success: true };
  }

  private async handleSend(
    participantId: ParticipantId,
    params: unknown,
    ctx: HandlerContext
  ): Promise<SendResult> {
    const { to, payload, options } = params as {
      to: Address;
      payload: MessagePayload;
      options?: SendOptions;
    };

    if (!to) {
      throw RPCError.invalidParams("to address required");
    }
    if (!payload) {
      throw RPCError.invalidParams("payload required");
    }

    return this.sendMessage(participantId, to, payload, options);
  }

  private async handleListAgents(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ agents: AgentInfo[] }> {
    const filter = (params as { filter?: AgentFilter })?.filter;
    const agents = this.listAgents(participantId, filter);
    return { agents };
  }

  private async handleGetAgent(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ agent: AgentInfo | null }> {
    const agentId = (params as { agentId: AgentId })?.agentId;
    if (!agentId) {
      throw RPCError.invalidParams("agentId required");
    }
    const agent = this.getAgent(participantId, agentId);
    return { agent: agent ?? null };
  }

  private async handleListScopes(participantId: ParticipantId): Promise<{ scopes: ScopeInfo[] }> {
    const scopes = this.listScopes(participantId);
    return { scopes };
  }

  private async handleGetScope(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ scope: ScopeInfo | null }> {
    const scopeId = (params as { scopeId: ScopeId })?.scopeId;
    if (!scopeId) {
      throw RPCError.invalidParams("scopeId required");
    }
    const scope = this.getScope(participantId, scopeId);
    return { scope: scope ?? null };
  }

  private async handleCreateScope(
    participantId: ParticipantId,
    params: unknown,
    ctx: HandlerContext
  ): Promise<{ scopeId: ScopeId }> {
    const { name, metadata } = (params as { name?: string; metadata?: Record<string, unknown> }) ?? {};
    const scopeId = this.createScope(name, metadata);
    return { scopeId };
  }

  private async handleJoinScope(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ success: boolean }> {
    const { scopeId, agentId } = params as { scopeId: ScopeId; agentId: AgentId };
    if (!scopeId) {
      throw RPCError.invalidParams("scopeId required");
    }
    if (!agentId) {
      throw RPCError.invalidParams("agentId required");
    }

    const success = this.joinScope(scopeId, agentId);
    if (!success) {
      throw RPCError.notFound("scope", scopeId);
    }
    return { success };
  }

  private async handleLeaveScope(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ success: boolean }> {
    const { scopeId, agentId } = params as { scopeId: ScopeId; agentId: AgentId };
    if (!scopeId) {
      throw RPCError.invalidParams("scopeId required");
    }
    if (!agentId) {
      throw RPCError.invalidParams("agentId required");
    }

    const success = this.leaveScope(scopeId, agentId);
    if (!success) {
      throw RPCError.notFound("scope", scopeId);
    }
    return { success };
  }

  // ===========================================================================
  // Federation Handlers
  // ===========================================================================

  private async handleFederationConnect(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ capabilities: FederationCapabilities }> {
    if (!this.services.federationHandler) {
      throw RPCError.internalError("Federation not available");
    }

    const { systemId, endpoint, auth } = (params ?? {}) as MAPPeerConfig;
    if (!systemId) {
      throw RPCError.invalidParams("systemId is required");
    }
    if (!endpoint) {
      throw RPCError.invalidParams("endpoint is required");
    }

    try {
      const capabilities = await this.services.federationHandler.connect({
        systemId,
        endpoint,
        auth,
      });
      return { capabilities };
    } catch (err) {
      throw RPCError.internalError(
        err instanceof Error ? err.message : "Failed to connect"
      );
    }
  }

  private async handleFederationDisconnect(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ success: boolean }> {
    if (!this.services.federationHandler) {
      throw RPCError.internalError("Federation not available");
    }

    const { systemId } = (params ?? {}) as { systemId: string };
    if (!systemId) {
      throw RPCError.invalidParams("systemId is required");
    }

    try {
      await this.services.federationHandler.disconnect(systemId);
      return { success: true };
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("Not connected")
      ) {
        throw RPCError.notFound("peer", systemId);
      }
      throw RPCError.internalError(
        err instanceof Error ? err.message : "Failed to disconnect"
      );
    }
  }

  private async handleFederationList(
    participantId: ParticipantId
  ): Promise<{ peers: Array<{ systemId: string; status: string; connectedAt: number }> }> {
    if (!this.services.federationHandler) {
      return { peers: [] };
    }

    const peers = this.services.federationHandler.listPeers();
    return {
      peers: peers.map((peer: ConnectedPeer) => ({
        systemId: peer.systemId,
        status: peer.status,
        connectedAt: peer.connectedAt,
      })),
    };
  }

  private async handleFederationCapabilities(
    participantId: ParticipantId,
    params: unknown
  ): Promise<{ capabilities: FederationCapabilities | null }> {
    if (!this.services.federationHandler) {
      throw RPCError.internalError("Federation not available");
    }

    const { systemId } = (params ?? {}) as { systemId: string };
    if (!systemId) {
      throw RPCError.invalidParams("systemId is required");
    }

    const capabilities = this.services.federationHandler.getCapabilities(systemId);
    if (!capabilities) {
      throw RPCError.notFound("peer", systemId);
    }

    return { capabilities };
  }

  // ===========================================================================
  // Type Conversions
  // ===========================================================================

  private toAgentInfo(agent: AgentState): AgentInfo {
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      state: agent.state,
      parent: agent.parent,
      scopes: this.getAgentScopes(agent.id),
      metadata: agent.metadata,
      createdAt: agent.createdAt,
    };
  }

  private toScopeInfo(scope: ScopeState): ScopeInfo {
    return {
      id: scope.id,
      name: scope.name,
      members: Array.from(scope.members),
      createdAt: scope.createdAt,
      metadata: scope.metadata,
    };
  }

  private getAgentScopes(agentId: AgentId): ScopeId[] {
    const result: ScopeId[] = [];
    for (const scope of this.scopes.values()) {
      if (scope.members.has(agentId)) {
        result.push(scope.id);
      }
    }
    return result;
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a MAPAdapter instance.
 */
export function createMAPAdapter(
  config?: MAPAdapterConfig,
  services?: MAPAdapterServices
): MAPAdapter {
  return new MAPAdapterImpl(config, services);
}

/**
 * Trigger Router Types
 *
 * Defines the routing strategy interface and related types
 * for flexible trigger routing.
 *
 * @module trigger/router/types
 */

import type { AgentId } from "../../store/types/index.js";
import type { EventStore } from "../../store/event-store.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { SystemEventQueue } from "../queue/types.js";
import type {
  TriggerEvent,
  TriggerDeliveryResult,
  TriggerWakeMode,
} from "../types.js";

// =============================================================================
// Routing Context
// =============================================================================

/**
 * Context provided to routing strategies for making decisions
 */
export interface RoutingContext {
  /** Event store for agent/task lookup */
  eventStore: EventStore;
  /** Agent manager for spawning/querying agents */
  agentManager: AgentManager;
  /** Message router for agent messaging */
  messageRouter: MessageRouter;
  /** System event queue for queueing events */
  systemEventQueue: SystemEventQueue;
}

/**
 * Extended context with state information for AI routing
 */
export interface ExtendedRoutingContext extends RoutingContext {
  /** Summary of active agents */
  activeAgents: AgentSummary[];
  /** Summary of pending tasks */
  pendingTasks: TaskSummary[];
  /** Recent messages (optional) */
  recentMessages?: MessageSummary[];
  /** Blackboard state (optional) */
  blackboardState?: Record<string, unknown>;
}

/**
 * Agent summary for routing decisions
 */
export interface AgentSummary {
  id: AgentId;
  role?: string;
  state: "running" | "stopped" | "sleeping";
  currentTask?: string;
  parentId?: AgentId | null;
}

/**
 * Task summary for routing decisions
 */
export interface TaskSummary {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  assignedAgent?: AgentId;
}

/**
 * Message summary for routing decisions
 */
export interface MessageSummary {
  from: AgentId;
  to: AgentId;
  preview: string;
  timestamp: number;
}

// =============================================================================
// Routing Decision
// =============================================================================

/**
 * Result of a routing strategy's decision
 */
export interface RoutingDecision {
  /** Target agent(s) for delivery */
  targetAgents: AgentId[];
  /** Whether to spawn a new agent */
  spawnNew?: SpawnConfig;
  /** Additional context to include in delivery */
  additionalContext?: string;
  /** Override wake mode from trigger */
  wakeModeOverride?: TriggerWakeMode;
  /** Reason for the routing decision (for logging/debugging) */
  reason?: string;
  /** Whether to defer delivery (e.g., no suitable target) */
  defer?: boolean;
  /** Defer reason if applicable */
  deferReason?: string;
}

/**
 * Configuration for spawning a new agent
 */
export interface SpawnConfig {
  /** Task description for the new agent */
  task: string;
  /** Role for the new agent */
  role?: string;
  /** Parent agent ID */
  parentId?: AgentId;
  /** Additional configuration */
  config?: Record<string, unknown>;
}

// =============================================================================
// Routing Strategy Interface
// =============================================================================

/**
 * Pluggable routing strategy interface
 *
 * Implement this interface to create custom routing strategies
 * for trigger delivery.
 */
export interface RoutingStrategy {
  /** Strategy name for identification */
  readonly name: string;

  /** Strategy description */
  readonly description?: string;

  /**
   * Determine routing for a trigger event.
   *
   * This method can be async to support strategies that need
   * to query external systems or use AI for routing decisions.
   *
   * @param event - The trigger event to route
   * @param context - Routing context with system access
   * @returns Routing decision
   */
  route(event: TriggerEvent, context: RoutingContext): Promise<RoutingDecision>;

  /**
   * Check if this strategy can handle the event.
   *
   * Optional method to allow strategy selection based on
   * event characteristics.
   *
   * @param event - The trigger event
   * @returns True if this strategy should be used
   */
  canHandle?(event: TriggerEvent): boolean;

  /**
   * Initialize the strategy (optional).
   *
   * Called when the strategy is registered with the router.
   */
  initialize?(context: RoutingContext): Promise<void>;

  /**
   * Cleanup the strategy (optional).
   *
   * Called when the strategy is unregistered or router is stopped.
   */
  cleanup?(): Promise<void>;
}

// =============================================================================
// Trigger Router Interface
// =============================================================================

/**
 * Trigger router configuration
 */
export interface TriggerRouterConfig {
  /** Default routing strategy name */
  defaultStrategy?: string;
  /** AI router configuration */
  aiRouter?: {
    enabled: boolean;
    systemPrompt?: string;
    maxDecisionTimeMs?: number;
  };
}

/**
 * Trigger router interface
 */
export interface TriggerRouter {
  /**
   * Route a trigger event to appropriate agent(s)
   *
   * @param event - Trigger event to route
   * @returns Delivery result
   */
  route(event: TriggerEvent): Promise<TriggerDeliveryResult>;

  /**
   * Register a routing strategy
   *
   * @param strategy - Strategy to register
   */
  registerStrategy(strategy: RoutingStrategy): void;

  /**
   * Unregister a routing strategy
   *
   * @param name - Strategy name to unregister
   */
  unregisterStrategy(name: string): void;

  /**
   * Get a registered strategy by name
   *
   * @param name - Strategy name
   * @returns Strategy if found
   */
  getStrategy(name: string): RoutingStrategy | undefined;

  /**
   * List all registered strategies
   *
   * @returns Array of strategy names
   */
  listStrategies(): string[];

  /**
   * Set the default strategy
   *
   * @param name - Strategy name to use as default
   */
  setDefaultStrategy(name: string): void;

  /**
   * Get the default strategy name
   *
   * @returns Default strategy name
   */
  getDefaultStrategy(): string;

  /**
   * Start the router (initialize strategies, etc.)
   */
  start(): Promise<void>;

  /**
   * Stop the router (cleanup strategies, etc.)
   */
  stop(): Promise<void>;
}

// =============================================================================
// Strategy Selection
// =============================================================================

/**
 * Options for strategy selection
 */
export interface StrategySelectionOptions {
  /** Prefer a specific strategy by name */
  preferredStrategy?: string;
  /** Allow fallback to default if preferred not available */
  allowFallback?: boolean;
}

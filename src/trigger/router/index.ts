/**
 * Trigger Router
 *
 * Routes trigger events to appropriate agents using pluggable strategies.
 *
 * @module trigger/router
 */

export { createTriggerRouter, type TriggerRouterDeps } from "./trigger-router.js";

export type {
  TriggerRouter,
  TriggerRouterConfig,
  RoutingStrategy,
  RoutingContext,
  ExtendedRoutingContext,
  RoutingDecision,
  SpawnConfig,
  AgentSummary,
  TaskSummary,
  MessageSummary,
  StrategySelectionOptions,
} from "./types.js";

export {
  createDirectStrategy,
  createHeadStrategy,
  createRoleStrategy,
  createBroadcastStrategy,
  createTaskStrategy,
  createAIRouterStrategy,
  getDefaultRouterSystemPrompt,
  type DirectStrategyOptions,
  type RoleStrategyOptions,
  type AIRouterStrategyOptions,
} from "./strategies/index.js";

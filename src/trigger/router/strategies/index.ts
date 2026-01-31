/**
 * Routing Strategies
 *
 * Pluggable strategies for routing trigger events to agents.
 *
 * @module trigger/router/strategies
 */

export {
  createDirectStrategy,
  createHeadStrategy,
  type DirectStrategyOptions,
} from "./direct-strategy.js";

export {
  createRoleStrategy,
  createBroadcastStrategy,
  createTaskStrategy,
  type RoleStrategyOptions,
} from "./role-strategy.js";

export {
  createAIRouterStrategy,
  getDefaultRouterSystemPrompt,
  type AIRouterStrategyOptions,
} from "./ai-router-strategy.js";

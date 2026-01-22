/**
 * Activity Relevance Detection
 *
 * Determines which agents should be notified/woken for a given activity.
 * Uses multiple scopes: lineage, role, subscriptions, and custom rules.
 *
 * @module activity/relevance
 * @see s-9rld In-Flight Steering spec section 3.4
 */

import type { AgentId } from "../store/types/index.js";
import type {
  Activity,
  ActivityEventType,
  EventSubscription,
  RelevanceRule,
} from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Agent info required for relevance detection
 */
export interface RelevanceAgentInfo {
  id: AgentId;
  state: string;
  role?: string;
  lineage: AgentId[];
}

/**
 * Agent source for relevance detection
 */
export interface RelevanceAgentSource {
  listAgents(): RelevanceAgentInfo[];
  getAgent(agentId: AgentId): RelevanceAgentInfo | null;
}

/**
 * Subscription source for relevance detection
 */
export interface RelevanceSubscriptionSource {
  getSubscribers(eventType: ActivityEventType): EventSubscription[];
}

/**
 * Options for relevance detection
 */
export interface RelevanceOptions {
  /** Include lineage-based relevance (ancestors) */
  includeLineage?: boolean;
  /** Include role-based relevance */
  includeRole?: boolean;
  /** Include subscription-based relevance */
  includeSubscriptions?: boolean;
  /** Include direct target relevance */
  includeTarget?: boolean;
  /** Custom relevance rules */
  customRules?: RelevanceRule[];
}

const DEFAULT_RELEVANCE_OPTIONS: RelevanceOptions = {
  includeLineage: true,
  includeRole: true,
  includeSubscriptions: true,
  includeTarget: true,
  customRules: [],
};

// =============================================================================
// Relevance Detection
// =============================================================================

/**
 * Find all agents relevant to an activity.
 *
 * Relevance is determined by:
 * 1. Lineage: Ancestors of the source agent (they may be monitoring subtree)
 * 2. Role: Agents whose role matches the activity target
 * 3. Subscriptions: Agents subscribed to the event type
 * 4. Target: Direct target of the activity
 * 5. Custom rules: User-defined relevance rules
 */
export function findRelevantAgents(
  activity: Activity,
  agentSource: RelevanceAgentSource,
  subscriptionSource?: RelevanceSubscriptionSource,
  options: RelevanceOptions = DEFAULT_RELEVANCE_OPTIONS
): AgentId[] {
  const relevant = new Set<AgentId>();
  const opts = { ...DEFAULT_RELEVANCE_OPTIONS, ...options };

  // 1. Lineage: Wake ancestors if event is from their subtree
  if (opts.includeLineage && activity.source?.agent_id) {
    const sourceAgent = agentSource.getAgent(activity.source.agent_id);
    if (sourceAgent) {
      // Add all ancestors (they have this agent in their subtree)
      for (const ancestorId of sourceAgent.lineage) {
        relevant.add(ancestorId);
      }
    }
  }

  // 2. Role-based: Check if event targets a role
  if (opts.includeRole && activity.target?.type === "role" && activity.target.role) {
    const agents = agentSource.listAgents();
    const targetRole = activity.target.role;

    for (const agent of agents) {
      if (matchesRole(agent.role, targetRole)) {
        relevant.add(agent.id);
      }
    }
  }

  // 3. Subscriptions: Check event type subscribers
  if (opts.includeSubscriptions && subscriptionSource) {
    const eventType = activity.type as ActivityEventType;
    const subscriptions = subscriptionSource.getSubscribers(eventType);

    for (const sub of subscriptions) {
      // Check scope filters
      if (matchesSubscriptionScope(activity, sub, agentSource)) {
        relevant.add(sub.agentId);
      }
    }
  }

  // 4. Direct target: If activity targets a specific agent
  if (opts.includeTarget && activity.target?.type === "agent" && activity.target.target) {
    relevant.add(activity.target.target);
  }

  // 5. Custom rules
  if (opts.customRules) {
    for (const rule of opts.customRules) {
      const ruleResults = rule(activity);
      for (const agentId of ruleResults) {
        relevant.add(agentId);
      }
    }
  }

  // Filter to active agents only
  const activeRelevant = [...relevant].filter((id) => {
    const agent = agentSource.getAgent(id);
    return agent && agent.state === "running";
  });

  return activeRelevant;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if an agent's role matches a target role.
 * Supports exact match and prefix match (e.g., "worker.resolver" matches "worker").
 */
export function matchesRole(agentRole: string | undefined, targetRole: string): boolean {
  if (!agentRole) {
    return targetRole === "worker";
  }
  return agentRole === targetRole || agentRole.startsWith(`${targetRole}.`);
}

/**
 * Check if an activity matches a subscription's scope filters.
 */
export function matchesSubscriptionScope(
  activity: Activity,
  subscription: EventSubscription,
  agentSource: RelevanceAgentSource
): boolean {
  const scope = subscription.scope;
  if (!scope) {
    return true; // No scope filter = matches all
  }

  // Check subtree filter
  if (scope.subtree && activity.source?.agent_id) {
    const sourceAgent = agentSource.getAgent(activity.source.agent_id);
    if (!sourceAgent) {
      return false;
    }
    // Source must be in the subtree (have subtree agent in lineage or be the subtree agent)
    if (
      activity.source.agent_id !== scope.subtree &&
      !sourceAgent.lineage.includes(scope.subtree)
    ) {
      return false;
    }
  }

  // Check role filter
  if (scope.role && activity.source?.role) {
    if (!matchesRole(activity.source.role, scope.role)) {
      return false;
    }
  }

  // Check target agent filter
  if (scope.targetAgent) {
    if (
      activity.target?.type !== "agent" ||
      activity.target.target !== scope.targetAgent
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Get ancestors of an agent (from lineage).
 */
export function getAncestors(
  agentId: AgentId,
  agentSource: RelevanceAgentSource
): AgentId[] {
  const agent = agentSource.getAgent(agentId);
  if (!agent) {
    return [];
  }
  return [...agent.lineage];
}

/**
 * Check if an agent is in another agent's subtree.
 */
export function isInSubtree(
  agentId: AgentId,
  subtreeRootId: AgentId,
  agentSource: RelevanceAgentSource
): boolean {
  if (agentId === subtreeRootId) {
    return true;
  }
  const agent = agentSource.getAgent(agentId);
  return agent ? agent.lineage.includes(subtreeRootId) : false;
}

/**
 * Get all agents with a specific role.
 */
export function getAgentsByRole(
  role: string,
  agentSource: RelevanceAgentSource
): AgentId[] {
  const agents = agentSource.listAgents();
  return agents
    .filter((a) => a.state === "running" && matchesRole(a.role, role))
    .map((a) => a.id);
}

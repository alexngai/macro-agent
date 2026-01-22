/**
 * wait_for_activity MCP Tool
 *
 * Allows agents to block until a matching activity occurs.
 * Useful for monitors and coordinators that need to react to events.
 *
 * @module mcp/tools/wait_for_activity
 * @see s-9rld In-Flight Steering spec section 3.4
 */

import { z } from "zod";
import type { ToolContext } from "../types.js";
import type { ActivityWatcher } from "../../activity/watcher.js";
import type {
  Activity,
  ActivityEventType,
  EventSubscriptionScope,
  WaitForActivityResult,
} from "../../activity/types.js";

// =============================================================================
// Schema Definition
// =============================================================================

/**
 * Zod schema for wait_for_activity tool input
 */
export const WaitForActivitySchema = {
  event_types: z
    .array(z.string())
    .optional()
    .describe("Event types to wait for (empty = all events)"),
  timeout_ms: z
    .number()
    .optional()
    .default(30000)
    .describe("Timeout in milliseconds (default: 30000)"),
  scope: z
    .object({
      subtree: z.string().optional().describe("Only events from this agent's subtree"),
      role: z.string().optional().describe("Only events from agents with this role"),
      target_agent: z.string().optional().describe("Only events targeting this agent"),
    })
    .optional()
    .describe("Scope filter for events"),
};

// =============================================================================
// Tool Info
// =============================================================================

/**
 * Tool registration info for use with MCP server
 */
export const WAIT_FOR_ACTIVITY_TOOL_INFO = {
  name: "wait_for_activity",
  description:
    "Block until a matching activity event occurs or timeout. Useful for monitors and coordinators to react to events.",
  schema: WaitForActivitySchema,
};

// =============================================================================
// Tool Dependencies
// =============================================================================

/**
 * Dependencies for the wait_for_activity tool
 */
export interface WaitForActivityToolDeps {
  activityWatcher: ActivityWatcher;
}

// =============================================================================
// Handler
// =============================================================================

/**
 * Create the wait_for_activity tool handler
 */
export function createWaitForActivityHandler(
  context: ToolContext,
  deps: WaitForActivityToolDeps
) {
  return async (args: {
    event_types?: string[];
    timeout_ms?: number;
    scope?: {
      subtree?: string;
      role?: string;
      target_agent?: string;
    };
  }): Promise<WaitForActivityResult> => {
    const { activityWatcher } = deps;
    const timeoutMs = args.timeout_ms ?? 30000;
    const eventTypes = (args.event_types ?? []) as ActivityEventType[];
    const scope: EventSubscriptionScope | undefined = args.scope
      ? {
          subtree: args.scope.subtree,
          role: args.scope.role,
          targetAgent: args.scope.target_agent,
        }
      : undefined;

    return new Promise((resolve) => {
      let resolved = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      // Activity listener
      const listener = (activity: Activity) => {
        // Check if already resolved
        if (resolved) return;

        // Check event type filter
        if (
          eventTypes.length > 0 &&
          !eventTypes.includes(activity.type as ActivityEventType)
        ) {
          return;
        }

        // Check scope filter
        if (scope) {
          // Check subtree filter
          if (scope.subtree && activity.source?.agent_id) {
            // Would need to check lineage - for now, just check direct match
            // In a full implementation, we'd use relevance.ts helpers
            if (activity.source.agent_id !== scope.subtree) {
              // TODO: Check if source is in subtree
            }
          }

          // Check role filter
          if (scope.role && activity.source?.role) {
            if (activity.source.role !== scope.role &&
                !activity.source.role?.startsWith(`${scope.role}.`)) {
              return;
            }
          }

          // Check target agent filter
          if (scope.targetAgent) {
            if (
              activity.target?.type !== "agent" ||
              activity.target.target !== scope.targetAgent
            ) {
              return;
            }
          }
        }

        // Activity matches - resolve
        resolved = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        unsubscribe();

        resolve({
          triggered: true,
          activity: {
            type: activity.type,
            source: activity.source,
            timestamp: activity.timestamp,
            details: activity.details,
          },
        });
      };

      // Subscribe to activity events
      const unsubscribe = activityWatcher.addActivityListener(listener);

      // Set timeout
      timeoutHandle = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        unsubscribe();

        resolve({
          triggered: false,
          timeout: true,
        });
      }, timeoutMs);
    });
  };
}

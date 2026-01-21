/**
 * Monitor Role Definition
 *
 * Event-driven, activates on specific events rather than running continuously.
 */

import type { RoleDefinition } from "../types.js";
import {
  FILE_CAPABILITIES,
  LIFECYCLE_CAPABILITIES,
  MSG_CAPABILITIES,
} from "../capabilities.js";

/**
 * Monitor Role
 *
 * Health monitoring agent that:
 * - Activates on specific events (not continuous polling)
 * - Checks worker health and activity
 * - Detects GUPP violations (work assigned, no progress > 30 min)
 * - Detects stale sessions
 * - Requests termination of unresponsive agents
 * - Notifies coordinator of issues
 *
 * - Per-coordinator scope (not global)
 * - Event-driven activation
 * - Stateless (queries EventStore on each activation)
 * - No git workspace needed
 * - Bound to coordinator lifecycle
 */
export const MonitorRole: RoleDefinition = {
  name: "monitor",
  displayName: "Monitor",
  description:
    "Per-coordinator health monitoring, GUPP violation detection, cleanup orchestration",

  capabilities: [
    FILE_CAPABILITIES.READ,
    LIFECYCLE_CAPABILITIES.DONE, // Can shutdown gracefully
    MSG_CAPABILITIES.SEND,
    MSG_CAPABILITIES.BROADCAST,
    MSG_CAPABILITIES.SUBSCRIBE,
  ],

  workspace: {
    type: "none", // Monitor doesn't need a git workspace
    // Accesses agent state via EventStore and registry, not filesystem
  },

  lifecycle: {
    type: "event-driven", // Activates on events, not continuous
    parentBound: true, // Tied to coordinator lifecycle
  },

  protocol: {
    // Subscribes to specific events that require monitoring
    subscriptions: [
      "WORKER_SPAWNED", // Track new workers
      "WORKER_DONE", // Track completions
      "HEALTH_CHECK_TIMER", // Periodic health check trigger
      "AGENT_TIMEOUT", // External timeout signal
    ],
    canEmit: ["HEALTH_CHECK", "GUPP_VIOLATION", "FORCE_TERMINATE_REQUEST"],
  },
};

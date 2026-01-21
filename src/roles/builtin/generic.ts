/**
 * Generic Role Definition
 *
 * Full capabilities for backward compatibility.
 * Used for existing agents without explicit roles.
 */

import type { RoleDefinition } from "../types.js";
import { WILDCARD_CAPABILITY } from "../capabilities.js";

/**
 * Generic Role
 *
 * Backward-compatible role that:
 * - Has all capabilities (wildcard)
 * - Provides no workspace restrictions
 * - Allows all tools
 * - Used as fallback for unknown roles
 */
export const GenericRole: RoleDefinition = {
  name: "generic",
  displayName: "Generic Agent",
  description: "Full capabilities for backward compatibility",

  capabilities: [WILDCARD_CAPABILITY], // All capabilities

  workspace: {
    type: "own",
    cleanupOnTerminate: false,
  },

  lifecycle: {
    type: "persistent",
  },

  tools: {
    mode: "all",
  },
};

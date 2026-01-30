/**
 * Workspace Info Extension Method (_macro/workspace/info)
 *
 * Exposes workspace information to external MAP clients.
 * Returns limited info (no filesystem paths) for security.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { AgentId } from "../../../store/types/index.js";
import { RPCError } from "../rpc-handler.js";

// =============================================================================
// Request/Response Types
// =============================================================================

interface WorkspaceInfoParams {
  /** Agent ID to get workspace for */
  agentId: string;
}

/**
 * Workspace role types
 */
type WorkspaceRole = "worker" | "integrator" | "coordinator";

/**
 * Public workspace info (no filesystem paths exposed)
 */
interface WorkspaceInfo {
  /** Agent that owns this workspace */
  agentId: string;
  /** Workspace role */
  role: WorkspaceRole;
  /** Git branch name */
  branch: string;
  /** Stream ID for integration */
  streamId: string;
  /** Creation timestamp */
  createdAt: number;
  /** Task ID (worker only) */
  taskId?: string;
  /** Base branch (worker only) */
  baseBranch?: string;
  /** Coordinator ID (integrator only) */
  coordinatorId?: string;
  /** Number of child workspaces (coordinator only) */
  childCount?: number;
}

// =============================================================================
// Extension Services
// =============================================================================

/**
 * Internal workspace type (matches WorkspaceManager output)
 */
export interface InternalWorkspace {
  agentId: AgentId;
  path: string; // We don't expose this
  branch: string;
  streamId: string;
  role: WorkspaceRole;
  createdAt: number;
  // Role-specific fields
  taskId?: string;
  baseBranch?: string;
  coordinatorId?: string;
  childWorkspacePaths?: Map<AgentId, string>;
}

/**
 * Services required for workspace extension
 */
export interface WorkspaceExtensionServices {
  /**
   * Get workspace for an agent
   */
  getWorkspace: (agentId: AgentId) => InternalWorkspace | null;

  /**
   * Check if agent exists
   */
  agentExists: (agentId: AgentId) => boolean;
}

// =============================================================================
// Handler Implementation
// =============================================================================

function createWorkspaceInfoHandler(
  services: WorkspaceExtensionServices
): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId } = (params ?? {}) as WorkspaceInfoParams;

    if (!agentId) {
      throw RPCError.invalidParams("agentId is required");
    }

    // Check agent exists
    if (!services.agentExists(agentId as AgentId)) {
      throw RPCError.notFound("agent", agentId);
    }

    // Get workspace
    const workspace = services.getWorkspace(agentId as AgentId);

    if (!workspace) {
      // Agent exists but has no workspace
      return { workspace: null };
    }

    // Convert to public info (exclude path)
    const info: WorkspaceInfo = {
      agentId: workspace.agentId,
      role: workspace.role,
      branch: workspace.branch,
      streamId: workspace.streamId,
      createdAt: workspace.createdAt,
    };

    // Add role-specific fields
    switch (workspace.role) {
      case "worker":
        if (workspace.taskId) {
          info.taskId = workspace.taskId;
        }
        if (workspace.baseBranch) {
          info.baseBranch = workspace.baseBranch;
        }
        break;

      case "integrator":
        if (workspace.coordinatorId) {
          info.coordinatorId = workspace.coordinatorId;
        }
        break;

      case "coordinator":
        if (workspace.childWorkspacePaths) {
          info.childCount = workspace.childWorkspacePaths.size;
        }
        break;
    }

    return { workspace: info };
  };
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register workspace extension method with the MAPAdapter.
 *
 * @param adapter - MAPAdapter instance
 * @param services - Workspace extension services
 */
export function registerWorkspaceExtension(
  adapter: MAPAdapter,
  services: WorkspaceExtensionServices
): void {
  adapter.registerExtension("_macro/workspace/info", createWorkspaceInfoHandler(services));
}

/**
 * Unregister workspace extension method.
 *
 * @param adapter - MAPAdapter instance
 */
export function unregisterWorkspaceExtension(adapter: MAPAdapter): void {
  adapter.unregisterExtension("_macro/workspace/info");
}

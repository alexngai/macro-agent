/**
 * Resume Extension Method (_macro/resume)
 *
 * Resumes a stopped agent by spawning a new process and loading
 * the existing ACP session. This is a lifecycle management operation
 * independent from session loading.
 *
 * Unlike _macro/wake (which handles sleeping/idle agents), this extension
 * handles agents whose process has terminated (state: "stopped" or "failed").
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { AgentId } from "../../../store/types/index.js";
import { RPCError } from "../rpc-handler.js";

// =============================================================================
// Request/Response Types
// =============================================================================

interface ResumeParams {
  /** Agent ID to resume */
  agentId: string;
}

interface ResumeResult {
  /** Whether the resume was successful */
  success: boolean;
  /** The resumed agent's ID */
  agentId: string;
  /** The agent's ACP session ID */
  sessionId?: string;
}

// =============================================================================
// Extension Services
// =============================================================================

/**
 * Services required for resume extension
 */
export interface ResumeExtensionServices {
  /**
   * Get agent by ID. Returns agent record or undefined if not found.
   */
  getAgent: (agentId: AgentId) => { id: AgentId; state: string; session_id?: string } | undefined;

  /**
   * Resume a stopped agent — spawns a new process and loads the existing session.
   * Returns the spawned agent record.
   */
  resume: (agentId: AgentId) => Promise<{ id: AgentId; session_id: string }>;
}

// =============================================================================
// Handler Implementation
// =============================================================================

function createResumeHandler(services: ResumeExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId } = (params ?? {}) as ResumeParams;

    if (!agentId) {
      throw RPCError.invalidParams("agentId is required");
    }

    // Check agent exists
    const agent = services.getAgent(agentId as AgentId);
    if (!agent) {
      throw RPCError.notFound("agent", agentId);
    }

    // Only resume stopped/failed agents
    if (agent.state !== "stopped" && agent.state !== "failed") {
      throw RPCError.invalidParams(
        `Agent ${agentId} is ${agent.state} — only stopped or failed agents can be resumed`
      );
    }

    // Resume the agent
    const spawned = await services.resume(agentId as AgentId);

    return {
      success: true,
      agentId: spawned.id,
      sessionId: spawned.session_id,
    } satisfies ResumeResult;
  };
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register resume extension method with the MAPAdapter.
 *
 * @param adapter - MAPAdapter instance
 * @param services - Resume extension services
 */
export function registerResumeExtension(
  adapter: MAPAdapter,
  services: ResumeExtensionServices
): void {
  adapter.registerExtension("_macro/resume", createResumeHandler(services));
}

/**
 * Unregister resume extension method.
 *
 * @param adapter - MAPAdapter instance
 */
export function unregisterResumeExtension(adapter: MAPAdapter): void {
  adapter.unregisterExtension("_macro/resume");
}

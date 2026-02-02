/**
 * Wake Extension Method (_macro/wake)
 *
 * Exposes agent wake functionality to external MAP clients.
 * Allows external clients to wake sleeping agents with optional context.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { AgentId } from "../../../store/types/index.js";
import type { MessagePriority } from "../../../router/types.js";
import { RPCError } from "../rpc-handler.js";

// =============================================================================
// Request/Response Types
// =============================================================================

interface WakeParams {
  /** Agent ID to wake */
  agentId: string;
  /** Optional message/context for the wake */
  message?: string;
  /** Priority affects wake strategy */
  priority?: "low" | "normal" | "high" | "urgent";
}

interface WakeResult {
  /** Whether the wake was successful */
  success: boolean;
  /** True if agent was already active (no wake needed) */
  alreadyActive: boolean;
  /** The wake action taken (if any) */
  action?: "queued" | "woken" | "injected" | "interrupted";
}

// =============================================================================
// Extension Services
// =============================================================================

/**
 * Session info for wake decisions
 */
export interface SessionInfo {
  hasSession: boolean;
  isPrompting: boolean;
  supportsInjection: boolean;
}

/**
 * Services required for wake extension
 */
export interface WakeExtensionServices {
  /**
   * Get agent by ID
   */
  getAgent: (agentId: AgentId) => { id: AgentId; state: string } | undefined;

  /**
   * Get session info for an agent
   */
  getSessionInfo: (agentId: AgentId) => SessionInfo;

  /**
   * Send a prompt/message to an agent
   */
  prompt: (agentId: AgentId, message: string) => Promise<void>;

  /**
   * Inject context into an agent's session
   */
  inject?: (agentId: AgentId, message: string) => Promise<boolean>;

  /**
   * Interrupt an agent with a message
   */
  interrupt?: (agentId: AgentId, message: string) => Promise<boolean>;
}

// =============================================================================
// Wake Logic
// =============================================================================

/**
 * Determine wake action based on agent state and priority
 */
function determineWakeAction(
  sessionInfo: SessionInfo,
  priority: MessagePriority
): "queue" | "wake" | "inject" | "interrupt" | "skip" {
  // If agent is currently prompting (active), usually skip
  if (sessionInfo.isPrompting) {
    // Only interrupt for urgent priority
    if (priority === "urgent" && sessionInfo.supportsInjection) {
      return "interrupt";
    }
    return "skip";
  }

  // Agent not prompting - determine wake strategy
  if (!sessionInfo.hasSession) {
    // No session - need to wake
    return "wake";
  }

  // Has session but not prompting - try injection based on priority
  if (priority === "urgent" || priority === "high") {
    if (sessionInfo.supportsInjection) {
      return "inject";
    }
    return "wake";
  }

  // Normal/low priority - queue or wake
  return "wake";
}

// =============================================================================
// Handler Implementation
// =============================================================================

function createWakeHandler(services: WakeExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId, message, priority = "normal" } = (params ?? {}) as WakeParams;

    if (!agentId) {
      throw RPCError.invalidParams("agentId is required");
    }

    // Check agent exists
    const agent = services.getAgent(agentId as AgentId);
    if (!agent) {
      throw RPCError.notFound("agent", agentId);
    }

    // Check agent state
    if (agent.state === "stopped" || agent.state === "failed") {
      throw RPCError.invalidParams(`Agent ${agentId} is ${agent.state} and cannot be woken`);
    }

    // Get session info
    const sessionInfo = services.getSessionInfo(agentId as AgentId);

    // Check if already active
    if (sessionInfo.isPrompting) {
      // Agent is already active
      if (priority !== "urgent") {
        return {
          success: true,
          alreadyActive: true,
        } satisfies WakeResult;
      }
      // For urgent, try to interrupt
    }

    // Determine wake action
    const action = determineWakeAction(sessionInfo, priority as MessagePriority);

    if (action === "skip") {
      return {
        success: true,
        alreadyActive: true,
      } satisfies WakeResult;
    }

    // Format wake message
    const wakeMessage = message ?? "Wake requested by external client";

    // Execute wake action
    let actionTaken: WakeResult["action"];

    switch (action) {
      case "interrupt":
        if (services.interrupt) {
          await services.interrupt(agentId as AgentId, wakeMessage);
          actionTaken = "interrupted";
        } else {
          // Fallback to prompt
          await services.prompt(agentId as AgentId, wakeMessage);
          actionTaken = "woken";
        }
        break;

      case "inject":
        if (services.inject) {
          const injected = await services.inject(agentId as AgentId, wakeMessage);
          actionTaken = injected ? "injected" : "woken";
          if (!injected) {
            // Injection failed, fall back to prompt
            await services.prompt(agentId as AgentId, wakeMessage);
          }
        } else {
          // No inject support, use prompt
          await services.prompt(agentId as AgentId, wakeMessage);
          actionTaken = "woken";
        }
        break;

      case "wake":
      case "queue":
      default:
        await services.prompt(agentId as AgentId, wakeMessage);
        actionTaken = "woken";
        break;
    }

    return {
      success: true,
      alreadyActive: false,
      action: actionTaken,
    } satisfies WakeResult;
  };
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register wake extension method with the MAPAdapter.
 *
 * @param adapter - MAPAdapter instance
 * @param services - Wake extension services
 */
export function registerWakeExtension(
  adapter: MAPAdapter,
  services: WakeExtensionServices
): void {
  adapter.registerExtension("_macro/wake", createWakeHandler(services));
}

/**
 * Unregister wake extension method.
 *
 * @param adapter - MAPAdapter instance
 */
export function unregisterWakeExtension(adapter: MAPAdapter): void {
  adapter.unregisterExtension("_macro/wake");
}

/**
 * inject_context MCP Tool
 *
 * Allows agents to inject context into another agent's session.
 * Used for time-sensitive steering that can't wait for message checking.
 *
 * @module mcp/tools/inject_context
 * @see s-9rld In-Flight Steering spec section 3.1
 */

import { z } from "zod";
import type { AgentId } from "../../store/types/index.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import {
  injectContext,
  type InjectionDeps,
  type InjectionResult,
} from "../../steering/index.js";

// =============================================================================
// Schema Definition
// =============================================================================

/**
 * Zod schema for inject_context tool input
 */
export const InjectContextSchema = {
  target_agent_id: z
    .string()
    .describe("The agent ID to inject context into"),
  content: z
    .string()
    .describe("The context message to inject"),
  urgent: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, interrupts current work immediately instead of queueing"),
  reason: z
    .string()
    .optional()
    .describe("Optional reason for the injection (for audit logs)"),
};

/**
 * Tool info for registration
 */
export const INJECT_CONTEXT_TOOL_INFO = {
  name: "inject_context",
  description: `Inject context into another agent's session. Use this for time-sensitive
steering that can't wait for the agent to check messages.

The context will appear in the target agent's next turn, or immediately if urgent=true.

Fallback behavior:
- If injection not supported, falls back to interrupting the agent
- If that fails, sends a high-priority message instead

Use cases:
- Priority changes ("Pause feature X, work on Y first")
- Urgent information ("Build is failing, check your types")
- Health checks ("Are you stuck? Report status")
- Context updates ("Worker 2 finished the API, you can use it now")`,
};

// =============================================================================
// Tool Dependencies
// =============================================================================

/**
 * Dependencies for the inject_context tool
 */
export interface InjectContextToolDeps {
  agentManager: AgentManager;
  messageRouter: MessageRouter;
}

// =============================================================================
// Tool Handler
// =============================================================================

/**
 * Input args for the inject_context tool
 */
export interface InjectContextArgs {
  target_agent_id: string;
  content: string;
  urgent?: boolean;
  reason?: string;
}

/**
 * Create the handler for the inject_context tool
 */
export function createInjectContextHandler(
  deps: InjectContextToolDeps,
  callerAgentId: AgentId
) {
  // Create injection deps that wrap AgentManager and MessageRouter
  const injectionDeps: InjectionDeps = {
    getSession(agentId: AgentId) {
      const session = deps.agentManager.getSession(agentId);
      if (!session) return null;

      // Cast to InjectableSession interface
      return {
        inject: async (content: string) => session.inject(content),
        supportsInject: () => session.supportsInject(),
        checkInjectSupport: async () => {
          // Try a no-op inject to check support
          try {
            const result = await session.inject("");
            return result.success;
          } catch {
            return false;
          }
        },
        interruptWith: (content: string) => session.interruptWith(content),
      };
    },

    isPrompting(agentId: AgentId) {
      return deps.agentManager.isPrompting(agentId);
    },

    async sendMessage(
      fromAgentId: AgentId | undefined,
      toAgentId: AgentId,
      content: string,
      priority: "high"
    ) {
      await deps.messageRouter.send({
        from: {
          agent_id: fromAgentId ?? callerAgentId,
        },
        to: { agent_id: toAgentId },
        content,
        priority,
      });
    },
  };

  return async (args: InjectContextArgs): Promise<InjectionResult> => {
    return injectContext(injectionDeps, args.target_agent_id, args.content, {
      urgent: args.urgent,
      allowInterrupt: true, // MCP tool always allows interrupt fallback
      source: { type: "agent", agentId: callerAgentId },
      reason: args.reason,
    });
  };
}

/**
 * Format the tool result for MCP response
 */
export function formatInjectContextResult(result: InjectionResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (result.success) {
    let text = `Context injected via ${result.method}`;
    if (result.note) {
      text += `: ${result.note}`;
    }
    return {
      content: [{ type: "text", text }],
    };
  } else {
    return {
      content: [{ type: "text", text: `Injection failed: ${result.error}` }],
      isError: true,
    };
  }
}

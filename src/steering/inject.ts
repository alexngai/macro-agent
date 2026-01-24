/**
 * Context Injection
 *
 * Implements the core injectContext() function with full fallback chain:
 * 1. Try session.inject() if supported
 * 2. Fall back to session.interruptWith() if allowed
 * 3. Fall back to high-priority message
 *
 * @module steering/inject
 * @see s-9rld In-Flight Steering spec section 3.1
 */

import type { AgentId } from "../store/types/index.js";
import type {
  InjectionOptions,
  InjectionResult,
  InjectionDeps,
  InjectableSession,
} from "./types.js";

// =============================================================================
// Default Options
// =============================================================================

const DEFAULT_OPTIONS: Required<Omit<InjectionOptions, "source" | "reason">> = {
  allowInterrupt: true,
  urgent: false,
};

// =============================================================================
// Context Formatting
// =============================================================================

/**
 * Format injected content with metadata for context.
 */
export function formatInjectedContent(
  content: string,
  options: InjectionOptions
): string {
  const lines: string[] = [];

  // Add header based on source
  if (options.source?.type === "human") {
    lines.push("[Context Injection from User]");
  } else if (options.source?.type === "agent") {
    lines.push(`[Context Injection from Agent: ${options.source.agentId}]`);
  } else {
    lines.push("[Context Injection]");
  }

  // Add reason if provided
  if (options.reason) {
    lines.push(`Reason: ${options.reason}`);
  }

  // Add the actual content
  lines.push("");
  lines.push(content);

  return lines.join("\n");
}

// =============================================================================
// Core Injection Logic
// =============================================================================

/**
 * Attempt to inject via session.inject().
 * Returns null if not supported or failed.
 */
async function tryInject(
  session: InjectableSession,
  content: string
): Promise<InjectionResult | null> {
  // Check if inject is supported
  if (!session.supportsInject()) {
    // Try to verify with actual probe
    const supported = await session.checkInjectSupport();
    if (!supported) {
      return null;
    }
  }

  try {
    const result = await session.inject(content);
    if (result.success) {
      return {
        success: true,
        method: "inject",
        note: "Queued for next turn",
      };
    }
    // Inject returned failure
    return null;
  } catch {
    // Inject threw an error
    return null;
  }
}

/**
 * Attempt to inject via session.interruptWith().
 * This cancels current work and restarts with the new content.
 */
async function tryInterrupt(
  session: InjectableSession,
  content: string
): Promise<InjectionResult | null> {
  try {
    // Prepend context to explain the interruption
    const interruptContent = `[PRIORITY UPDATE - Previous work interrupted]\n\n${content}\n\nPlease incorporate this context and continue.`;

    // Drive the async iterator to completion
    // We don't need to process the updates, just ensure the interrupt happens
    const iterable = session.interruptWith(interruptContent);
    const iterator = iterable[Symbol.asyncIterator]();

    // Consume the first update to ensure the interrupt is processed
    // Then let it run in the background
    const firstUpdate = await iterator.next();

    if (firstUpdate.done === false) {
      // Interrupt started successfully, let it continue in background
      // We don't await all updates to avoid blocking
      (async () => {
        try {
          for await (const _ of iterable) {
            // Just drive the iterator to completion
          }
        } catch {
          // Ignore errors during background iteration
        }
      })();
    }

    return {
      success: true,
      method: "interrupt",
      note: "Cancelled current work and restarted with context",
    };
  } catch (error) {
    return null;
  }
}

/**
 * Inject context into an agent's session.
 *
 * Uses a fallback chain:
 * 1. If urgent, prefer interrupt for immediate effect
 * 2. Try session.inject() if supported (queues for next turn)
 * 3. Fall back to session.interruptWith() if allowInterrupt is true
 * 4. Fall back to sending a high-priority message
 *
 * @param deps - Dependencies for session access and messaging
 * @param targetAgentId - The agent to inject context into
 * @param content - The context to inject
 * @param options - Injection options
 * @returns Result of the injection attempt
 */
export async function injectContext(
  deps: InjectionDeps,
  targetAgentId: AgentId,
  content: string,
  options: InjectionOptions = {}
): Promise<InjectionResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const formattedContent = formatInjectedContent(content, options);

  // Get the target agent's session
  const session = deps.getSession(targetAgentId);

  // If no session, fall back to message
  if (!session) {
    return await sendFallbackMessage(
      deps,
      targetAgentId,
      formattedContent,
      options.source,
      "Agent has no active session"
    );
  }

  // Check if agent is currently prompting
  const isPrompting = deps.isPrompting(targetAgentId);

  // If urgent, prefer interrupt for immediate effect
  if (opts.urgent && isPrompting) {
    const result = await tryInterrupt(session, formattedContent);
    if (result) {
      return result;
    }
    // If interrupt failed, try inject as fallback
  }

  // Try inject first (if not urgent or interrupt failed)
  const injectResult = await tryInject(session, formattedContent);
  if (injectResult) {
    return injectResult;
  }

  // Try interrupt as fallback (if allowed and agent is prompting)
  if (opts.allowInterrupt && isPrompting) {
    const interruptResult = await tryInterrupt(session, formattedContent);
    if (interruptResult) {
      return interruptResult;
    }
  }

  // Fall back to high-priority message
  return await sendFallbackMessage(
    deps,
    targetAgentId,
    formattedContent,
    options.source,
    "Inject and interrupt not available"
  );
}

/**
 * Send a high-priority message as fallback.
 */
async function sendFallbackMessage(
  deps: InjectionDeps,
  targetAgentId: AgentId,
  content: string,
  source: InjectionOptions["source"],
  reason: string
): Promise<InjectionResult> {
  try {
    const fromAgentId = source?.type === "agent" ? source.agentId : undefined;
    await deps.sendMessage(fromAgentId, targetAgentId, content, "high");

    return {
      success: true,
      method: "message",
      note: `Sent as high-priority message (${reason})`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// =============================================================================
// Convenience Wrappers
// =============================================================================

/**
 * Create an injection function bound to specific dependencies.
 * Useful for creating a pre-configured injector.
 */
export function createInjector(deps: InjectionDeps) {
  return (
    targetAgentId: AgentId,
    content: string,
    options?: InjectionOptions
  ) => injectContext(deps, targetAgentId, content, options);
}

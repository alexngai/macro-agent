/**
 * Lifecycle Handlers Index
 *
 * Exports role-specific done() handlers and the handler registry.
 *
 * @module lifecycle/handlers
 * @see s-32xs Self-Cleaning Workers spec
 * @see s-bcqm Change Management spec
 */

import type { MessageRouter } from "../../router/message-router.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { MergeQueueInterface } from "../../workspace/merge-queue/types.js";
import type {
  LifecycleContext,
  DoneArgs,
  CleanupStatus,
  DoneHandlerResult,
  DoneHandler,
  DoneHandlerRegistry,
} from "../types.js";
import { handleWorkerDone, type WorkerHandlerDeps } from "./worker.js";
import { handleIntegratorDone, type IntegratorHandlerDeps } from "./integrator.js";
import { handleMonitorDone, type MonitorHandlerDeps } from "./monitor.js";
import { handleGenericDone, type GenericHandlerDeps } from "./generic.js";

// =============================================================================
// Re-exports
// =============================================================================

export { handleWorkerDone, type WorkerHandlerDeps } from "./worker.js";
export {
  handleIntegratorDone,
  handleResolverDone,
  type IntegratorHandlerDeps,
  type PendingResolver,
  type HandleResolverDoneResult,
} from "./integrator.js";
export { handleMonitorDone, type MonitorHandlerDeps } from "./monitor.js";
export { handleGenericDone, type GenericHandlerDeps } from "./generic.js";

// =============================================================================
// Handler Dependencies
// =============================================================================

/**
 * Combined dependencies for all handlers
 */
export interface AllHandlerDeps {
  messageRouter: MessageRouter;
  agentManager: AgentManager;

  /** Optional merge queue for integrator handlers */
  mergeQueue?: MergeQueueInterface;

  /** Optional workspace path resolver for integrators */
  getWorkspacePath?: (agentId: string) => string | undefined;

  /** Optional integration strategy (from team config) */
  integrationStrategy?: import("../../workspace/strategies/types.js").IntegrationStrategy;

  /** Optional task mode from team config */
  taskMode?: "push" | "pull";
}

// =============================================================================
// Handler Registry
// =============================================================================

/**
 * Create the default handler registry with all built-in handlers
 */
export function createHandlerRegistry(
  deps: AllHandlerDeps
): DoneHandlerRegistry {
  const registry: DoneHandlerRegistry = new Map();

  // Worker handler - include merge queue for queue submission and getWorkspacePath for resolver inline merge
  const workerDeps: WorkerHandlerDeps = {
    messageRouter: deps.messageRouter,
    agentManager: deps.agentManager,
    mergeQueue: deps.mergeQueue,
    getWorkspacePath: deps.getWorkspacePath,
    integrationStrategy: deps.integrationStrategy,
    taskMode: deps.taskMode,
  };
  registry.set("worker", (context, args, cleanupStatus) =>
    handleWorkerDone(context, args, cleanupStatus, workerDeps)
  );

  // Integrator handler - include merge queue, workspace path resolver, and agent manager
  registry.set("integrator", (context, args, cleanupStatus) => {
    const integratorDeps: IntegratorHandlerDeps = {
      messageRouter: deps.messageRouter,
      mergeQueue: deps.mergeQueue,
      workspacePath: deps.getWorkspacePath?.(context.agentId),
      agentManager: deps.agentManager,
    };
    return handleIntegratorDone(context, args, cleanupStatus, integratorDeps);
  });

  // Monitor handler
  const monitorDeps: MonitorHandlerDeps = {
    messageRouter: deps.messageRouter,
  };
  registry.set("monitor", (context, args, cleanupStatus) =>
    handleMonitorDone(context, args, cleanupStatus, monitorDeps)
  );

  return registry;
}

/**
 * Get the handler for a given role
 *
 * Falls back to the generic handler if no role-specific handler exists.
 */
export function getHandler(
  role: string,
  registry: DoneHandlerRegistry,
  deps: AllHandlerDeps
): DoneHandler {
  // Check for exact match
  const handler = registry.get(role);
  if (handler) {
    return handler;
  }

  // Check for role prefix match (e.g., "worker.resolver" matches "worker")
  const baseRole = role.split(".")[0];
  const baseHandler = registry.get(baseRole);
  if (baseHandler) {
    return baseHandler;
  }

  // Fall back to generic handler
  const genericDeps: GenericHandlerDeps = {
    messageRouter: deps.messageRouter,
  };
  return (context: LifecycleContext, args: DoneArgs, cleanupStatus: CleanupStatus) =>
    handleGenericDone(context, args, cleanupStatus, genericDeps);
}

// =============================================================================
// Dispatch Function
// =============================================================================

/**
 * Dispatch done() to the appropriate handler based on role
 */
export async function dispatchDone(
  context: LifecycleContext,
  args: DoneArgs,
  cleanupStatus: CleanupStatus,
  deps: AllHandlerDeps,
  registry?: DoneHandlerRegistry
): Promise<DoneHandlerResult> {
  // Use provided registry or create default
  const handlers = registry ?? createHandlerRegistry(deps);

  // Get the handler for this role
  const handler = getHandler(context.role, handlers, deps);

  // Execute the handler
  return handler(context, args, cleanupStatus);
}

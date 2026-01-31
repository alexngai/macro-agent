/**
 * MAP Adapter Extensions
 *
 * Exports all macro-agent specific extension methods for the MAP adapter.
 * These methods expose macro-agent features to external clients via
 * the `_macro/*` namespace.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

// Task extensions
export {
  registerTaskExtensions,
  unregisterTaskExtensions,
  type TaskExtensionServices,
} from "./task.js";

// Wake extension
export {
  registerWakeExtension,
  unregisterWakeExtension,
  type WakeExtensionServices,
  type SessionInfo,
} from "./wake.js";

// Workspace extension
export {
  registerWorkspaceExtension,
  unregisterWorkspaceExtension,
  type WorkspaceExtensionServices,
  type InternalWorkspace,
} from "./workspace.js";

import type { MAPAdapter } from "../interface.js";
import type { TaskExtensionServices } from "./task.js";
import type { WakeExtensionServices } from "./wake.js";
import type { WorkspaceExtensionServices } from "./workspace.js";
import { registerTaskExtensions } from "./task.js";
import { registerWakeExtension } from "./wake.js";
import { registerWorkspaceExtension } from "./workspace.js";

// =============================================================================
// Combined Registration
// =============================================================================

/**
 * All services required for macro-agent extensions
 */
export interface MacroExtensionServices {
  task?: TaskExtensionServices;
  wake?: WakeExtensionServices;
  workspace?: WorkspaceExtensionServices;
}

/**
 * Register all available macro-agent extension methods.
 *
 * Only registers extensions for which services are provided.
 *
 * @param adapter - MAPAdapter instance
 * @param services - Extension services (partial - only registers what's provided)
 *
 * @example
 * ```typescript
 * registerMacroExtensions(adapter, {
 *   task: {
 *     taskBackend,
 *     sendMessage: messageRouter.sendToAddress.bind(messageRouter),
 *   },
 *   wake: {
 *     getAgent: agentManager.get.bind(agentManager),
 *     getSessionInfo: (id) => ({
 *       hasSession: agentManager.hasActiveSession(id),
 *       isPrompting: agentManager.isPrompting(id),
 *       supportsInjection: agentManager.supportsInjection(id),
 *     }),
 *     prompt: async (id, msg) => { agentManager.prompt(id, msg); },
 *   },
 *   workspace: {
 *     getWorkspace: workspaceManager.getWorkspace.bind(workspaceManager),
 *     agentExists: (id) => agentManager.get(id) !== null,
 *   },
 * });
 * ```
 */
export function registerMacroExtensions(
  adapter: MAPAdapter,
  services: MacroExtensionServices
): void {
  if (services.task) {
    registerTaskExtensions(adapter, services.task);
  }

  if (services.wake) {
    registerWakeExtension(adapter, services.wake);
  }

  if (services.workspace) {
    registerWorkspaceExtension(adapter, services.workspace);
  }
}

/**
 * Unregister all macro-agent extension methods.
 *
 * @param adapter - MAPAdapter instance
 */
export function unregisterMacroExtensions(adapter: MAPAdapter): void {
  // Unregister all - safe to call even if not registered
  try {
    adapter.unregisterExtension("_macro/task/list");
    adapter.unregisterExtension("_macro/task/get");
    adapter.unregisterExtension("_macro/task/create");
    adapter.unregisterExtension("_macro/task/assign");
    adapter.unregisterExtension("_macro/task/complete");
    adapter.unregisterExtension("_macro/task/send");
    adapter.unregisterExtension("_macro/wake");
    adapter.unregisterExtension("_macro/workspace/info");
  } catch {
    // Ignore errors from unregistering non-existent extensions
  }
}

// =============================================================================
// Extension Method List
// =============================================================================

/**
 * List of all macro-agent extension methods
 */
export const MACRO_EXTENSION_METHODS = [
  // Task extensions
  "_macro/task/list",
  "_macro/task/get",
  "_macro/task/create",
  "_macro/task/assign",
  "_macro/task/complete",
  "_macro/task/send",
  // Wake extension
  "_macro/wake",
  // Workspace extension
  "_macro/workspace/info",
] as const;

/**
 * Extension method to required capability mapping
 */
export const EXTENSION_CAPABILITIES: Record<string, string> = {
  "_macro/task/list": "canQuery",
  "_macro/task/get": "canQuery",
  "_macro/task/create": "canManageTasks",
  "_macro/task/assign": "canManageTasks",
  "_macro/task/complete": "canManageTasks",
  "_macro/task/send": "canMessage",
  "_macro/wake": "canMessage", // Wake requires messaging capability
  "_macro/workspace/info": "canQuery",
};

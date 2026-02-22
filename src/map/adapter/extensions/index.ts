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

// Workspace file search extension
export {
  registerWorkspaceFileExtensions,
  unregisterWorkspaceFileExtensions,
  type WorkspaceFileServices,
} from "./workspace-files.js";

// Resume extension
export {
  registerResumeExtension,
  unregisterResumeExtension,
  type ResumeExtensionServices,
} from "./resume.js";

// Agent detection extensions
export {
  registerAgentDetectionExtensions,
  unregisterAgentDetectionExtensions,
  type AgentDetectionExtensionServices,
} from "./agent-detection.js";

// Update metadata extension
export {
  registerUpdateMetadataExtension,
  unregisterUpdateMetadataExtension,
  type UpdateMetadataExtensionServices,
} from "./update-metadata.js";

// MCP bridge extensions
export {
  registerMCPBridgeExtensions,
  unregisterMCPBridgeExtensions,
  MCP_BRIDGE_METHODS,
  type MCPBridgeServices,
} from "./mcp-bridge.js";

// Agent lifecycle extensions
export {
  registerAgentLifecycleExtensions,
  unregisterAgentLifecycleExtensions,
  AGENT_LIFECYCLE_METHODS,
  type AgentLifecycleExtensionServices,
} from "./agent-lifecycle.js";

// Stream/checkpoint/diffStack/mergeQueue extensions
export {
  registerStreamExtensions,
  unregisterStreamExtensions,
  STREAM_EXTENSION_METHODS,
  type StreamExtensionServices,
} from "./streams.js";

import type { MAPAdapter } from "../interface.js";
import type { TaskExtensionServices } from "./task.js";
import type { WakeExtensionServices } from "./wake.js";
import type { WorkspaceExtensionServices } from "./workspace.js";
import type { WorkspaceFileServices } from "./workspace-files.js";
import type { ResumeExtensionServices } from "./resume.js";
import type { AgentDetectionExtensionServices } from "./agent-detection.js";
import type { UpdateMetadataExtensionServices } from "./update-metadata.js";
import type { MCPBridgeServices } from "./mcp-bridge.js";
import type { AgentLifecycleExtensionServices } from "./agent-lifecycle.js";
import type { StreamExtensionServices } from "./streams.js";
import { registerTaskExtensions } from "./task.js";
import { registerWakeExtension } from "./wake.js";
import { registerWorkspaceExtension } from "./workspace.js";
import { registerWorkspaceFileExtensions } from "./workspace-files.js";
import { registerResumeExtension } from "./resume.js";
import { registerAgentDetectionExtensions } from "./agent-detection.js";
import { registerUpdateMetadataExtension } from "./update-metadata.js";
import { registerMCPBridgeExtensions, unregisterMCPBridgeExtensions, MCP_BRIDGE_METHODS } from "./mcp-bridge.js";
import { registerAgentLifecycleExtensions, unregisterAgentLifecycleExtensions, AGENT_LIFECYCLE_METHODS } from "./agent-lifecycle.js";
import { registerStreamExtensions, unregisterStreamExtensions, STREAM_EXTENSION_METHODS } from "./streams.js";

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
  workspaceFiles?: WorkspaceFileServices;
  resume?: ResumeExtensionServices;
  agentDetection?: AgentDetectionExtensionServices;
  updateMetadata?: UpdateMetadataExtensionServices;
  mcpBridge?: MCPBridgeServices;
  agentLifecycle?: AgentLifecycleExtensionServices;
  streams?: StreamExtensionServices;
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

  if (services.workspaceFiles) {
    registerWorkspaceFileExtensions(adapter, services.workspaceFiles);
  }

  if (services.resume) {
    registerResumeExtension(adapter, services.resume);
  }

  if (services.agentDetection) {
    registerAgentDetectionExtensions(adapter, services.agentDetection);
  }

  if (services.updateMetadata) {
    registerUpdateMetadataExtension(adapter, services.updateMetadata);
  }

  if (services.mcpBridge) {
    registerMCPBridgeExtensions(adapter, services.mcpBridge);
  }

  if (services.agentLifecycle) {
    registerAgentLifecycleExtensions(adapter, services.agentLifecycle);
  }

  if (services.streams) {
    registerStreamExtensions(adapter, services.streams);
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
    adapter.unregisterExtension("_macro/workspace/files/search");
    adapter.unregisterExtension("_macro/workspace/files/list");
    adapter.unregisterExtension("_macro/workspace/files/read");
    adapter.unregisterExtension("_macro/resume");
    adapter.unregisterExtension("_macro/agents/available");
    adapter.unregisterExtension("_macro/agents/refresh");
    adapter.unregisterExtension("_macro/agents/update");
  } catch {
    // Ignore errors from unregistering non-existent extensions
  }
  // Also unregister MCP bridge extensions
  unregisterMCPBridgeExtensions(adapter);
  // Also unregister agent lifecycle extensions
  unregisterAgentLifecycleExtensions(adapter);
  // Also unregister stream/checkpoint/diffStack/mergeQueue extensions
  unregisterStreamExtensions(adapter);
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
  // Workspace file search extensions
  "_macro/workspace/files/search",
  "_macro/workspace/files/list",
  "_macro/workspace/files/read",
  // Resume extension
  "_macro/resume",
  // Agent detection extensions
  "_macro/agents/available",
  "_macro/agents/refresh",
  // Update metadata extension
  "_macro/agents/update",
  // MCP bridge extensions
  ...MCP_BRIDGE_METHODS,
  // Agent lifecycle extensions
  ...AGENT_LIFECYCLE_METHODS,
  // Stream/checkpoint/diffStack/mergeQueue extensions
  ...STREAM_EXTENSION_METHODS,
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
  "_macro/workspace/files/search": "canQuery",
  "_macro/workspace/files/list": "canQuery",
  "_macro/workspace/files/read": "canQuery",
  "_macro/resume": "canManageLifecycle",
  "_macro/agents/available": "canQuery",
  "_macro/agents/refresh": "canQuery",
  "_macro/agents/update": "canQuery",
  "_macro/spawnAgent": "canManageLifecycle",
  "_macro/forkAgent": "canManageLifecycle",
  "_macro/setPermissionMode": "canManageLifecycle",
  "_macro/respondToPermission": "canManageLifecycle",
  // Stream extensions
  "_macro/streams/list": "canQuery",
  "_macro/streams/get": "canQuery",
  "_macro/streams/hierarchy": "canQuery",
  "_macro/streams/createPR": "canManageTasks",
  // Checkpoint extensions
  "_macro/checkpoints/list": "canQuery",
  "_macro/checkpoints/get": "canQuery",
  "_macro/checkpoints/select": "canManageTasks",
  // DiffStack extensions
  "_macro/diffStacks/list": "canQuery",
  "_macro/diffStacks/get": "canQuery",
  "_macro/diffStacks/create": "canManageTasks",
  "_macro/diffStacks/createPR": "canManageTasks",
  // MergeQueue extensions
  "_macro/mergeQueue/status": "canQuery",
  "_macro/mergeQueue/get": "canQuery",
};

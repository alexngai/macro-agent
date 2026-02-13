/**
 * Agent Metadata Update Extension
 *
 * Exposes generic agent metadata updates to external MAP clients:
 * - `_macro/agents/update` — Update name, plan, or arbitrary metadata for an agent
 *
 * Fields are persisted in the EventStore as out-of-band fields
 * (not derived from events) and survive view rebuilds.
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { Agent, AgentMetadataUpdate } from "../../../store/types/agents.js";

// =============================================================================
// Request/Response Types
// =============================================================================

interface UpdateMetadataParams {
  /** Agent ID to update */
  agentId: string;
  /** New display name */
  name?: string;
  /** Plan entries */
  plan?: Array<{ content: string; priority: string; status: string }>;
  /** Arbitrary metadata (shallow-merged with existing) */
  metadata?: Record<string, unknown>;
}

interface UpdateMetadataResult {
  success: boolean;
  agentId: string;
  /** List of fields that were updated */
  updated: string[];
}

// =============================================================================
// Extension Services
// =============================================================================

/**
 * Services required for the update-metadata extension.
 */
export interface UpdateMetadataExtensionServices {
  /** Get agent by ID to verify existence */
  getAgent: (agentId: string) => Agent | null;
  /** Persist the metadata updates */
  updateAgentMetadata: (agentId: string, updates: AgentMetadataUpdate) => void;
}

// =============================================================================
// Handler Implementation
// =============================================================================

function createUpdateMetadataHandler(
  services: UpdateMetadataExtensionServices,
): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId, name, plan, metadata } = (params ?? {}) as Partial<UpdateMetadataParams>;

    if (!agentId) {
      throw new Error("agentId is required");
    }

    // Must provide at least one field to update
    if (name === undefined && plan === undefined && metadata === undefined) {
      throw new Error("At least one field to update is required (name, plan, or metadata)");
    }

    if (name !== undefined && !name.trim()) {
      throw new Error("name must not be empty");
    }

    const agent = services.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const updates: AgentMetadataUpdate = {};
    const updatedFields: string[] = [];

    if (name !== undefined) {
      updates.name = name.trim();
      updatedFields.push("name");
    }
    if (plan !== undefined) {
      updates.plan = plan;
      updatedFields.push("plan");
    }
    if (metadata !== undefined) {
      updates.metadata = metadata;
      updatedFields.push("metadata");
    }

    services.updateAgentMetadata(agentId, updates);

    return {
      success: true,
      agentId,
      updated: updatedFields,
    } satisfies UpdateMetadataResult;
  };
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register the agent metadata update extension method with the MAPAdapter.
 */
export function registerUpdateMetadataExtension(
  adapter: MAPAdapter,
  services: UpdateMetadataExtensionServices,
): void {
  adapter.registerExtension(
    "_macro/agents/update",
    createUpdateMetadataHandler(services),
  );
}

/**
 * Unregister the agent metadata update extension method.
 */
export function unregisterUpdateMetadataExtension(adapter: MAPAdapter): void {
  adapter.unregisterExtension("_macro/agents/update");
}

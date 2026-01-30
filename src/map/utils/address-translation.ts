/**
 * Address Translation Utilities
 *
 * Provides bidirectional translation between MAP addresses and
 * legacy MessageRouter channel format. Used during migration to
 * support both addressing schemes.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type {
  Address,
  AgentAddress,
  AgentsAddress,
  ScopeAddress,
  RoleAddress,
  BroadcastAddress,
  TaskAddress,
  AncestorsAddress,
  DescendantsAddress,
} from "../types.js";
import {
  isAgentAddress,
  isAgentsAddress,
  isScopeAddress,
  isRoleAddress,
  isBroadcastAddress,
  isTaskAddress,
  isAncestorsAddress,
  isDescendantsAddress,
  isParentAddress,
  isChildrenAddress,
  isSiblingsAddress,
} from "../types.js";
import type { ChannelType } from "../../router/types.js";
import type { AgentId, TaskId } from "../../store/types/index.js";

// =============================================================================
// Legacy Channel Types (for translation)
// =============================================================================

/**
 * Legacy channel format from MessageRouter.
 * Used for translation during migration.
 */
export interface LegacyChannel {
  type: ChannelType;
  /** Target ID (agent_id, task_id, or topic name) */
  target: string;
  /** Role name for role channels */
  role?: string;
  /** Coordinator ID for scoped role channels */
  coordinatorId?: AgentId;
  /** Broadcast scope */
  scope?: string;
}

// =============================================================================
// Address to Channel Translation
// =============================================================================

/**
 * Translate a MAP Address to legacy MessageRouter channel format.
 *
 * Used during migration to route messages through the existing
 * MessageRouter while accepting MAP-style addresses.
 *
 * @param address - MAP address to translate
 * @returns Legacy channel format
 * @throws Error if address type is not supported in legacy format
 */
export function addressToChannel(address: Address): LegacyChannel {
  // Direct agent addressing
  if (isAgentAddress(address)) {
    return {
      type: "agent",
      target: address.agent,
    };
  }

  // Multi-agent addressing (not supported in legacy)
  if (isAgentsAddress(address)) {
    throw new AddressTranslationError(
      "Multi-agent addressing not supported in legacy format",
      address
    );
  }

  // Scope addressing → topic channel
  if (isScopeAddress(address)) {
    return {
      type: "topic",
      target: address.scope,
    };
  }

  // Role addressing
  if (isRoleAddress(address)) {
    return {
      type: "role",
      target: address.role,
      role: address.role,
      coordinatorId: address.within,
    };
  }

  // Broadcast addressing
  if (isBroadcastAddress(address)) {
    return {
      type: "broadcast",
      target: "all",
    };
  }

  // Task addressing (macro-agent extension)
  if (isTaskAddress(address)) {
    return {
      type: "task",
      target: address.task,
    };
  }

  // Ancestors → lineage channel
  if (isAncestorsAddress(address)) {
    return {
      type: "lineage",
      target: "ancestors",
    };
  }

  // Descendants → subtree channel
  if (isDescendantsAddress(address)) {
    return {
      type: "subtree",
      target: "descendants",
    };
  }

  // New hierarchical types not supported in legacy
  if (isParentAddress(address)) {
    throw new AddressTranslationError(
      "Parent addressing not supported in legacy format",
      address
    );
  }

  if (isChildrenAddress(address)) {
    throw new AddressTranslationError(
      "Children addressing not supported in legacy format",
      address
    );
  }

  if (isSiblingsAddress(address)) {
    throw new AddressTranslationError(
      "Siblings addressing not supported in legacy format",
      address
    );
  }

  throw new AddressTranslationError("Unknown address type", address);
}

// =============================================================================
// Channel to Address Translation
// =============================================================================

/**
 * Translate a legacy MessageRouter channel to MAP address format.
 *
 * Used to migrate existing code to the new addressing scheme.
 *
 * @param channel - Legacy channel to translate
 * @returns MAP address
 * @throws Error if channel type is unknown
 */
export function channelToAddress(channel: LegacyChannel): Address {
  switch (channel.type) {
    case "agent":
      return { agent: channel.target as AgentId };

    case "task":
      return { task: channel.target as TaskId };

    case "topic":
      return { scope: channel.target };

    case "role":
      if (channel.coordinatorId) {
        return { role: channel.role ?? channel.target, within: channel.coordinatorId };
      }
      return { role: channel.role ?? channel.target };

    case "broadcast":
      // Check for scoped broadcast (e.g., "workers" → role: "worker")
      if (channel.scope && channel.scope !== "all") {
        // Convert plural scope to singular role: "workers" → "worker"
        const role = channel.scope.replace(/s$/, "");
        return { role };
      }
      return { broadcast: true };

    case "lineage":
      return { ancestors: true };

    case "subtree":
      return { descendants: true };

    default:
      throw new ChannelTranslationError(
        `Unknown channel type: ${channel.type}`,
        channel
      );
  }
}

// =============================================================================
// Legacy Compatibility Check
// =============================================================================

/**
 * Check if a MAP address can be translated to legacy channel format.
 *
 * Returns false for address types that were added in MAP and have
 * no equivalent in the legacy MessageRouter.
 *
 * @param address - Address to check
 * @returns true if address can be translated to legacy format
 */
export function isLegacyCompatible(address: Address): boolean {
  // Multi-agent addressing is new
  if (isAgentsAddress(address)) return false;

  // These hierarchical types are new
  if (isParentAddress(address)) return false;
  if (isChildrenAddress(address)) return false;
  if (isSiblingsAddress(address)) return false;

  // All other types have legacy equivalents
  return true;
}

/**
 * Get a list of address features that are not legacy compatible.
 *
 * @param address - Address to check
 * @returns Array of incompatible feature names, empty if fully compatible
 */
export function getLegacyIncompatibilities(address: Address): string[] {
  const incompatibilities: string[] = [];

  if (isAgentsAddress(address)) {
    incompatibilities.push("multi-agent addressing");
  }
  if (isParentAddress(address)) {
    incompatibilities.push("parent addressing");
  }
  if (isChildrenAddress(address)) {
    incompatibilities.push("children addressing");
  }
  if (isSiblingsAddress(address)) {
    incompatibilities.push("siblings addressing");
  }

  return incompatibilities;
}

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Error thrown when a MAP address cannot be translated to legacy format.
 */
export class AddressTranslationError extends Error {
  readonly address: Address;

  constructor(message: string, address: Address) {
    super(`${message}: ${JSON.stringify(address)}`);
    this.name = "AddressTranslationError";
    this.address = address;
  }
}

/**
 * Error thrown when a legacy channel cannot be translated to MAP format.
 */
export class ChannelTranslationError extends Error {
  readonly channel: LegacyChannel;

  constructor(message: string, channel: LegacyChannel) {
    super(`${message}: ${JSON.stringify(channel)}`);
    this.name = "ChannelTranslationError";
    this.channel = channel;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Attempt to translate an address, returning undefined if not compatible.
 *
 * @param address - Address to translate
 * @returns Legacy channel or undefined if not compatible
 */
export function tryAddressToChannel(
  address: Address
): LegacyChannel | undefined {
  if (!isLegacyCompatible(address)) {
    return undefined;
  }

  try {
    return addressToChannel(address);
  } catch {
    return undefined;
  }
}

/**
 * Create a mapping table entry for documentation/debugging.
 */
export interface AddressMapping {
  mapAddress: string;
  legacyChannel: string;
  notes?: string;
}

/**
 * Get the address mapping table for documentation.
 */
export function getAddressMappingTable(): AddressMapping[] {
  return [
    {
      mapAddress: '{ agent: "id" }',
      legacyChannel: '{ type: "agent", target: "id" }',
    },
    {
      mapAddress: '{ task: "id" }',
      legacyChannel: '{ type: "task", target: "id" }',
    },
    {
      mapAddress: '{ scope: "id" }',
      legacyChannel: '{ type: "topic", target: "id" }',
    },
    {
      mapAddress: '{ role: "worker" }',
      legacyChannel: '{ type: "role", role: "worker" }',
    },
    {
      mapAddress: '{ role: "worker", within: "scope" }',
      legacyChannel: '{ type: "role", role: "worker", coordinatorId: "scope" }',
    },
    {
      mapAddress: "{ broadcast: true }",
      legacyChannel: '{ type: "broadcast" }',
    },
    {
      mapAddress: "{ ancestors: true }",
      legacyChannel: '{ type: "lineage" }',
    },
    {
      mapAddress: "{ descendants: true }",
      legacyChannel: '{ type: "subtree" }',
    },
    {
      mapAddress: "{ parent: true }",
      legacyChannel: "N/A",
      notes: "Not supported in legacy format",
    },
    {
      mapAddress: "{ children: true }",
      legacyChannel: "N/A",
      notes: "Not supported in legacy format",
    },
    {
      mapAddress: "{ siblings: true }",
      legacyChannel: "N/A",
      notes: "Not supported in legacy format",
    },
    {
      mapAddress: '{ agents: ["a", "b"] }',
      legacyChannel: "N/A",
      notes: "Not supported in legacy format",
    },
  ];
}

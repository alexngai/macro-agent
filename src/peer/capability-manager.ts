/**
 * CapabilityManager - Manages peer capabilities for distributed hierarchy operations
 *
 * Provides explicit, scoped permission system for controlling what peers can do.
 * Inspired by AWS IAM, OAuth 2.0, and Erlang/OTP supervision patterns.
 *
 * Design principles:
 * - No implicit trust - all permissions must be explicitly granted
 * - Scoped grants - different capabilities for different patterns
 * - Bilateral agreement - both sides must consent to relationships
 */

import type {
  CapabilityGrant,
  CapabilityType,
  PeerCapabilities,
  GrantCapabilityOptions,
  TaskDelegationCapability,
  FederatedHierarchyCapability,
  EncapsulationCapability,
} from "./types.js";

/**
 * CapabilityManager interface
 */
export interface CapabilityManager {
  /**
   * Grant capabilities to a peer.
   * If the peer already has capabilities, new grants are merged with existing ones.
   * @param peerId - Peer to grant capabilities to
   * @param grants - Capabilities to grant
   * @param options - Optional expiration and issuer info
   * @returns The full capability set for the peer
   */
  grant(
    peerId: string,
    grants: CapabilityGrant[],
    options?: GrantCapabilityOptions
  ): PeerCapabilities;

  /**
   * Revoke capabilities from a peer.
   * @param peerId - Peer to revoke capabilities from
   * @param grantTypes - Specific types to revoke, or all if omitted
   */
  revoke(peerId: string, grantTypes?: CapabilityType[]): void;

  /**
   * Check if peer has required capability.
   * Checks both type and specific permissions within the grant.
   * @param peerId - Peer to check
   * @param required - Required capability (type and permissions)
   * @returns true if peer has the required capability
   */
  hasCapability(peerId: string, required: CapabilityGrant): boolean;

  /**
   * Get all capabilities for a peer.
   * Returns null if peer has no capabilities or capabilities have expired.
   * @param peerId - Peer to get capabilities for
   */
  getCapabilities(peerId: string): PeerCapabilities | null;

  /**
   * List all peers with any capabilities.
   * Excludes expired capabilities.
   */
  listAuthorizedPeers(): PeerCapabilities[];
}

/**
 * Create a CapabilityManager instance
 */
export function createCapabilityManager(): CapabilityManager {
  // In-memory capability storage
  const capabilities = new Map<string, PeerCapabilities>();

  /**
   * Check if capabilities have expired
   */
  function isExpired(caps: PeerCapabilities): boolean {
    if (caps.expiresAt === undefined) {
      return false;
    }
    return Date.now() > caps.expiresAt;
  }

  /**
   * Grant capabilities to a peer
   */
  function grant(
    peerId: string,
    grants: CapabilityGrant[],
    options?: GrantCapabilityOptions
  ): PeerCapabilities {
    const now = Date.now();
    const existing = capabilities.get(peerId);

    // Merge with existing grants if present and not expired
    let mergedGrants: CapabilityGrant[];
    if (existing && !isExpired(existing)) {
      // Create a map of existing grants by type
      const grantMap = new Map<CapabilityType, CapabilityGrant>();
      for (const g of existing.grants) {
        grantMap.set(g.type, g);
      }
      // Override with new grants
      for (const g of grants) {
        grantMap.set(g.type, g);
      }
      mergedGrants = Array.from(grantMap.values());
    } else {
      mergedGrants = [...grants];
    }

    const peerCaps: PeerCapabilities = {
      peerId,
      grants: mergedGrants,
      issuedAt: now,
      expiresAt: options?.expiresIn ? now + options.expiresIn : undefined,
      issuedBy: options?.issuedBy,
    };

    capabilities.set(peerId, peerCaps);
    return peerCaps;
  }

  /**
   * Revoke capabilities from a peer
   */
  function revoke(peerId: string, grantTypes?: CapabilityType[]): void {
    if (!grantTypes || grantTypes.length === 0) {
      // Revoke all capabilities
      capabilities.delete(peerId);
      return;
    }

    const existing = capabilities.get(peerId);
    if (!existing) {
      return;
    }

    // Filter out revoked grant types
    const typesToRevoke = new Set(grantTypes);
    const remainingGrants = existing.grants.filter(
      (g) => !typesToRevoke.has(g.type)
    );

    if (remainingGrants.length === 0) {
      capabilities.delete(peerId);
    } else {
      capabilities.set(peerId, {
        ...existing,
        grants: remainingGrants,
      });
    }
  }

  /**
   * Check if peer has required capability
   */
  function hasCapability(peerId: string, required: CapabilityGrant): boolean {
    const peerCaps = capabilities.get(peerId);
    if (!peerCaps || isExpired(peerCaps)) {
      return false;
    }

    // Find a grant of the same type
    const grant = peerCaps.grants.find((g) => g.type === required.type);
    if (!grant) {
      return false;
    }

    // Check type-specific permissions
    switch (required.type) {
      case "task-delegation":
        return checkTaskDelegation(
          grant as TaskDelegationCapability,
          required
        );

      case "federated-hierarchy":
        return checkFederatedHierarchy(
          grant as FederatedHierarchyCapability,
          required
        );

      case "encapsulation":
        return checkEncapsulation(
          grant as EncapsulationCapability,
          required
        );

      default:
        return false;
    }
  }

  /**
   * Check task delegation capability
   */
  function checkTaskDelegation(
    grant: TaskDelegationCapability,
    required: TaskDelegationCapability
  ): boolean {
    // Task delegation is granted if type matches
    // maxConcurrentTasks is a limit, not a requirement to check
    return true;
  }

  /**
   * Check federated hierarchy capability
   */
  function checkFederatedHierarchy(
    grant: FederatedHierarchyCapability,
    required: FederatedHierarchyCapability
  ): boolean {
    // Check each required permission
    if (required.canQueryAgents && !grant.canQueryAgents) {
      return false;
    }
    if (required.canMount && !grant.canMount) {
      return false;
    }
    if (required.canSubscribeStatus && !grant.canSubscribeStatus) {
      return false;
    }

    // Check agent ID restrictions if present
    if (grant.allowedAgentIds && required.allowedAgentIds) {
      const allowedSet = new Set(grant.allowedAgentIds);
      for (const agentId of required.allowedAgentIds) {
        if (!allowedSet.has(agentId)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check encapsulation capability
   */
  function checkEncapsulation(
    grant: EncapsulationCapability,
    required: EncapsulationCapability
  ): boolean {
    if (required.canActAsChild && !grant.canActAsChild) {
      return false;
    }
    if (required.canActAsParent && !grant.canActAsParent) {
      return false;
    }
    return true;
  }

  /**
   * Get capabilities for a peer
   */
  function getCapabilities(peerId: string): PeerCapabilities | null {
    const peerCaps = capabilities.get(peerId);
    if (!peerCaps || isExpired(peerCaps)) {
      return null;
    }
    return peerCaps;
  }

  /**
   * List all authorized peers
   */
  function listAuthorizedPeers(): PeerCapabilities[] {
    const result: PeerCapabilities[] = [];
    for (const peerCaps of capabilities.values()) {
      if (!isExpired(peerCaps)) {
        result.push(peerCaps);
      }
    }
    return result;
  }

  return {
    grant,
    revoke,
    hasCapability,
    getCapabilities,
    listAuthorizedPeers,
  };
}

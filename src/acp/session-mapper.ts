/**
 * SessionMapper - Maps ACP sessions to macro-agent agents
 *
 * Tracks the relationship between ACP session IDs and the macro-agent
 * agents they control. Supports:
 * - Default mapping to head manager on session creation
 * - Remapping via mount to control different agents
 * - Multiple concurrent sessions with independent mappings
 */

import type { AgentId } from "../store/types/index.js";
import type { ACPSessionId, SessionMapping } from "./types.js";
import { ACPError } from "./types.js";

export class SessionMapper {
  /** Map of ACP session ID to mapping info */
  private mappings: Map<ACPSessionId, SessionMapping> = new Map();

  /**
   * Register a new ACP session with its head manager
   *
   * @param acpSessionId - The ACP session ID
   * @param headManagerId - The head manager agent ID for this session
   * @returns The created mapping
   */
  createMapping(
    acpSessionId: ACPSessionId,
    headManagerId: AgentId
  ): SessionMapping {
    const now = Date.now();
    const mapping: SessionMapping = {
      acpSessionId,
      agentId: headManagerId,
      headManagerId,
      isMounted: false,
      createdAt: now,
      updatedAt: now,
    };

    this.mappings.set(acpSessionId, mapping);
    return mapping;
  }

  /**
   * Get the mapping for an ACP session
   *
   * @param acpSessionId - The ACP session ID
   * @returns The mapping or undefined if not found
   */
  getMapping(acpSessionId: ACPSessionId): SessionMapping | undefined {
    return this.mappings.get(acpSessionId);
  }

  /**
   * Get the mapping for an ACP session, throwing if not found
   *
   * @param acpSessionId - The ACP session ID
   * @returns The mapping
   * @throws ACPError if session not found
   */
  getMappingOrThrow(acpSessionId: ACPSessionId): SessionMapping {
    const mapping = this.mappings.get(acpSessionId);
    if (!mapping) {
      throw new ACPError(
        `ACP session not found: ${acpSessionId}`,
        "SESSION_NOT_FOUND",
        { acpSessionId }
      );
    }
    return mapping;
  }

  /**
   * Get the currently mapped agent ID for a session
   *
   * @param acpSessionId - The ACP session ID
   * @returns The agent ID or undefined if session not found
   */
  getAgentId(acpSessionId: ACPSessionId): AgentId | undefined {
    return this.mappings.get(acpSessionId)?.agentId;
  }

  /**
   * Get the currently mapped agent ID, throwing if not found
   *
   * @param acpSessionId - The ACP session ID
   * @returns The agent ID
   * @throws ACPError if session not found
   */
  getAgentIdOrThrow(acpSessionId: ACPSessionId): AgentId {
    const mapping = this.getMappingOrThrow(acpSessionId);
    return mapping.agentId;
  }

  /**
   * Get the head manager for a session
   *
   * @param acpSessionId - The ACP session ID
   * @returns The head manager agent ID or undefined
   */
  getHeadManagerId(acpSessionId: ACPSessionId): AgentId | undefined {
    return this.mappings.get(acpSessionId)?.headManagerId;
  }

  /**
   * Mount a session to a different agent
   *
   * This changes which agent receives prompts for this session.
   * The original head manager is preserved for unmounting.
   *
   * @param acpSessionId - The ACP session ID
   * @param agentId - The agent ID to mount to
   * @returns The previous agent ID
   * @throws ACPError if session not found
   */
  mount(acpSessionId: ACPSessionId, agentId: AgentId): AgentId {
    const mapping = this.getMappingOrThrow(acpSessionId);
    const previousAgentId = mapping.agentId;

    mapping.agentId = agentId;
    mapping.isMounted = agentId !== mapping.headManagerId;
    mapping.updatedAt = Date.now();

    return previousAgentId;
  }

  /**
   * Unmount a session back to its head manager
   *
   * @param acpSessionId - The ACP session ID
   * @returns The previous agent ID (the one that was mounted)
   * @throws ACPError if session not found
   */
  unmount(acpSessionId: ACPSessionId): AgentId {
    const mapping = this.getMappingOrThrow(acpSessionId);
    const previousAgentId = mapping.agentId;

    mapping.agentId = mapping.headManagerId;
    mapping.isMounted = false;
    mapping.updatedAt = Date.now();

    return previousAgentId;
  }

  /**
   * Check if a session is mounted to a non-head-manager agent
   *
   * @param acpSessionId - The ACP session ID
   * @returns True if mounted, false otherwise
   */
  isMounted(acpSessionId: ACPSessionId): boolean {
    return this.mappings.get(acpSessionId)?.isMounted ?? false;
  }

  /**
   * Remove a session mapping
   *
   * @param acpSessionId - The ACP session ID
   * @returns True if removed, false if not found
   */
  removeMapping(acpSessionId: ACPSessionId): boolean {
    return this.mappings.delete(acpSessionId);
  }

  /**
   * Get all session mappings
   *
   * @returns Array of all mappings
   */
  getAllMappings(): SessionMapping[] {
    return Array.from(this.mappings.values());
  }

  /**
   * Get all sessions mapped to a specific agent
   *
   * @param agentId - The agent ID to find sessions for
   * @returns Array of ACP session IDs mapped to this agent
   */
  getSessionsForAgent(agentId: AgentId): ACPSessionId[] {
    const sessions: ACPSessionId[] = [];
    for (const [sessionId, mapping] of this.mappings) {
      if (mapping.agentId === agentId) {
        sessions.push(sessionId);
      }
    }
    return sessions;
  }

  /**
   * Get the number of active session mappings
   */
  get size(): number {
    return this.mappings.size;
  }

  /**
   * Clear all session mappings
   */
  clear(): void {
    this.mappings.clear();
  }
}

/**
 * SessionMapper — In-memory ACP session ↔ agent mapping.
 *
 * Tracks which macro-agent agent each ACP session is currently
 * pointing at. Supports mount/unmount for switching between
 * the head manager and child agents within a single session.
 *
 * No persistence needed — mappings are ephemeral per-connection.
 *
 * @module acp/session-mapper
 */

import type { ACPSessionId, SessionMapping } from "./types.js";

export class SessionMapper {
  private readonly mappings = new Map<ACPSessionId, SessionMapping>();

  /**
   * Create a new session mapping.
   * Initially points at the head manager.
   */
  createMapping(acpSessionId: ACPSessionId, headManagerId: string): SessionMapping {
    const mapping: SessionMapping = {
      acpSessionId,
      agentId: headManagerId,
      headManagerId,
      isMounted: false,
      createdAt: Date.now(),
      isProcessing: false,
    };
    this.mappings.set(acpSessionId, mapping);
    return mapping;
  }

  /**
   * Get the full mapping for a session.
   */
  getMapping(acpSessionId: ACPSessionId): SessionMapping | undefined {
    return this.mappings.get(acpSessionId);
  }

  /**
   * Get the currently active agent ID for a session.
   */
  getAgentId(acpSessionId: ACPSessionId): string | undefined {
    return this.mappings.get(acpSessionId)?.agentId;
  }

  /**
   * Get the head manager ID for a session.
   */
  getHeadManagerId(acpSessionId: ACPSessionId): string | undefined {
    return this.mappings.get(acpSessionId)?.headManagerId;
  }

  /**
   * Mount a different agent onto this session.
   * Returns the previous agent ID (for logging/debugging).
   */
  mount(acpSessionId: ACPSessionId, agentId: string): string | undefined {
    const mapping = this.mappings.get(acpSessionId);
    if (!mapping) return undefined;

    const previousAgentId = mapping.agentId;
    mapping.agentId = agentId;
    mapping.isMounted = true;
    return previousAgentId;
  }

  /**
   * Unmount the current agent, restoring the head manager.
   * Returns the agent ID that was unmounted.
   */
  unmount(acpSessionId: ACPSessionId): string | undefined {
    const mapping = this.mappings.get(acpSessionId);
    if (!mapping) return undefined;

    const unmountedAgentId = mapping.agentId;
    mapping.agentId = mapping.headManagerId;
    mapping.isMounted = false;
    return unmountedAgentId;
  }

  /**
   * Remove a session mapping entirely.
   */
  removeMapping(acpSessionId: ACPSessionId): boolean {
    return this.mappings.delete(acpSessionId);
  }

  /**
   * Set the processing (prompting) status for a session.
   */
  setProcessing(acpSessionId: ACPSessionId, isProcessing: boolean): void {
    const mapping = this.mappings.get(acpSessionId);
    if (mapping) {
      mapping.isProcessing = isProcessing;
    }
  }

  /**
   * Get all active session mappings.
   */
  getAllMappings(): SessionMapping[] {
    return Array.from(this.mappings.values());
  }

  /**
   * Get all sessions currently pointing at a given agent ID.
   */
  getSessionsForAgent(agentId: string): SessionMapping[] {
    return Array.from(this.mappings.values()).filter(
      (m) => m.agentId === agentId,
    );
  }
}

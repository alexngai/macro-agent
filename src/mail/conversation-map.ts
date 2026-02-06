/**
 * ConversationMap — Agent-to-conversation tracking.
 *
 * Maps agents to their active conversations and manages peer
 * conversation indexing. In-memory, reconstructible from EventStore.
 */

import type { AgentId } from "../store/types/index.js";

export interface ConversationMap {
  /** Set the task conversation for an agent. */
  setAgentConversation(agentId: AgentId, conversationId: string): void;

  /** Get the task conversation for an agent. */
  getAgentConversation(agentId: AgentId): string | undefined;

  /** Remove an agent from the map. */
  removeAgent(agentId: AgentId): void;

  /** Set the session conversation for a head manager. */
  setSessionConversation(headManagerId: AgentId, conversationId: string): void;

  /** Get the session conversation for a head manager. */
  getSessionConversation(headManagerId: AgentId): string | undefined;

  /**
   * Get or create a peer conversation between two agents.
   * Uses sorted agent pair as key to ensure consistency.
   */
  getOrCreatePeerConversation(
    agentA: AgentId,
    agentB: AgentId,
    createFn: () => string
  ): string;

  /** Get the peer conversation ID for two agents (if exists). */
  getPeerConversation(agentA: AgentId, agentB: AgentId): string | undefined;

  /** Close all peer conversations for an agent. Returns closed conversation IDs. */
  closePeerConversationsFor(agentId: AgentId): string[];
}

/**
 * Create a ConversationMap instance.
 */
export function createConversationMap(): ConversationMap {
  // Agent ID → task conversation ID
  const agentConversations = new Map<AgentId, string>();

  // Head manager ID → session conversation ID
  const sessionConversations = new Map<AgentId, string>();

  // Sorted agent pair key → peer conversation ID
  const peerConversations = new Map<string, string>();

  function peerKey(a: AgentId, b: AgentId): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  return {
    setAgentConversation(agentId, conversationId) {
      agentConversations.set(agentId, conversationId);
    },

    getAgentConversation(agentId) {
      return agentConversations.get(agentId);
    },

    removeAgent(agentId) {
      agentConversations.delete(agentId);
    },

    setSessionConversation(headManagerId, conversationId) {
      sessionConversations.set(headManagerId, conversationId);
    },

    getSessionConversation(headManagerId) {
      return sessionConversations.get(headManagerId);
    },

    getOrCreatePeerConversation(agentA, agentB, createFn) {
      const key = peerKey(agentA, agentB);
      let convId = peerConversations.get(key);
      if (!convId) {
        convId = createFn();
        peerConversations.set(key, convId);
      }
      return convId;
    },

    getPeerConversation(agentA, agentB) {
      return peerConversations.get(peerKey(agentA, agentB));
    },

    closePeerConversationsFor(agentId) {
      const closed: string[] = [];
      for (const [key, convId] of peerConversations) {
        const [a, b] = key.split(':');
        if (a === agentId || b === agentId) {
          closed.push(convId);
          peerConversations.delete(key);
        }
      }
      return closed;
    },
  };
}

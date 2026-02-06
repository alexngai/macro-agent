/**
 * TurnRecorder — Hierarchy-aware conversation resolution and turn recording.
 *
 * Resolves which conversation a message belongs to based on the
 * relationship between sender and receiver:
 * - Parent→child or child→parent: child's task conversation
 * - Peers (no parent/child relationship): auto-created peer conversation
 *
 * @module mail/turn-recorder
 */

import type { AgentId } from "../store/types/index.js";
import type { EventStore } from "../store/event-store.js";
import type { MailService } from "./mail-service.js";
import type { ConversationMap } from "./conversation-map.js";
import type { TurnRecordInfo, TurnRecorderCallback } from "../router/types.js";

export interface TurnRecorderDeps {
  mailService: MailService;
  conversationMap: ConversationMap;
  eventStore: EventStore;
}

/**
 * Create a TurnRecorderCallback for use with MessageRouter.setTurnRecorder().
 *
 * Resolution algorithm:
 * 1. Get both agents from EventStore
 * 2. If parent→child or child→parent: use child's task conversation
 * 3. If peers: getOrCreatePeerConversation()
 * 4. Record turn with sourceType: 'intercepted'
 */
export function createTurnRecorder(deps: TurnRecorderDeps): TurnRecorderCallback {
  const { mailService, conversationMap, eventStore } = deps;

  return (info: TurnRecordInfo): void => {
    const { from, toAgent, content, messageId } = info;

    // Resolve conversation based on agent relationship
    const conversationId = resolveConversation(from, toAgent);
    if (!conversationId) return;

    // Record the turn — never fail core message routing
    try {
      mailService.recordTurn({
        conversationId,
        participant: from,
        contentType: "text",
        content,
        sourceType: "intercepted",
        sourceMessageId: messageId,
      });
    } catch (err) {
      console.warn(`[TurnRecorder] Failed to record turn: ${err}`);
    }
  };

  /**
   * Find the nearest common ancestor of two agents and return its conversation ID.
   * Lineage arrays are ordered root-to-parent: [grandparent, parent].
   */
  function findNearestCommonAncestorConversation(
    lineageA: AgentId[],
    lineageB: AgentId[]
  ): string | undefined {
    // Walk lineages from the end (nearest ancestor) to find the deepest shared ancestor
    const setB = new Set(lineageB);
    for (let i = lineageA.length - 1; i >= 0; i--) {
      if (setB.has(lineageA[i])) {
        // Found nearest common ancestor — look up its conversation
        return (
          conversationMap.getAgentConversation(lineageA[i]) ??
          conversationMap.getSessionConversation(lineageA[i])
        );
      }
    }
    return undefined;
  }

  function resolveConversation(from: AgentId, to: AgentId): string | null {
    const fromAgent = eventStore.getAgent(from);
    const toAgent = eventStore.getAgent(to);

    // If either agent doesn't exist, skip
    if (!fromAgent || !toAgent) return null;

    // Check parent→child relationship
    if (fromAgent.parent === to) {
      // from is a child of to — use from's task conversation
      return conversationMap.getAgentConversation(from) ?? null;
    }
    if (toAgent.parent === from) {
      // to is a child of from — use to's task conversation
      return conversationMap.getAgentConversation(to) ?? null;
    }

    // Peers — get or create peer conversation
    return conversationMap.getOrCreatePeerConversation(from, to, () => {
      // Find nearest common ancestor's conversation for tree structure
      const parentConversationId = findNearestCommonAncestorConversation(
        fromAgent.lineage,
        toAgent.lineage
      );

      const { conversationId } = mailService.createConversation({
        type: "peer",
        subject: `Peer: ${from} ↔ ${to}`,
        createdBy: from,
        parentConversationId,
      });
      mailService.joinConversation({
        conversationId,
        participantId: from,
        role: "worker",
      });
      mailService.joinConversation({
        conversationId,
        participantId: to,
        role: "worker",
      });
      return conversationId;
    });
  }
}

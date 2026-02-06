/**
 * EventStore-backed ThreadStore adapter.
 *
 * Minimal implementation — threads are a secondary feature.
 * Implements the MAP-compatible ThreadStore interface by:
 * - save() → emits a `thread` event with action `created`
 * - get()/list() → reads from EventStore materialized views
 * - turnCount computed from actual turns with matching threadId
 */

import type { EventStore } from "../../store/event-store.js";
import type { ThreadStore, ServerThread, MAPThreadFilter } from "./types.js";

export class EventStoreThreadStore implements ThreadStore {
  constructor(private readonly eventStore: EventStore) {}

  /**
   * Save a thread by emitting a thread event.
   */
  save(thread: ServerThread): void {
    this.eventStore.emit({
      type: "thread",
      source: { agent_id: thread.createdBy },
      payload: {
        action: "created",
        thread_id: thread.id,
        conversation_id: thread.conversationId,
        root_turn_id: thread.rootTurnId,
        subject: thread.subject,
        parent_thread_id: thread.parentThreadId,
      },
    });
  }

  /**
   * Get a thread by ID.
   * Scans the EventStore events since threads don't have a dedicated
   * lookup-by-ID query method on EventStore.
   */
  get(id: string): ServerThread | undefined {
    // Query thread events and find the matching one
    const events = this.eventStore.query({ type: "thread" });
    for (const event of events) {
      if (event.payload.thread_id === id) {
        const conversationId = event.payload.conversation_id as string;
        const turnCount = this.countTurnsForThread(conversationId, id);
        return {
          id: event.payload.thread_id as string,
          conversationId,
          parentThreadId: event.payload.parent_thread_id as string | undefined,
          subject: event.payload.subject as string | undefined,
          rootTurnId: event.payload.root_turn_id as string,
          turnCount,
          participantCount: 0,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          createdBy: event.source.agent_id ?? "unknown",
        };
      }
    }
    return undefined;
  }

  /**
   * List threads matching filter criteria.
   */
  list(filter: MAPThreadFilter): ServerThread[] {
    const events = this.eventStore.query({ type: "thread" });
    const threads: ServerThread[] = [];

    for (const event of events) {
      if (event.payload.action !== "created") continue;
      if (event.payload.conversation_id !== filter.conversationId) continue;
      if (
        filter.parentThreadId !== undefined &&
        event.payload.parent_thread_id !== filter.parentThreadId
      )
        continue;

      const threadId = event.payload.thread_id as string;
      const conversationId = event.payload.conversation_id as string;
      const turnCount = this.countTurnsForThread(conversationId, threadId);

      threads.push({
        id: threadId,
        conversationId,
        parentThreadId: event.payload.parent_thread_id as string | undefined,
        subject: event.payload.subject as string | undefined,
        rootTurnId: event.payload.root_turn_id as string,
        turnCount,
        participantCount: 0,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        createdBy: event.source.agent_id ?? "unknown",
      });
    }

    return threads;
  }

  /**
   * Count turns that belong to a specific thread.
   */
  private countTurnsForThread(conversationId: string, threadId: string): number {
    const turns = this.eventStore.listTurns({ conversationId, threadId });
    return turns.length;
  }

  /**
   * Delete a thread. Not supported — EventStore is append-only.
   */
  delete(_id: string): boolean {
    return false;
  }

  /**
   * Delete all threads for a conversation. Not supported.
   */
  deleteByConversation(_conversationId: string): number {
    return 0;
  }

  /**
   * Clear all threads. Not supported.
   */
  clear(): void {
    // No-op
  }
}

/**
 * ACP-over-MAP Bridge
 *
 * Bridges ACP streams that arrive over MAP messaging to the local
 * createMacroAgent() ACP handler. When a MAP client sends ACP envelopes
 * to a local agent (via mapClient.send(targetAgent, envelope)), this bridge
 * intercepts the delivery, creates a virtual Stream, and wires it to
 * AgentSideConnection + createMacroAgent().
 *
 * Each ACP stream (identified by streamId) gets its own in-memory stream
 * pair. The readable side is fed by inbound MAP messages. The writable side
 * is drained and forwarded back to the client via MAP messaging.
 *
 * @module map/acp-bridge
 */

import {
  AgentSideConnection,
  type Stream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import { createMacroAgent } from "../acp/macro-agent.js";
import type { MacroAgentSystemV2 } from "../boot-v2.js";

// =============================================================================
// Types
// =============================================================================

/** ACP envelope as sent over MAP (matches MAP SDK's ACPStreamConnection format) */
interface ACPEnvelope {
  acp: AnyMessage; // The actual ACP JSON-RPC message
  acpContext: {
    streamId: string;
    sessionId: string | null;
    direction: "client-to-agent" | "agent-to-client";
  };
}

/** Active ACP stream state */
interface ACPStreamState {
  streamId: string;
  /** Macro-agent's internal store id (the agent the stream targets). */
  peerAgentId: string;
  /** Push inbound ACP messages into the readable side */
  push: (message: AnyMessage) => void;
  /** Close the stream */
  close: () => void;
  /** The AgentSideConnection managing this stream */
  connection: AgentSideConnection;
}

// =============================================================================
// Bridge
// =============================================================================

export interface ACPBridge {
  /**
   * Handle a MAP message delivered to a local agent.
   * Returns true if the message was an ACP envelope and was handled.
   */
  handleDelivery(agentId: string, message: any): boolean;

  /**
   * Inspect which agent each open ACP stream is bound to. Used for
   * observability and routing tests — the binding is otherwise per-stream
   * in-memory state and not externally observable.
   */
  getStreamBindings(): Array<{ streamId: string; peerAgentId: string }>;

  /** Close all active streams */
  close(): void;
}

/**
 * Create an ACP-over-MAP bridge.
 *
 * @param system - The macro-agent system (for createMacroAgent)
 * @param sendToClient - Function to send MAP messages back to the originating client.
 *   Called with (recipientSessionId, payload) where the bridge builds the response envelope.
 */
export function createACPBridge(
  system: MacroAgentSystemV2,
  mapServer: any, // MAPServer instance — typed as any due to dynamic import
  /** Resolve local agent ID → MAP agent ID for response routing */
  resolveMapId?: (localAgentId: string) => string | undefined,
  /** Send a raw JSON-RPC notification to a specific client's WebSocket.
   *  This bypasses the MAPServer's subscription system for direct delivery. */
  sendRawToClient?: (clientSessionId: string, notification: any) => void,
): ACPBridge {
  const streams = new Map<string, ACPStreamState>();

  /**
   * Check if a MAP message payload is an ACP envelope.
   */
  function isACPEnvelope(payload: unknown): payload is ACPEnvelope {
    if (!payload || typeof payload !== "object") return false;
    const p = payload as Record<string, unknown>;
    return (
      p.acp !== undefined &&
      p.acpContext !== undefined &&
      typeof (p.acpContext as any)?.streamId === "string"
    );
  }

  /**
   * Create an in-memory stream pair for a new ACP stream.
   * Returns the Stream + a push function to feed inbound messages.
   */
  function createInMemoryStream(
    onOutbound: (msg: AnyMessage) => void,
  ): {
    stream: Stream;
    push: (msg: AnyMessage) => void;
    close: () => void;
  } {
    let readableController: ReadableStreamDefaultController<AnyMessage> | null =
      null;

    const readable = new ReadableStream<AnyMessage>({
      start(controller) {
        readableController = controller;
      },
    });

    const writable = new WritableStream<AnyMessage>({
      // Outbound ACP messages from the AgentSideConnection go here.
      // This captures JSON-RPC responses (to initialize, newSession, prompt, etc.)
      // and notifications (sessionUpdate) and routes them back via MAP.
      write(chunk) {
        onOutbound(chunk);
      },
    });

    return {
      stream: { readable, writable },
      push: (msg: AnyMessage) => {
        try {
          readableController?.enqueue(msg);
        } catch {
          // Stream may be closed
        }
      },
      close: () => {
        try {
          readableController?.close();
        } catch {
          // Already closed
        }
      },
    };
  }

  /**
   * Get or create an ACP stream for the given streamId + agentId.
   */
  function getOrCreateStream(
    streamId: string,
    agentId: string,
    sourceSessionId: string,
  ): ACPStreamState {
    const existing = streams.get(streamId);
    if (existing) return existing;

    /**
     * Route an outbound ACP message back to the client via MAP messaging.
     * This is called for both JSON-RPC responses AND notifications
     * written to the stream's writable side by AgentSideConnection.
     */
    const sendToClient = (acpMessage: AnyMessage) => {
      const envelope: ACPEnvelope = {
        acp: acpMessage,
        acpContext: {
          streamId,
          sessionId: null, // Will be populated if available
          direction: "agent-to-client",
        },
      };

      try {
        const mapAgentId = resolveMapId?.(agentId) ?? agentId;

        const message = {
          id: `acp-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          from: { agent: mapAgentId },
          to: { agent: sourceSessionId },
          payload: envelope,
          timestamp: Date.now(),
        };

        const event = {
          type: "message_delivered",
          data: { message, agentId: sourceSessionId },
          source: { agentId: mapAgentId },
          id: message.id,
          timestamp: Date.now(),
        };

        if (sendRawToClient) {
          // Direct delivery to the requesting client
          sendRawToClient(sourceSessionId, { params: { event } });
        }

        // Also emit via eventBus so other MAP clients (observers) can see
        // agent activity via their subscriptions. This enables the TUI's
        // "observed" stream mode for multi-agent trajectory visibility.
        try {
          mapServer.eventBus.emit(event);
        } catch {
          // Best effort — eventBus emit may fail
        }
      } catch (err) {
        console.warn(
          `[acp-bridge] Failed to send response to client: ${(err as Error).message}`,
        );
      }
    };

    const { stream, push, close } = createInMemoryStream(sendToClient);

    // Create the AgentSideConnection.
    // All outbound messages (responses + notifications) go through the
    // writable side of the stream, which calls sendToClient above.
    //
    // Bind the MacroAgent to this stream's target agent so `session/new`
    // creates a session for the agent the MAP stream was opened against,
    // not whichever head manager happens to share the same cwd.
    const conn = new AgentSideConnection(
      (agentConn) =>
        createMacroAgent(agentConn, {
          system,
          initConfig: { targetAgentId: agentId },
        }),
      stream,
    );

    const state: ACPStreamState = {
      streamId,
      peerAgentId: agentId,
      push,
      close,
      connection: conn,
    };

    streams.set(streamId, state);
    return state;
  }

  return {
    handleDelivery(agentId: string, message: any): boolean {
      const payload = message?.payload;
      if (!isACPEnvelope(payload)) return false;

      const { acp, acpContext } = payload;
      if (acpContext.direction !== "client-to-agent") return false;

      const streamId = acpContext.streamId;

      // Get the source client/agent ID to route responses back.
      // The message 'from' field is an Address object like { agent: "id" } or a string.
      const fromField = message?.from;
      const sourceSessionId =
        (typeof fromField === "string" ? fromField : fromField?.agent ?? fromField?.id) ??
        message?.sender ?? "";


      // Get or create the ACP stream
      const streamState = getOrCreateStream(
        streamId,
        agentId,
        sourceSessionId,
      );

      // Push the ACP message into the stream's readable side
      streamState.push(acp);

      return true;
    },

    getStreamBindings(): Array<{ streamId: string; peerAgentId: string }> {
      return Array.from(streams.values()).map((s) => ({
        streamId: s.streamId,
        peerAgentId: s.peerAgentId,
      }));
    },

    close(): void {
      for (const state of streams.values()) {
        state.close();
      }
      streams.clear();
    },
  };
}

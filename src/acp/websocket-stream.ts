/**
 * WebSocket Stream Adapter for ACP
 *
 * Adapts a WebSocket connection to the ACP SDK's Stream interface.
 * Unlike ndJsonStream (used for stdio), this doesn't need newline delimiters
 * since WebSocket already frames messages.
 */

import type { WebSocket } from "ws";

// Re-export the Stream type from the SDK for consumers
export type { Stream } from "@agentclientprotocol/sdk";

// Import the actual Stream type from the SDK
import type { Stream } from "@agentclientprotocol/sdk";

// The ACP SDK uses AnyMessage which is a JSON-RPC message type
// We use a generic record type that's compatible
type AnyMessage = Record<string, unknown>;

/**
 * Create an ACP Stream from a WebSocket connection.
 *
 * This adapts a WebSocket to the bidirectional Stream interface expected
 * by AgentSideConnection. Each WebSocket message is a complete JSON-RPC
 * message (no newline delimiters needed).
 *
 * @param ws - The WebSocket connection to adapt
 * @returns A Stream for bidirectional ACP communication
 */
export function webSocketStream(ws: WebSocket): Stream {
  // Track if the stream has been closed to prevent double-close
  let isClosed = false;

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      // Handle incoming messages
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (isClosed) return;

        try {
          const text =
            data instanceof Buffer
              ? data.toString("utf-8")
              : Buffer.from(data as ArrayBuffer).toString("utf-8");

          const message = JSON.parse(text) as AnyMessage;
          controller.enqueue(message);
        } catch (err) {
          console.error("[websocket-stream] Failed to parse message:", err);
          // Don't close the stream on parse errors - just log and continue
        }
      });

      // Handle connection close
      ws.on("close", () => {
        if (!isClosed) {
          isClosed = true;
          controller.close();
        }
      });

      // Handle errors
      ws.on("error", (err) => {
        if (!isClosed) {
          isClosed = true;
          controller.error(err);
        }
      });
    },

    cancel() {
      // Called when the readable stream is cancelled
      if (!isClosed) {
        isClosed = true;
        ws.close(1000, "Stream cancelled");
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(message) {
      return new Promise<void>((resolve, reject) => {
        if (ws.readyState !== ws.OPEN) {
          // Silently drop messages if connection is not open
          // This can happen during shutdown
          resolve();
          return;
        }

        try {
          const data = JSON.stringify(message);
          ws.send(data, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        } catch (err) {
          reject(err);
        }
      });
    },

    close() {
      // Close the WebSocket when the writable stream is closed
      if (ws.readyState === ws.OPEN) {
        ws.close(1000, "Stream closed");
      }
      return Promise.resolve();
    },

    abort(reason) {
      // Abort the connection
      if (ws.readyState === ws.OPEN) {
        ws.close(1011, String(reason));
      }
      return Promise.resolve();
    },
  });

  // Cast to Stream - the SDK's Stream type uses AnyMessage which is compatible
  // with our Record<string, unknown> type
  return { readable, writable } as unknown as Stream;
}

/**
 * Check if a WebSocket is in a state that can receive messages
 */
export function isWebSocketOpen(ws: WebSocket): boolean {
  return ws.readyState === ws.OPEN;
}

/**
 * Check if a WebSocket is connecting
 */
export function isWebSocketConnecting(ws: WebSocket): boolean {
  return ws.readyState === ws.CONNECTING;
}

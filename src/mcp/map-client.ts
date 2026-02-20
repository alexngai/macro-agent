/**
 * Thin MAP Client
 *
 * Ephemeral WebSocket client for MCP subprocesses to call MAP extension
 * methods on the main server. Each call opens a connection, performs the
 * MAP handshake, sends a single RPC, and disconnects.
 *
 * Uses raw WebSocket + JSON-RPC — not the full MAP ClientConnection SDK,
 * since the SDK's capability negotiation and subscription management
 * overhead is unnecessary for single-RPC ephemeral calls.
 */

import WebSocket from "ws";

// =============================================================================
// Types
// =============================================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface MapCallOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Server token for authentication (appended as query param on WebSocket URL) */
  serverToken?: string;
}

export class MapCallError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "MapCallError";
    this.code = code;
    this.data = data;
  }
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Make a single MAP extension RPC call via ephemeral WebSocket.
 *
 * 1. Opens WebSocket to the MAP endpoint
 * 2. Sends `map/connect` handshake
 * 3. Sends the RPC request
 * 4. Awaits the response
 * 5. Closes the WebSocket
 *
 * @param serverUrl - HTTP URL of the macro-agent server (e.g., "http://localhost:3001")
 * @param method - MAP extension method (e.g., "_macro/mcp/spawn_agent")
 * @param params - Method parameters (includes context)
 * @param options - Timeout and other options
 * @returns The RPC result
 */
export async function mapCall<T = unknown>(
  serverUrl: string,
  method: string,
  params?: unknown,
  options?: MapCallOptions
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 30000;
  let wsUrl = serverUrl.replace(/^http/, "ws") + "/map";
  if (options?.serverToken) {
    wsUrl += `?token=${encodeURIComponent(options.serverToken)}`;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let nextId = 1;
    let handshakeCompleted = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new MapCallError(-32000, `MAP call timed out after ${timeoutMs}ms: ${method}`));
      }
    }, timeoutMs);

    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      // Step 1: Send MAP handshake
      const connectRequest: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: nextId++,
        method: "map/connect",
        params: {
          participantType: "client",
          identity: `mcp-bridge-${Date.now()}`,
        },
      };
      ws.send(JSON.stringify(connectRequest));
    });

    ws.on("message", (data) => {
      if (settled) return;

      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // Ignore non-JSON messages
      }

      if (!handshakeCompleted) {
        // This should be the map/connect response
        if (msg.error) {
          settled = true;
          clearTimeout(timeout);
          ws.close();
          reject(new MapCallError(msg.error.code, `MAP handshake failed: ${msg.error.message}`, msg.error.data));
          return;
        }

        handshakeCompleted = true;

        // Step 2: Send the actual RPC request
        const rpcRequest: JsonRpcRequest = {
          jsonrpc: "2.0",
          id: nextId++,
          method,
          params,
        };
        ws.send(JSON.stringify(rpcRequest));
        return;
      }

      // This is the RPC response
      settled = true;
      clearTimeout(timeout);
      ws.close();

      if (msg.error) {
        reject(new MapCallError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        resolve(msg.result as T);
      }
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new MapCallError(-32000, `MAP WebSocket error: ${err.message}`));
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new MapCallError(-32000, "MAP WebSocket closed unexpectedly"));
      }
    });
  });
}

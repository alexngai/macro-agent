/**
 * Workspace Execution Handler
 *
 * Bridge between OpenHive's workspace.execute MAP messages and
 * macro-agent's MacroAgentBackend. Receives workspace tasks from
 * OpenHive, spawns analyst agents, and sends results back.
 *
 * Registered as a MAP notification handler on the swarm's inbound
 * WebSocket connection to the OpenHive hub.
 *
 * Protocol:
 *   Hive → Swarm: x-openhive/learning.workspace.execute
 *     { request_id, prompt, cwd, system_context, timeout }
 *   Swarm → Hive: x-openhive/learning.workspace.result
 *     { request_id, success, output, structured, duration_ms }
 */

import type { MacroAgentBackend } from "./macro-agent-backend.js";
import type { CognitiveAgentSpawnConfig } from "./types.js";

export interface WorkspaceHandlerDeps {
  backend: MacroAgentBackend;
  /** Send a JSON-RPC notification back to the hub */
  sendToHub: (message: object) => void;
}

export interface WorkspaceExecuteParams {
  request_id: string;
  prompt: string;
  cwd: string;
  system_context?: string;
  timeout?: number;
}

/**
 * Handle an incoming workspace.execute request from OpenHive.
 *
 * Spawns an analyst agent via MacroAgentBackend, waits for completion,
 * then sends the result back to the hub.
 */
export async function handleWorkspaceExecute(
  deps: WorkspaceHandlerDeps,
  params: WorkspaceExecuteParams,
): Promise<void> {
  const { backend, sendToHub } = deps;
  const { request_id, prompt, cwd, system_context, timeout } = params;
  const startTime = Date.now();

  try {
    // Build spawn config from the workspace task
    const spawnConfig: CognitiveAgentSpawnConfig = {
      agentType: "claude-code",
      task: {
        description: prompt,
        context: { workspace_cwd: cwd },
      },
      systemPromptAdditions: system_context,
      cwd,
      timeout: timeout || 300_000,
    };

    // Spawn analyst agent — this runs to completion
    const session = await backend.spawn(spawnConfig);

    // Wait for the session to complete (backend runs it in background)
    // Poll until session state changes from "running"
    const deadline = Date.now() + (timeout || 300_000);
    while (Date.now() < deadline) {
      const current = await backend.getSession(session.id);
      if (!current || current.state !== "running") break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const finalSession = await backend.getSession(session.id);
    const durationMs = Date.now() - startTime;

    if (!finalSession || finalSession.state === "running") {
      // Timed out
      await backend.terminate(session.id).catch(() => {});
      sendToHub({
        jsonrpc: "2.0",
        method: "x-openhive/learning.workspace.result",
        params: {
          request_id,
          success: false,
          output: "",
          error: "Workspace execution timed out",
          duration_ms: durationMs,
        },
      });
      return;
    }

    // Collect output — read from workspace output directory if available
    let output = "";
    let structured: unknown = undefined;

    if (finalSession.state === "completed") {
      // The agent should have written output files to cwd/output/
      try {
        const fs = await import("fs");
        const path = await import("path");
        const outputDir = path.join(cwd, "output");
        if (fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir).filter((f) => f.endsWith(".json"));
          if (files.length > 0) {
            const content = fs.readFileSync(path.join(outputDir, files[0]), "utf-8");
            output = content;
            try {
              structured = JSON.parse(content);
            } catch {
              /* not valid JSON, use raw text */
            }
          }
        }
      } catch {
        /* output collection is best-effort */
      }

      // Fallback: use session result
      if (!output && finalSession.result) {
        output = typeof finalSession.result === "string"
          ? finalSession.result
          : JSON.stringify(finalSession.result);
        structured = finalSession.result;
      }
    }

    sendToHub({
      jsonrpc: "2.0",
      method: "x-openhive/learning.workspace.result",
      params: {
        request_id,
        success: finalSession.state === "completed",
        output,
        structured,
        error: finalSession.error,
        duration_ms: durationMs,
      },
    });
  } catch (err) {
    sendToHub({
      jsonrpc: "2.0",
      method: "x-openhive/learning.workspace.result",
      params: {
        request_id,
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startTime,
      },
    });
  }
}

/**
 * Check if a MAP notification is a workspace.execute request.
 */
export function isWorkspaceExecuteMessage(
  msg: { method?: string },
): msg is { method: "x-openhive/learning.workspace.execute"; params: WorkspaceExecuteParams } {
  return msg.method === "x-openhive/learning.workspace.execute";
}

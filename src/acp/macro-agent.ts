/**
 * MacroAgent — ACP Agent implementation for macro-agent.
 *
 * Bridges the ACP protocol to macro-agent's V2 services:
 * - session/new → agentManager.getOrCreateHeadManager()
 * - session/prompt → agentManager.prompt() with streaming
 * - Extension methods → spawn, mount, fork, hierarchy, tasks, etc.
 *
 * @module acp/macro-agent
 */

import type {
  Agent as ACPAgent,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ExtendedSessionUpdate, PermissionRequestUpdate } from "acp-factory";
import type { AgentManager } from "../agent/agent-manager.js";
import type { InboxAdapter, TasksAdapter } from "../adapters/types.js";
import type { MacroAgentSystemV2 } from "../boot-v2.js";
import { SessionMapper } from "./session-mapper.js";
import { ACPError } from "./types.js";
import type { MacroAgentInitConfig } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

export interface MacroAgentConfig {
  system: MacroAgentSystemV2;
  initConfig?: MacroAgentInitConfig;
}

// ─────────────────────────────────────────────────────────────────
// Extension method names
// ─────────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [
  "_macro/spawnAgent",
  "_macro/getHierarchy",
  "_macro/getTask",
  "_macro/mountAgent",
  "_macro/forkAgent",
  "_macro/resume",
  "_macro/getHistory",
  "_macro/getModels",
  "_macro/respondToPermission",
  "_macro/cancelPermission",
  "_macro/setPermissionMode",
] as const;

const STUBBED_PEER_EXTENSIONS = [
  "_macro/listPeers",
  "_macro/getPeer",
  "_macro/sendToPeer",
  "_macro/subscribePeer",
  "_macro/unsubscribePeer",
  "_macro/getCapabilities",
  "_macro/setCapabilities",
  "_macro/negotiateCapabilities",
] as const;

type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];
type StubbedExtension = (typeof STUBBED_PEER_EXTENSIONS)[number];

// ─────────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────────

/** ACP-standard session update type discriminants. */
const ACP_SESSION_UPDATE_TYPES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
]);

/**
 * Type guard: returns true if the update is an ACP-standard SessionUpdate
 * (not an acp-factory extension like PermissionRequestUpdate or CompactionUpdate).
 */
function isACPSessionUpdate(
  update: ExtendedSessionUpdate,
): update is SessionUpdate {
  return (
    "sessionUpdate" in update &&
    ACP_SESSION_UPDATE_TYPES.has(
      (update as { sessionUpdate: string }).sessionUpdate,
    )
  );
}

/**
 * Type guard: returns true if the update is a PermissionRequestUpdate
 * from acp-factory (emitted when the agent is in interactive permission mode).
 */
function isPermissionRequestUpdate(
  update: ExtendedSessionUpdate,
): update is PermissionRequestUpdate {
  return (
    "sessionUpdate" in update &&
    (update as { sessionUpdate: string }).sessionUpdate === "permission_request"
  );
}

// ─────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────

/**
 * Create a macro-agent ACP handler for an AgentSideConnection.
 *
 * Usage:
 * ```ts
 * new AgentSideConnection(
 *   (conn) => createMacroAgent(conn, { system }),
 *   stream,
 * );
 * ```
 */
export function createMacroAgent(
  connection: AgentSideConnection,
  config: MacroAgentConfig,
): ACPAgent {
  const { system, initConfig } = config;
  const { agentManager, inboxAdapter, tasksAdapter } = system;
  const sessionMapper = new SessionMapper();

  const defaultCwd = initConfig?.defaultCwd ?? process.cwd();

  // ── Helpers ──────────────────────────────────────────────────

  function getSessionOrThrow(sessionId: string) {
    const mapping = sessionMapper.getMapping(sessionId);
    if (!mapping) {
      throw RequestError.invalidParams(
        { sessionId },
        `Session not found: ${sessionId}`,
      );
    }
    return mapping;
  }

  // ── Extension dispatcher ────────────────────────────────────

  async function handleExtension(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Check if it's a stubbed peer method
    if (
      (STUBBED_PEER_EXTENSIONS as readonly string[]).includes(method)
    ) {
      throw new ACPError(
        `Peer manager not available: ${method}`,
        "NO_PEER_MANAGER",
        { method },
      );
    }

    switch (method as SupportedExtension) {
      case "_macro/spawnAgent": {
        const task = params.task as string;
        if (!task) throw RequestError.invalidParams(params, "task is required");
        const spawned = await agentManager.spawn({
          task,
          parent: params.parent as string | undefined,
          cwd: (params.cwd as string) ?? defaultCwd,
          role: params.role as string | undefined,
          permissionMode: params.permissionMode as "auto-approve" | undefined,
        });
        return {
          agentId: spawned.id,
          sessionId: spawned.session_id,
          role: spawned.agent.role,
          state: spawned.agent.state,
        };
      }

      case "_macro/getHierarchy": {
        const agentId = params.agentId as string;
        if (!agentId) throw RequestError.invalidParams(params, "agentId is required");
        const hierarchy = agentManager.getHierarchy(agentId, {
          depth: params.depth as number | undefined,
        });
        return { hierarchy: hierarchy ?? null } as Record<string, unknown>;
      }

      case "_macro/getTask": {
        const taskId = params.taskId as string;
        if (!taskId) throw RequestError.invalidParams(params, "taskId is required");
        const task = await tasksAdapter.getTask(taskId);
        return { task } as Record<string, unknown>;
      }

      case "_macro/mountAgent": {
        const sessionId = params.sessionId as string;
        const agentId = params.agentId as string;
        if (!sessionId || !agentId) {
          throw RequestError.invalidParams(
            params,
            "sessionId and agentId are required",
          );
        }

        // Verify the agent exists
        const agent = agentManager.get(agentId);
        if (!agent) {
          throw new ACPError(
            `Agent not found: ${agentId}`,
            "AGENT_NOT_FOUND",
            { agentId },
          );
        }

        const previousAgentId = sessionMapper.mount(sessionId, agentId);
        return {
          mounted: true,
          agentId,
          previousAgentId: previousAgentId ?? null,
        };
      }

      case "_macro/forkAgent": {
        const sourceAgentId = params.sourceAgentId as string;
        if (!sourceAgentId) {
          throw RequestError.invalidParams(params, "sourceAgentId is required");
        }
        try {
          const forked = await agentManager.forkAgent(sourceAgentId, {
            name: params.name as string | undefined,
            prompt: params.prompt as string | undefined,
            cwd: params.cwd as string | undefined,
          });
          return {
            agentId: forked.id,
            sessionId: forked.session_id,
          };
        } catch (err) {
          throw new ACPError(
            `Fork failed: ${(err as Error).message}`,
            "FORK_FAILED",
            { sourceAgentId },
          );
        }
      }

      case "_macro/resume": {
        const agentId = params.agentId as string;
        if (!agentId) throw RequestError.invalidParams(params, "agentId is required");
        const resumed = await agentManager.resume(agentId);
        return {
          agentId: resumed.id,
          sessionId: resumed.session_id,
          state: resumed.agent.state,
        };
      }

      case "_macro/getHistory": {
        const agentId = params.agentId as string;
        if (!agentId) throw RequestError.invalidParams(params, "agentId is required");

        if (params.threadTag) {
          const thread = await inboxAdapter.readThread(
            params.threadTag as string,
            params.scope as string | undefined,
          );
          return { messages: thread };
        }

        const messages = await inboxAdapter.checkInbox(agentId, {
          limit: params.limit as number | undefined,
        });
        return { messages };
      }

      case "_macro/getModels": {
        // Models are not centrally tracked; return empty
        return { models: [] };
      }

      case "_macro/respondToPermission": {
        const agentId = params.agentId as string;
        const requestId = params.requestId as string;
        const optionId = params.optionId as string;
        if (!agentId || !requestId || !optionId) {
          throw RequestError.invalidParams(
            params,
            "agentId, requestId, and optionId are required",
          );
        }
        const success = agentManager.respondToPermission(
          agentId,
          requestId,
          optionId,
        );
        return { success };
      }

      case "_macro/cancelPermission": {
        const agentId = params.agentId as string;
        const requestId = params.requestId as string;
        if (!agentId || !requestId) {
          throw RequestError.invalidParams(
            params,
            "agentId and requestId are required",
          );
        }
        const success = agentManager.cancelPermission(agentId, requestId);
        return { success };
      }

      case "_macro/setPermissionMode": {
        const agentId = params.agentId as string;
        const mode = params.mode as string;
        if (!agentId || !mode) {
          throw RequestError.invalidParams(
            params,
            "agentId and mode are required",
          );
        }
        const success = agentManager.setPermissionMode(
          agentId,
          mode as "auto-approve",
        );
        return { success };
      }

      default:
        throw new ACPError(
          `Unknown extension: ${method}`,
          "INVALID_EXTENSION",
          { method },
        );
    }
  }

  // ── ACP Agent Implementation ────────────────────────────────

  const agent: ACPAgent = {
    async initialize(
      _params: InitializeRequest,
    ): Promise<InitializeResponse> {
      return {
        protocolVersion: 1,
        agentInfo: {
          name: "macro-agent",
          version: "2.0.0",
        },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            resume: {},
          },
        },
        extensions: [
          ...SUPPORTED_EXTENSIONS.map((name) => ({
            name,
            description: `macro-agent extension: ${name}`,
          })),
          ...STUBBED_PEER_EXTENSIONS.map((name) => ({
            name,
            description: `Peer extension (stub): ${name}`,
          })),
        ],
      } as InitializeResponse;
    },

    async newSession(
      params: NewSessionRequest,
    ): Promise<NewSessionResponse> {
      const cwd = params.cwd ?? defaultCwd;

      // Get or create a head manager for this workspace
      const headManager = await agentManager.getOrCreateHeadManager({
        cwd,
      });

      // Create session mapping
      const mapping = sessionMapper.createMapping(
        headManager.session_id,
        headManager.id,
      );

      return {
        sessionId: mapping.acpSessionId,
      };
    },

    async loadSession(
      params: LoadSessionRequest,
    ): Promise<LoadSessionResponse> {
      const sessionId = params.sessionId;

      // Check if we already have a mapping for this session
      let mapping = sessionMapper.getMapping(sessionId);
      if (mapping) {
        return {};
      }

      // Try to resume the agent associated with this session
      // The session ID might be an agent ID in our system
      const agent = agentManager.get(sessionId);
      if (agent) {
        const resumed = await agentManager.resume(sessionId);
        mapping = sessionMapper.createMapping(
          resumed.session_id,
          resumed.id,
        );
        return {};
      }

      throw RequestError.invalidParams(
        { sessionId },
        `Session not found: ${sessionId}`,
      );
    },

    async authenticate(
      _params: AuthenticateRequest,
    ): Promise<AuthenticateResponse> {
      // No-op: macro-agent does not require authentication
      return {};
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const mapping = getSessionOrThrow(params.sessionId);
      const agentId = mapping.agentId;

      // Extract text content from prompt blocks
      const textParts: string[] = [];
      for (const block of params.prompt) {
        if ("text" in block && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      const message = textParts.join("\n") || "";

      sessionMapper.setProcessing(params.sessionId, true);

      try {
        // Stream updates from agentManager.prompt()
        const updates = agentManager.prompt(agentId, message);

        for await (const update of updates) {

          // Handle permission requests from the underlying agent.
          // When the agent is in interactive mode, it yields
          // PermissionRequestUpdate objects instead of auto-approving.
          // We forward these to the client via AgentSideConnection's
          // requestPermission() method (JSON-RPC agent→client request).
          if (isPermissionRequestUpdate(update)) {
            try {
              const permResponse = await connection.requestPermission({
                sessionId: params.sessionId,
                toolCall: {
                  toolCallId: update.toolCall.toolCallId,
                  title: update.toolCall.title,
                  status: update.toolCall.status as any,
                  rawInput: update.toolCall.rawInput,
                },
                options: update.options,
              });
              // Relay the permission response back to the agent.
              // ACP response: { outcome: { outcome: "selected", optionId } | { outcome: "cancelled" } }
              const outcome = permResponse?.outcome;
              if (outcome) {
                if (outcome.outcome === "selected" && "optionId" in outcome) {
                  agentManager.respondToPermission(
                    agentId,
                    update.requestId,
                    outcome.optionId,
                  );
                } else if (outcome.outcome === "cancelled") {
                  agentManager.cancelPermission(agentId, update.requestId);
                }
              }
            } catch {
              // If the permission request fails (e.g., client disconnected),
              // cancel it so the agent doesn't hang.
              try {
                agentManager.cancelPermission(agentId, update.requestId);
              } catch {
                // Best effort
              }
            }
            continue;
          }

          // Forward each update to the client as a session notification.
          // Only forward ACP-compatible SessionUpdate types; skip
          // acp-factory extended types like CompactionUpdate.
          if ("sessionUpdate" in update && isACPSessionUpdate(update)) {
            const notification: SessionNotification = {
              sessionId: params.sessionId,
              update,
            };
            await connection.sessionUpdate(notification);
          }
        }

        return { stopReason: "end_turn" };
      } catch (err) {
        // If prompt fails, still return a valid response
        return { stopReason: "cancelled" };
      } finally {
        sessionMapper.setProcessing(params.sessionId, false);
      }
    },

    async cancel(params: CancelNotification): Promise<void> {
      const mapping = sessionMapper.getMapping(params.sessionId);
      if (!mapping) return;

      try {
        await agentManager.terminate(mapping.agentId, "cancelled");
      } catch {
        // Best effort cancellation
      }
    },

    async extMethod(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      return handleExtension(method, params);
    },
  };

  return agent;
}

/**
 * Get the SessionMapper instance from a macro-agent.
 * Exposed for testing and for the WebSocket server.
 */
export { SessionMapper };

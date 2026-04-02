#!/usr/bin/env node
/**
 * MCP Server Entry Point (V2)
 *
 * Runs as a subprocess inside each spawned agent. Provides macro-agent
 * orchestration tools via MCP over stdio.
 *
 * Lifecycle operations (spawn, terminate) go through the control socket
 * to the main macro-agent process. Query operations read from the shared
 * AgentStore (SQLite WAL). Messaging goes through agent-inbox IPC.
 *
 * Environment variables (set by AgentManagerV2.buildMcpServerConfig):
 *   MACRO_AGENT_ID             — ID of the calling agent
 *   MACRO_PARENT_ID            — Parent agent ID
 *   MACRO_TASK_ID              — Task ID
 *   MACRO_AGENT_CWD            — Working directory
 *   MACRO_PERMISSION_MODE      — Permission mode
 *   MACRO_STREAM_ID            — Workspace stream ID
 *   MACRO_CONTROL_SOCKET_PATH  — Control socket for lifecycle RPC
 *   INBOX_SOCKET_PATH          — agent-inbox IPC socket
 *
 * @module cli/mcp
 */

import { AgentStore } from "../agent/agent-store.js";
import { InboxClientAdapter } from "../adapters/inbox-client-adapter.js";
import { DefaultTasksAdapter } from "../adapters/tasks-adapter.js";
import { DefaultRoleRegistry } from "../roles/registry.js";
import { ControlClient } from "../control/control-client.js";
import { createMCPServerV2 } from "../mcp/mcp-server-v2.js";
import type { ToolContext } from "../mcp/types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// ─────────────────────────────────────────────────────────────────
// Read environment
// ─────────────────────────────────────────────────────────────────

const agentId = process.env.MACRO_AGENT_ID ?? "";
const parentId = process.env.MACRO_PARENT_ID ?? "";
const taskId = process.env.MACRO_TASK_ID ?? "";
const agentCwd = process.env.MACRO_AGENT_CWD ?? process.cwd();
const sessionId = process.env.MACRO_SESSION_ID ?? "";
const lineage = process.env.MACRO_AGENT_LINEAGE
  ? JSON.parse(process.env.MACRO_AGENT_LINEAGE)
  : [];

const baseDir =
  process.env.MACRO_BASE_DIR ??
  path.join(os.homedir(), ".macro-agent");

const controlSocketPath =
  process.env.MACRO_CONTROL_SOCKET_PATH ?? path.join(baseDir, "control.sock");

const inboxSocketPath =
  process.env.INBOX_SOCKET_PATH ?? path.join(baseDir, "inbox.sock");

// ─────────────────────────────────────────────────────────────────
// Build tool context
// ─────────────────────────────────────────────────────────────────

const context: ToolContext = {
  agent_id: agentId,
  session_id: sessionId,
  task_id: taskId || undefined,
  lineage,
  cwd: agentCwd,
};

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────

async function main() {
  // AgentStore — shared SQLite (WAL mode = concurrent readers)
  const agentStore = new AgentStore(path.join(baseDir, "agents.db"));

  // Control client — lifecycle RPC to main process (with auto-reconnect)
  const controlClient = new ControlClient(controlSocketPath, { reconnect: true });
  try {
    await controlClient.connect();
  } catch {
    // Control socket may not be available — lifecycle tools will fail
    console.error("[mcp] Warning: control socket not available at", controlSocketPath);
  }

  // InboxAdapter — client-only, connects to main process inbox via IPC
  const inboxAdapter = new InboxClientAdapter(inboxSocketPath);
  try {
    await inboxAdapter.connect();
  } catch {
    console.error("[mcp] Warning: inbox socket not available at", inboxSocketPath);
  }

  // TasksAdapter
  const tasksAdapter = new DefaultTasksAdapter();
  try {
    await tasksAdapter.connect();
  } catch {
    // Non-fatal
  }

  const roleRegistry = new DefaultRoleRegistry();
  const taskMode = (process.env.MACRO_TASK_MODE as "push" | "pull") || undefined;

  // Build AgentManager that delegates lifecycle to control socket,
  // reads queries from shared AgentStore
  const agentManager = createControlBackedAgentManager(
    agentStore,
    controlClient
  );

  // Create and start MCP server
  const mcpServer = createMCPServerV2(context, {
    agentStore,
    agentManager,
    inboxAdapter,
    tasksAdapter,
    roleRegistry,
    taskMode,
  });

  await mcpServer.start();

  // Send periodic health checks to control server
  const healthInterval = setInterval(async () => {
    if (controlClient.connected) {
      try {
        await controlClient.healthCheck(agentId, process.pid);
      } catch { /* best effort */ }
    }
  }, 15000); // Every 15 seconds
  healthInterval.unref();

  // Cleanup on exit
  process.on("SIGINT", async () => {
    clearInterval(healthInterval);
    await mcpServer.close();
    controlClient.disconnect();
    await inboxAdapter.stop();
    tasksAdapter.disconnect();
    agentStore.close();
    process.exit(0);
  });
}

// ─────────────────────────────────────────────────────────────────
// Control-Backed AgentManager
// ─────────────────────────────────────────────────────────────────

/**
 * AgentManager that reads from shared AgentStore for queries
 * and delegates lifecycle operations to the control socket.
 */
function createControlBackedAgentManager(
  agentStore: AgentStore,
  controlClient: ControlClient
): AgentManager {
  function recordToAgent(r: any) {
    return {
      id: r.id,
      name: r.name,
      session_id: "",
      parent: r.parent_id,
      lineage: r.lineage,
      state: r.state,
      stop_reason: r.stop_reason,
      task: r.task,
      task_id: r.task_id,
      role: r.role,
      config: r.config ?? {},
      cwd: r.cwd,
      plan: [],
      metadata: r.metadata,
      created_at: r.created_at,
    };
  }

  return {
    // ── Lifecycle (via control socket) ──────────────────────
    async spawn(options: any) {
      if (!controlClient.connected) {
        throw new Error(
          "Cannot spawn: control socket not connected. " +
          "Main macro-agent process may not be running."
        );
      }

      const result = await controlClient.spawn({
        task: options.task,
        parent: options.parent ?? agentId, // Default parent = calling agent
        role: options.role,
        cwd: options.cwd,
        team_instance: options.team_instance,
        customPrompt: options.customPrompt,
      });

      // Read fresh agent record from shared store
      const agent = agentStore.getAgent(result.agent_id);

      return {
        id: result.agent_id,
        session_id: result.session_id,
        agent: agent ? recordToAgent(agent) : { id: result.agent_id, state: "running" },
        session: null as any, // Session lives in main process
      };
    },

    async terminate(targetId: string, reason: string) {
      if (!controlClient.connected) {
        throw new Error("Cannot terminate: control socket not connected.");
      }
      await controlClient.terminate(targetId, reason);
    },

    // ── Queries (from shared AgentStore) ────────────────────
    get(id: string) {
      const r = agentStore.getAgent(id);
      return r ? recordToAgent(r) : null;
    },

    list(filter?: any) {
      const records = agentStore.listAgents(
        filter?.state ? { state: filter.state } : undefined
      );
      let result = records.map(recordToAgent);
      if (filter?.parent !== undefined) {
        result = result.filter((a: any) =>
          filter.parent === null ? !a.parent : a.parent === filter.parent
        );
      }
      if (filter?.headManagersOnly) {
        result = result.filter((a: any) => !a.parent);
      }
      return result;
    },

    getChildren(pid: string) {
      return agentStore.getChildren(pid).map(recordToAgent);
    },

    getHierarchy(rootId: string, options?: any) {
      const r = agentStore.getAgent(rootId);
      if (!r) return null;

      function buildTree(id: string, depth: number): any {
        const agent = agentStore.getAgent(id);
        if (!agent) return null;
        const maxD = options?.depth;
        const children =
          maxD !== undefined && depth >= maxD
            ? []
            : agentStore
                .getChildren(id)
                .map((c) => buildTree(c.id, depth + 1))
                .filter(Boolean);
        return { agent: recordToAgent(agent), children };
      }

      const root = buildTree(rootId, 0);
      if (!root) return null;

      function count(n: any): number {
        return 1 + (n.children?.reduce((s: number, c: any) => s + count(c), 0) ?? 0);
      }
      function maxD(n: any, d: number): number {
        if (!n.children?.length) return d;
        return Math.max(...n.children.map((c: any) => maxD(c, d + 1)));
      }

      return { root, depth: maxD(root, 0), totalAgents: count(root) };
    },

    // ── Stubs for unused methods in MCP context ─────────────
    hasActiveSession() { return false; },
    getSession() { return null; },
    isPrompting() { return false; },
    async prompt() { throw new Error("prompt not available in MCP subprocess"); },
    async continueAgent() { throw new Error("continueAgent not available in MCP subprocess"); },
    async forkAgent() { throw new Error("forkAgent not available in MCP subprocess"); },
    async resume() { throw new Error("resume not available in MCP subprocess"); },
    listHeadManagers() { return agentStore.listAgents({ parent_id: null }).map(recordToAgent); },
    async getOrCreateHeadManager() { throw new Error("getOrCreateHeadManager not available in MCP subprocess"); },
    async promptUntilDone() { throw new Error("promptUntilDone not available in MCP subprocess"); },
    async supportsInjection() { return false; },
    isProcessRunning() { return false; },
    respondToPermission() { return false; },
    cancelPermission() { return false; },
    setPermissionMode() { return false; },
    getPermissionMode() { return null; },
    getRoleRegistry() { return new DefaultRoleRegistry(); },
    setSpawnInterceptor() {},
    setOpenTasksSocketPath() {},
    setMailServices() {},
    onLifecycleEvent() { return () => {}; },
    async close() {},
  } as any as AgentManager;
}

main().catch((err) => {
  console.error(`[mcp] Fatal error: ${err}`);
  process.exit(1);
});

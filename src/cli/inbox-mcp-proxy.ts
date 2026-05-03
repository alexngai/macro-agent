/**
 * inbox-mcp-proxy.ts — stdio entry that exposes agent-inbox tools as an
 * MCP server to a spawned worker.
 *
 * Why this exists:
 *
 *   The agent-inbox package ships an `InboxMcpProxy` (in dist/mcp/mcp-proxy.js)
 *   designed to bridge agent-inbox IPC ↔ MCP-stdio. macro-agent's
 *   `agentManager.spawn` configures this as a per-spawn MCP server so the
 *   spawned worker has access to `send_message`, `check_inbox`,
 *   `read_thread`, `list_agents` — the tools the macro-agent architecture
 *   docs claim are available, but which were not actually being mounted on
 *   workers prior to this fix.
 *
 *   Particularly important for mail-inbound dispatch workers, which run with
 *   `isolatedSettings: true` and therefore can't pick up host-level plugin
 *   MCPs that would otherwise have provided agent-inbox.
 *
 * Env vars consumed:
 *
 *   INBOX_SOCKET_PATH  (required)  — path to agent-inbox's IPC socket. Set
 *                                    by `buildMcpServerConfig` in
 *                                    agent-manager-v2.ts.
 *   MACRO_AGENT_ID     (optional)  — the spawned worker's agent id; used as
 *                                    the proxy's `defaultAgentId` so tools
 *                                    like check_inbox auto-target the
 *                                    caller's mailbox.
 *
 * Failure mode:
 *
 *   If INBOX_SOCKET_PATH is unset, the script exits with a non-zero status
 *   so Claude Code's MCP-init reports the misconfiguration loudly rather
 *   than silently leaving the worker without inbox tools.
 */

import { InboxMcpProxy } from "agent-inbox";

async function main(): Promise<void> {
  const socketPath = process.env.INBOX_SOCKET_PATH;
  if (!socketPath) {
    console.error(
      "[inbox-mcp-proxy] INBOX_SOCKET_PATH is unset — cannot start. " +
        "macro-agent's agentManager.spawn should always inject this env var.",
    );
    process.exit(1);
  }

  const agentId = process.env.MACRO_AGENT_ID || "anonymous";
  const proxy = new InboxMcpProxy(socketPath, agentId);
  await proxy.start();
}

main().catch((err) => {
  console.error(`[inbox-mcp-proxy] Fatal: ${(err as Error).message}`);
  process.exit(1);
});

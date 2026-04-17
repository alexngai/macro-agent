#!/usr/bin/env node
/**
 * Multi-Agent Server Entry Point (V2)
 *
 * Runs macro-agent using the V2 architecture:
 * - AgentStore for lifecycle state
 * - InboxAdapter (embedded agent-inbox) for messaging
 * - TasksAdapter (opentasks client) for task management
 * - AgentManagerV2 for agent lifecycle
 *
 * Usage:
 *   multiagent [options]
 *
 * Options:
 *   --cwd <path>       Working directory for agents
 *   --acp              Stdio ACP-only mode (for embedded use with acp-factory)
 */

import { bootV2 } from "../boot-v2.js";
import { parseArgs } from "./parse-args.js";

// Re-export utilities for backwards compatibility
export { parseArgs, type ACPServerOptions } from "./parse-args.js";
export { getStableInstanceId } from "./stable-instance-id.js";

// ─────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();
  const defaultCwd = options.cwd ?? process.cwd();

  try {
    const system = await bootV2({
      cwd: defaultCwd,
      // `--instance-id` picks the on-disk compartment under ~/.macro-agent/
      // so multiple runs with the same id share state. Omit to auto-derive
      // from the cwd hash. See `BootV2Config.instanceId`.
      ...(options.instanceId ? { instanceId: options.instanceId } : {}),
      // Enable ACP WebSocket server if port is specified (server mode)
      ...(options.port
        ? {
            acp: {
              enabled: true,
              port: options.port,
              host: options.host ?? "localhost",
            },
          }
        : {}),
    });

    const acpUrl = system.acpServer
      ? `ws://${options.host ?? "localhost"}:${options.port}/acp`
      : null;
    console.error("[acp] V2 system booted successfully.");
    if (acpUrl) {
      console.error(`[acp] MAP WebSocket: ${acpUrl}`);
    }

    // Cleanup function
    const cleanup = async () => {
      try {
        await system.shutdown();
      } catch (err) {
        console.error(`[cleanup] Shutdown failed: ${err}`);
      }
    };

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      await cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await cleanup();
      process.exit(0);
    });

    if (options.acp) {
      // Stdio ACP-only mode - keep process alive until stdin closes
      process.stdin.resume();
      process.stdin.on("end", async () => {
        await cleanup();
        process.exit(0);
      });
    } else {
      // Full server mode - keep process alive
      console.error(`[acp] System ready. Press Ctrl+C to stop.`);
      await new Promise<void>(() => {
        // Never resolves - process stays alive until signal
      });
    }
  } catch (error) {
    console.error(`ACP server error: ${error}`);
    process.exit(1);
  }
}

main();

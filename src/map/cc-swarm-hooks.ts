/**
 * cc-swarm Hook Integration
 *
 * Wraps cc-swarm's shell command hooks as programmatic HookCallback functions
 * that can be passed via acp-factory's agentMeta.claudeCode.options.hooks.
 *
 * This enables cc-swarm's MAP sidecar, trajectory reporting, and task bridging
 * for agents spawned by macro-agent via acp-factory.
 *
 * @module map/cc-swarm-hooks
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Resolve the cc-swarm plugin directory.
 * Checks common installation paths.
 */
function findCCSwarmDir(): string | null {
  const home = process.env.HOME ?? "";

  // Check plugin cache (Claude Code plugin system)
  // Plugins are cached at ~/.claude/plugins/cache/{publisher}/{name}/{version}/
  const cacheDir = path.join(home, ".claude/plugins/cache/claude-code-swarm/claude-code-swarm");
  if (fs.existsSync(cacheDir)) {
    // Find the latest version
    try {
      const versions = fs.readdirSync(cacheDir)
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => {
          const [aMaj, aMin, aPat] = a.split(".").map(Number);
          const [bMaj, bMin, bPat] = b.split(".").map(Number);
          return bMaj - aMaj || bMin - aMin || bPat - aPat;
        });
      if (versions.length > 0) {
        const latest = path.join(cacheDir, versions[0]);
        if (fs.existsSync(path.join(latest, "scripts", "bootstrap.mjs"))) {
          return latest;
        }
      }
    } catch {
      // Can't read cache directory
    }
  }

  // Check marketplace plugin
  const marketplace = path.join(home, ".claude/plugins/marketplaces/claude-code-swarm");
  if (fs.existsSync(path.join(marketplace, "scripts", "bootstrap.mjs"))) {
    return marketplace;
  }

  // Check references (development)
  const references = path.resolve(__dirname, "../../references/claude-code-swarm");
  if (fs.existsSync(path.join(references, "scripts", "bootstrap.mjs"))) {
    return references;
  }

  return null;
}

/**
 * Create a programmatic hook callback that executes a cc-swarm script.
 *
 * The hook spawns a child process running the specified script,
 * pipes the hook input via stdin, and captures stdout output.
 */
function createShellHook(
  scriptPath: string,
  args: string[] = [],
  env?: Record<string, string>,
): (input: any, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<{ async: boolean; output?: string }> {
  return async (input, _toolUseId, { signal }) => {
    return new Promise((resolve) => {
      const proc = spawn(process.execPath, [scriptPath, ...args], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "inherit"],
        timeout: 30000,
        signal,
      });

      let output = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      proc.on("close", () => {
        resolve({
          async: false,
          ...(output.trim() ? { output: output.trim() } : {}),
        });
      });

      proc.on("error", () => {
        resolve({ async: false });
      });

      // Pipe hook input via stdin
      try {
        proc.stdin?.write(JSON.stringify(input), () => {
          proc.stdin?.end();
        });
      } catch {
        proc.stdin?.end();
      }
    });
  };
}

/**
 * Directly start the cc-swarm MAP sidecar for an agent.
 *
 * Instead of relying on Claude Code's SessionStart hook (which may not fire
 * for programmatic sessions), this spawns the sidecar process directly.
 * The sidecar connects to macro-agent's MAP server and starts sending
 * trajectory checkpoints.
 *
 * Returns the spawned process, or null if cc-swarm is not installed.
 */
export function startCCSwarmSidecar(
  mapServerUrl: string,
  agentScope: string,
  sessionId: string,
  cwd: string,
): { pid: number } | null {
  const ccSwarmDir = findCCSwarmDir();
  if (!ccSwarmDir) return null;

  const sidecarScript = path.join(ccSwarmDir, "scripts", "map-sidecar.mjs");
  if (!fs.existsSync(sidecarScript)) return null;

  try {
    const proc = spawn(process.execPath, [sidecarScript], {
      detached: true,
      stdio: "ignore",
      cwd,
      env: {
        ...process.env,
        SWARM_MAP_SERVER: mapServerUrl,
        SWARM_MAP_ENABLED: "true",
        SWARM_MAP_SCOPE: agentScope,
        SWARM_SESSIONLOG_ENABLED: "true",
        SWARM_SESSIONLOG_SYNC: "metrics",
        CLAUDE_PLUGIN_ROOT: ccSwarmDir,
        NODE_PATH: process.env.NODE_PATH ?? "",
      },
    });
    proc.unref();
    return { pid: proc.pid ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Build cc-swarm hooks configuration for a spawned agent.
 *
 * Returns a hooks object compatible with Claude Code's programmatic API:
 * ```
 * { SessionStart: [...], Stop: [...], PostToolUse: [...], ... }
 * ```
 *
 * Returns null if cc-swarm is not installed.
 */
export function buildCCSwarmHooks(
  mapServerUrl: string,
  agentScope: string,
): Record<string, any[]> | null {
  const ccSwarmDir = findCCSwarmDir();
  if (!ccSwarmDir) return null;

  const bootstrapScript = path.join(ccSwarmDir, "scripts", "bootstrap.mjs");
  const mapHookScript = path.join(ccSwarmDir, "scripts", "map-hook.mjs");

  if (!fs.existsSync(bootstrapScript) || !fs.existsSync(mapHookScript)) {
    return null;
  }

  const hookEnv: Record<string, string> = {
    SWARM_MAP_SERVER: mapServerUrl,
    SWARM_MAP_ENABLED: "true",
    SWARM_MAP_SCOPE: agentScope,
    SWARM_SESSIONLOG_ENABLED: "true",
    SWARM_SESSIONLOG_SYNC: "metrics",
    CLAUDE_PLUGIN_ROOT: ccSwarmDir,
  };

  return {
    SessionStart: [
      {
        matcher: "",
        hooks: [createShellHook(bootstrapScript, [], hookEnv)],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [
          createShellHook(mapHookScript, ["turn-completed"], hookEnv),
          createShellHook(mapHookScript, ["sessionlog-sync"], hookEnv),
        ],
      },
    ],
    SubagentStart: [
      {
        matcher: "",
        hooks: [
          createShellHook(mapHookScript, ["subagent-start"], hookEnv),
        ],
      },
    ],
    SubagentStop: [
      {
        matcher: "",
        hooks: [
          createShellHook(mapHookScript, ["subagent-stop"], hookEnv),
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "TaskCreate",
        hooks: [
          createShellHook(mapHookScript, ["native-task-created"], hookEnv),
        ],
      },
      {
        matcher: "TaskUpdate",
        hooks: [
          createShellHook(mapHookScript, ["native-task-updated"], hookEnv),
        ],
      },
    ],
    UserPromptSubmit: [
      {
        matcher: "",
        hooks: [createShellHook(mapHookScript, ["inject"], hookEnv)],
      },
    ],
  };
}

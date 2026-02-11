/**
 * Command Builder
 *
 * Constructs headless invocation commands for CLI coding agents
 * based on their definitions.
 */

import type {
  CLIAgentDefinition,
  SpawnCommand,
  SpawnCommandOptions,
} from "./types.js";
import { AgentDetectionError } from "./types.js";

/**
 * Build a headless spawn command for a CLI agent.
 *
 * Constructs the command and arguments array based on the agent definition's
 * headless configuration, model flag, and working directory flag.
 *
 * @param definition - The CLI agent definition
 * @param task - The prompt/task to pass to the agent
 * @param options - Optional model and cwd overrides
 * @returns The command and args array ready for child_process.spawn()
 *
 * @example
 * ```ts
 * const cmd = buildSpawnCommand(claudeCode, "Fix the auth bug", { model: "claude-sonnet-4-5" });
 * // { command: "claude", args: ["-p", "Fix the auth bug", "--output-format", "stream-json", "--model", "claude-sonnet-4-5"] }
 * ```
 */
export function buildSpawnCommand(
  definition: CLIAgentDefinition,
  task: string,
  options?: SpawnCommandOptions
): SpawnCommand {
  if (!task) {
    throw new AgentDetectionError(
      "Task prompt is required",
      "DETECTION_FAILED"
    );
  }

  const args: string[] = [];

  // 1. Subcommand (e.g., "exec", "run")
  if (definition.headless.subcommand) {
    args.push(definition.headless.subcommand);
  }

  // 2. Default flags (e.g., "--full-auto", "--yes")
  if (definition.headless.defaultFlags) {
    args.push(...definition.headless.defaultFlags);
  }

  // 3. Model flag
  if (options?.model && definition.modelFlag) {
    args.push(definition.modelFlag, options.model);
  }

  // 4. Working directory flag
  if (options?.cwd && definition.cwdFlag) {
    args.push(definition.cwdFlag, options.cwd);
  }

  // 5. Prompt (flag-based or positional)
  if (definition.headless.promptFlag) {
    args.push(definition.headless.promptFlag, task);
  } else {
    args.push(task);
  }

  return { command: definition.binary, args };
}

/**
 * Format a spawn command as a single shell string (for display/logging).
 */
export function formatSpawnCommand(spawnCommand: SpawnCommand): string {
  const parts = [spawnCommand.command];
  for (const arg of spawnCommand.args) {
    // Quote arguments that contain spaces
    if (arg.includes(" ")) {
      parts.push(`"${arg}"`);
    } else {
      parts.push(arg);
    }
  }
  return parts.join(" ");
}

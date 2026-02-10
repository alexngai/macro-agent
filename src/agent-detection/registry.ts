/**
 * CLI Agent Definitions Registry
 *
 * Maintains a registry of known CLI coding agents with their
 * detection and headless invocation configurations.
 */

import type { CLIAgentDefinition } from "./types.js";

// =============================================================================
// Built-in Agent Definitions
// =============================================================================

const CLAUDE_CODE: CLIAgentDefinition = {
  id: "claude-code",
  name: "Claude Code",
  description: "Anthropic's CLI coding agent",
  binary: "claude",
  versionArgs: ["--version"],
  headless: {
    promptFlag: "-p",
    defaultFlags: ["--output-format", "stream-json"],
  },
  modelFlag: "--model",
  cwdFlag: "--cwd",
  vendor: "Anthropic",
};

const CODEX: CLIAgentDefinition = {
  id: "codex",
  name: "Codex",
  description: "OpenAI's CLI coding agent",
  binary: "codex",
  versionArgs: ["--version"],
  headless: {
    subcommand: "exec",
    promptFlag: "",
    defaultFlags: ["--full-auto"],
  },
  modelFlag: "--model",
  cwdFlag: "--path",
  vendor: "OpenAI",
};

const GEMINI_CLI: CLIAgentDefinition = {
  id: "gemini-cli",
  name: "Gemini CLI",
  description: "Google's CLI coding agent",
  binary: "gemini",
  versionArgs: ["--version"],
  headless: {
    promptFlag: "-p",
  },
  modelFlag: "--model",
  vendor: "Google",
};

const OPENCODE: CLIAgentDefinition = {
  id: "opencode",
  name: "OpenCode",
  description: "Anomaly's CLI coding agent",
  binary: "opencode",
  versionArgs: ["--version"],
  headless: {
    subcommand: "run",
    promptFlag: "",
  },
  modelFlag: "--model",
  vendor: "Anomaly",
};

const AIDER: CLIAgentDefinition = {
  id: "aider",
  name: "Aider",
  description: "AI pair programming in your terminal",
  binary: "aider",
  versionArgs: ["--version"],
  headless: {
    promptFlag: "--message",
    defaultFlags: ["--yes"],
  },
  modelFlag: "--model",
  vendor: "Aider",
};

const GOOSE: CLIAgentDefinition = {
  id: "goose",
  name: "Goose",
  description: "Block's CLI coding agent",
  binary: "goose",
  versionArgs: ["--version"],
  headless: {
    subcommand: "run",
    promptFlag: "-t",
    defaultFlags: ["--no-session"],
  },
  modelFlag: "--model",
  vendor: "Block",
};

/**
 * All built-in agent definitions.
 */
export const BUILTIN_AGENTS: readonly CLIAgentDefinition[] = [
  CLAUDE_CODE,
  CODEX,
  GEMINI_CLI,
  OPENCODE,
  AIDER,
  GOOSE,
];

// =============================================================================
// Agent Registry
// =============================================================================

/**
 * Registry of known CLI coding agent definitions.
 *
 * Provides lookup by ID and supports adding custom agent definitions.
 */
export class AgentRegistry {
  private readonly agents: Map<string, CLIAgentDefinition> = new Map();

  constructor(definitions?: CLIAgentDefinition[]) {
    // Register built-in agents
    for (const def of BUILTIN_AGENTS) {
      this.agents.set(def.id, def);
    }

    // Register additional definitions
    if (definitions) {
      for (const def of definitions) {
        this.agents.set(def.id, def);
      }
    }
  }

  /**
   * Get an agent definition by ID.
   */
  get(id: string): CLIAgentDefinition | undefined {
    return this.agents.get(id);
  }

  /**
   * Check if an agent definition exists.
   */
  has(id: string): boolean {
    return this.agents.has(id);
  }

  /**
   * Register a new agent definition (or override an existing one).
   */
  register(definition: CLIAgentDefinition): void {
    this.agents.set(definition.id, definition);
  }

  /**
   * Remove an agent definition by ID.
   */
  remove(id: string): boolean {
    return this.agents.delete(id);
  }

  /**
   * List all registered agent definitions.
   */
  list(): CLIAgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /**
   * List agent definitions, optionally excluding disabled agents.
   */
  listEnabled(disabledIds?: string[]): CLIAgentDefinition[] {
    if (!disabledIds || disabledIds.length === 0) {
      return this.list();
    }
    const disabled = new Set(disabledIds);
    return this.list().filter((def) => !disabled.has(def.id));
  }

  /**
   * Get the number of registered agent definitions.
   */
  get size(): number {
    return this.agents.size;
  }
}

/**
 * Create a new AgentRegistry with built-in agents and optional custom definitions.
 */
export function createAgentRegistry(
  additionalAgents?: CLIAgentDefinition[]
): AgentRegistry {
  return new AgentRegistry(additionalAgents);
}

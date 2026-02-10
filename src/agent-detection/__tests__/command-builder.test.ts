/**
 * Command Builder Tests
 */

import { describe, it, expect } from "vitest";

import { buildSpawnCommand, formatSpawnCommand } from "../command-builder.js";
import { BUILTIN_AGENTS } from "../registry.js";
import type { CLIAgentDefinition } from "../types.js";

// Helper to get a built-in agent definition by ID
function getAgent(id: string): CLIAgentDefinition {
  const agent = BUILTIN_AGENTS.find((a) => a.id === id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  return agent;
}

describe("buildSpawnCommand()", () => {
  // ===========================================================================
  // Claude Code
  // ===========================================================================

  describe("claude-code", () => {
    const def = getAgent("claude-code");

    it("builds basic command", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug");
      expect(cmd.command).toBe("claude");
      expect(cmd.args).toEqual([
        "--output-format",
        "stream-json",
        "-p",
        "Fix the auth bug",
      ]);
    });

    it("builds command with model", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug", {
        model: "claude-sonnet-4-5",
      });
      expect(cmd.command).toBe("claude");
      expect(cmd.args).toEqual([
        "--output-format",
        "stream-json",
        "--model",
        "claude-sonnet-4-5",
        "-p",
        "Fix the auth bug",
      ]);
    });

    it("builds command with cwd", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug", {
        cwd: "/home/user/project",
      });
      expect(cmd.args).toContain("--cwd");
      expect(cmd.args).toContain("/home/user/project");
    });

    it("builds command with model and cwd", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug", {
        model: "claude-sonnet-4-5",
        cwd: "/home/user/project",
      });
      expect(cmd.command).toBe("claude");
      expect(cmd.args).toEqual([
        "--output-format",
        "stream-json",
        "--model",
        "claude-sonnet-4-5",
        "--cwd",
        "/home/user/project",
        "-p",
        "Fix the auth bug",
      ]);
    });
  });

  // ===========================================================================
  // Codex
  // ===========================================================================

  describe("codex", () => {
    const def = getAgent("codex");

    it("builds basic command with positional prompt", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug");
      expect(cmd.command).toBe("codex");
      expect(cmd.args).toEqual([
        "exec",
        "--full-auto",
        "Fix the auth bug",
      ]);
    });

    it("builds command with model and path", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug", {
        model: "o3",
        cwd: "/home/user/project",
      });
      expect(cmd.command).toBe("codex");
      expect(cmd.args).toEqual([
        "exec",
        "--full-auto",
        "--model",
        "o3",
        "--path",
        "/home/user/project",
        "Fix the auth bug",
      ]);
    });
  });

  // ===========================================================================
  // Gemini CLI
  // ===========================================================================

  describe("gemini-cli", () => {
    const def = getAgent("gemini-cli");

    it("builds basic command", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug");
      expect(cmd.command).toBe("gemini");
      expect(cmd.args).toEqual(["-p", "Fix the auth bug"]);
    });

    it("builds command with model (no cwd flag)", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug", {
        model: "gemini-2.5-pro",
        cwd: "/home/user/project",
      });
      expect(cmd.command).toBe("gemini");
      // Gemini has no cwdFlag, so cwd is ignored
      expect(cmd.args).toEqual([
        "--model",
        "gemini-2.5-pro",
        "-p",
        "Fix the auth bug",
      ]);
    });
  });

  // ===========================================================================
  // OpenCode
  // ===========================================================================

  describe("opencode", () => {
    const def = getAgent("opencode");

    it("builds basic command with positional prompt", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug");
      expect(cmd.command).toBe("opencode");
      expect(cmd.args).toEqual(["run", "Fix the auth bug"]);
    });

    it("builds command with model", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug", {
        model: "gpt-4",
      });
      expect(cmd.args).toEqual([
        "run",
        "--model",
        "gpt-4",
        "Fix the auth bug",
      ]);
    });
  });

  // ===========================================================================
  // Aider
  // ===========================================================================

  describe("aider", () => {
    const def = getAgent("aider");

    it("builds basic command", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug");
      expect(cmd.command).toBe("aider");
      expect(cmd.args).toEqual([
        "--yes",
        "--message",
        "Fix the auth bug",
      ]);
    });

    it("builds command with model", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug", {
        model: "claude-3-opus",
      });
      expect(cmd.args).toEqual([
        "--yes",
        "--model",
        "claude-3-opus",
        "--message",
        "Fix the auth bug",
      ]);
    });
  });

  // ===========================================================================
  // Goose
  // ===========================================================================

  describe("goose", () => {
    const def = getAgent("goose");

    it("builds basic command", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug");
      expect(cmd.command).toBe("goose");
      expect(cmd.args).toEqual([
        "run",
        "--no-session",
        "-t",
        "Fix the auth bug",
      ]);
    });

    it("builds command with model", () => {
      const cmd = buildSpawnCommand(def, "Fix the auth bug", {
        model: "claude-4-sonnet",
      });
      expect(cmd.args).toEqual([
        "run",
        "--no-session",
        "--model",
        "claude-4-sonnet",
        "-t",
        "Fix the auth bug",
      ]);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe("edge cases", () => {
    it("throws when task is empty", () => {
      const def = getAgent("claude-code");
      expect(() => buildSpawnCommand(def, "")).toThrow("Task prompt is required");
    });

    it("does not add model flag when modelFlag is undefined", () => {
      const def: CLIAgentDefinition = {
        id: "no-model",
        name: "No Model",
        description: "Agent without model flag",
        binary: "no-model",
        versionArgs: ["--version"],
        headless: { promptFlag: "--prompt" },
        vendor: "Test",
        // modelFlag intentionally omitted
      };
      const cmd = buildSpawnCommand(def, "Do something", { model: "gpt-4" });
      expect(cmd.args).not.toContain("--model");
      expect(cmd.args).not.toContain("gpt-4");
    });

    it("does not add cwd flag when cwdFlag is undefined", () => {
      const def: CLIAgentDefinition = {
        id: "no-cwd",
        name: "No CWD",
        description: "Agent without cwd flag",
        binary: "no-cwd",
        versionArgs: ["--version"],
        headless: { promptFlag: "--prompt" },
        vendor: "Test",
        // cwdFlag intentionally omitted
      };
      const cmd = buildSpawnCommand(def, "Do something", {
        cwd: "/tmp",
      });
      expect(cmd.args).not.toContain("--cwd");
      expect(cmd.args).not.toContain("/tmp");
    });

    it("handles definition with no subcommand or default flags", () => {
      const def: CLIAgentDefinition = {
        id: "minimal",
        name: "Minimal",
        description: "Minimal agent",
        binary: "minimal",
        versionArgs: ["--version"],
        headless: { promptFlag: "--prompt" },
        vendor: "Test",
      };
      const cmd = buildSpawnCommand(def, "Do something");
      expect(cmd.command).toBe("minimal");
      expect(cmd.args).toEqual(["--prompt", "Do something"]);
    });
  });
});

// =============================================================================
// formatSpawnCommand()
// =============================================================================

describe("formatSpawnCommand()", () => {
  it("formats a simple command", () => {
    const formatted = formatSpawnCommand({
      command: "claude",
      args: ["-p", "hello"],
    });
    expect(formatted).toBe('claude -p hello');
  });

  it("quotes arguments with spaces", () => {
    const formatted = formatSpawnCommand({
      command: "claude",
      args: ["-p", "Fix the auth bug", "--cwd", "/home/user/my project"],
    });
    expect(formatted).toBe(
      'claude -p "Fix the auth bug" --cwd "/home/user/my project"'
    );
  });

  it("formats a full claude-code command", () => {
    const def = getAgent("claude-code");
    const cmd = buildSpawnCommand(def, "Fix the auth bug", {
      model: "claude-sonnet-4-5",
      cwd: "/home/user/project",
    });
    const formatted = formatSpawnCommand(cmd);
    expect(formatted).toBe(
      'claude --output-format stream-json --model claude-sonnet-4-5 --cwd /home/user/project -p "Fix the auth bug"'
    );
  });
});

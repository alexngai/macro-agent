/**
 * Agent Registry Tests
 */

import { describe, it, expect } from "vitest";

import {
  AgentRegistry,
  createAgentRegistry,
  BUILTIN_AGENTS,
} from "../registry.js";
import type { CLIAgentDefinition } from "../types.js";

describe("AgentRegistry", () => {
  // ===========================================================================
  // Built-in Agents
  // ===========================================================================

  describe("BUILTIN_AGENTS", () => {
    it("contains all 6 known agents", () => {
      expect(BUILTIN_AGENTS).toHaveLength(6);
    });

    it("includes claude-code", () => {
      const agent = BUILTIN_AGENTS.find((a) => a.id === "claude-code");
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe("claude");
      expect(agent!.vendor).toBe("Anthropic");
    });

    it("includes codex", () => {
      const agent = BUILTIN_AGENTS.find((a) => a.id === "codex");
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe("codex");
      expect(agent!.vendor).toBe("OpenAI");
    });

    it("includes gemini-cli", () => {
      const agent = BUILTIN_AGENTS.find((a) => a.id === "gemini-cli");
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe("gemini");
      expect(agent!.vendor).toBe("Google");
    });

    it("includes opencode", () => {
      const agent = BUILTIN_AGENTS.find((a) => a.id === "opencode");
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe("opencode");
      expect(agent!.vendor).toBe("Anomaly");
    });

    it("includes aider", () => {
      const agent = BUILTIN_AGENTS.find((a) => a.id === "aider");
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe("aider");
      expect(agent!.vendor).toBe("Aider");
    });

    it("includes goose", () => {
      const agent = BUILTIN_AGENTS.find((a) => a.id === "goose");
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe("goose");
      expect(agent!.vendor).toBe("Block");
    });

    it("all agents have required fields", () => {
      for (const agent of BUILTIN_AGENTS) {
        expect(agent.id).toBeTruthy();
        expect(agent.name).toBeTruthy();
        expect(agent.description).toBeTruthy();
        expect(agent.binary).toBeTruthy();
        expect(agent.versionArgs).toBeDefined();
        expect(agent.versionArgs.length).toBeGreaterThan(0);
        expect(agent.headless).toBeDefined();
        expect(agent.headless.promptFlag).toBeDefined();
        expect(agent.vendor).toBeTruthy();
      }
    });
  });

  // ===========================================================================
  // Registry Operations
  // ===========================================================================

  describe("constructor", () => {
    it("creates registry with built-in agents", () => {
      const registry = new AgentRegistry();
      expect(registry.size).toBe(6);
    });

    it("creates registry with additional custom agents", () => {
      const custom: CLIAgentDefinition = {
        id: "custom-agent",
        name: "Custom Agent",
        description: "A custom agent",
        binary: "custom",
        versionArgs: ["--version"],
        headless: { promptFlag: "--prompt" },
        vendor: "Custom",
      };
      const registry = new AgentRegistry([custom]);
      expect(registry.size).toBe(7);
      expect(registry.get("custom-agent")).toEqual(custom);
    });

    it("custom agents can override built-in agents", () => {
      const override: CLIAgentDefinition = {
        id: "claude-code",
        name: "Custom Claude",
        description: "Overridden",
        binary: "custom-claude",
        versionArgs: ["--version"],
        headless: { promptFlag: "-p" },
        vendor: "Custom",
      };
      const registry = new AgentRegistry([override]);
      expect(registry.get("claude-code")!.binary).toBe("custom-claude");
    });
  });

  describe("get()", () => {
    it("returns agent definition by ID", () => {
      const registry = new AgentRegistry();
      const agent = registry.get("claude-code");
      expect(agent).toBeDefined();
      expect(agent!.id).toBe("claude-code");
    });

    it("returns undefined for unknown ID", () => {
      const registry = new AgentRegistry();
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("has()", () => {
    it("returns true for existing agent", () => {
      const registry = new AgentRegistry();
      expect(registry.has("claude-code")).toBe(true);
    });

    it("returns false for unknown agent", () => {
      const registry = new AgentRegistry();
      expect(registry.has("nonexistent")).toBe(false);
    });
  });

  describe("register()", () => {
    it("adds a new agent definition", () => {
      const registry = new AgentRegistry();
      const custom: CLIAgentDefinition = {
        id: "new-agent",
        name: "New Agent",
        description: "Newly added",
        binary: "new",
        versionArgs: ["--version"],
        headless: { promptFlag: "--prompt" },
        vendor: "New",
      };
      registry.register(custom);
      expect(registry.has("new-agent")).toBe(true);
      expect(registry.get("new-agent")).toEqual(custom);
    });

    it("overrides existing agent definition", () => {
      const registry = new AgentRegistry();
      const override: CLIAgentDefinition = {
        id: "claude-code",
        name: "Custom Claude",
        description: "Overridden",
        binary: "custom",
        versionArgs: ["--version"],
        headless: { promptFlag: "-p" },
        vendor: "Custom",
      };
      registry.register(override);
      expect(registry.get("claude-code")!.name).toBe("Custom Claude");
    });
  });

  describe("remove()", () => {
    it("removes an existing agent definition", () => {
      const registry = new AgentRegistry();
      expect(registry.remove("claude-code")).toBe(true);
      expect(registry.has("claude-code")).toBe(false);
      expect(registry.size).toBe(5);
    });

    it("returns false for non-existent agent", () => {
      const registry = new AgentRegistry();
      expect(registry.remove("nonexistent")).toBe(false);
    });
  });

  describe("list()", () => {
    it("returns all registered agents", () => {
      const registry = new AgentRegistry();
      const agents = registry.list();
      expect(agents).toHaveLength(6);
      const ids = agents.map((a) => a.id);
      expect(ids).toContain("claude-code");
      expect(ids).toContain("codex");
      expect(ids).toContain("gemini-cli");
      expect(ids).toContain("opencode");
      expect(ids).toContain("aider");
      expect(ids).toContain("goose");
    });
  });

  describe("listEnabled()", () => {
    it("returns all agents when no disabled list", () => {
      const registry = new AgentRegistry();
      expect(registry.listEnabled()).toHaveLength(6);
    });

    it("returns all agents when disabled list is empty", () => {
      const registry = new AgentRegistry();
      expect(registry.listEnabled([])).toHaveLength(6);
    });

    it("excludes disabled agents", () => {
      const registry = new AgentRegistry();
      const enabled = registry.listEnabled(["goose", "aider"]);
      expect(enabled).toHaveLength(4);
      const ids = enabled.map((a) => a.id);
      expect(ids).not.toContain("goose");
      expect(ids).not.toContain("aider");
    });
  });

  // ===========================================================================
  // Factory
  // ===========================================================================

  describe("createAgentRegistry()", () => {
    it("creates registry with defaults", () => {
      const registry = createAgentRegistry();
      expect(registry.size).toBe(6);
    });

    it("creates registry with additional agents", () => {
      const custom: CLIAgentDefinition = {
        id: "extra",
        name: "Extra",
        description: "Extra agent",
        binary: "extra",
        versionArgs: ["--version"],
        headless: { promptFlag: "--prompt" },
        vendor: "Extra",
      };
      const registry = createAgentRegistry([custom]);
      expect(registry.size).toBe(7);
    });
  });
});

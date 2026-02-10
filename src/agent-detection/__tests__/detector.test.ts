/**
 * Agent Detector Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";

import { AgentDetector, createAgentDetector, parseVersion } from "../detector.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock node:util to return our mock
vi.mock("node:util", () => ({
  promisify: (fn: unknown) => {
    // Return a function that calls the mock and wraps in a promise
    return (...args: unknown[]) => {
      return new Promise((resolve, reject) => {
        (fn as Function)(...args, (err: Error | null, result: unknown) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    };
  },
}));

const mockExecFile = vi.mocked(execFile);

function setupExecFileMock(responses: Record<string, { stdout?: string; stderr?: string; error?: Error }>) {
  mockExecFile.mockImplementation(((
    command: string,
    args: string[],
    _options: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    // Build a key from the command
    let key: string;
    if (command === "which") {
      key = `which:${args[0]}`;
    } else if (command === "/bin/sh") {
      key = `command-v:${args[1]?.replace("command -v ", "")}`;
    } else {
      key = `version:${command}`;
    }

    const response = responses[key];
    if (response?.error) {
      callback(response.error, { stdout: "", stderr: "" });
    } else if (response) {
      callback(null, { stdout: response.stdout ?? "", stderr: response.stderr ?? "" });
    } else {
      callback(new Error(`Command not found: ${key}`), { stdout: "", stderr: "" });
    }
  }) as unknown as typeof execFile);
}

describe("AgentDetector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // parseVersion()
  // ===========================================================================

  describe("parseVersion()", () => {
    it("parses standard semver version", () => {
      expect(parseVersion("1.2.3")).toBe("1.2.3");
    });

    it("parses version from verbose output", () => {
      expect(parseVersion("claude v1.0.30 (build abc123)")).toBe("1.0.30");
    });

    it("parses version with only major.minor", () => {
      expect(parseVersion("version 0.82")).toBe("0.82");
    });

    it("parses version with four parts", () => {
      expect(parseVersion("aider 0.82.1.2")).toBe("0.82.1.2");
    });

    it("parses version from multiline output", () => {
      expect(parseVersion("Tool name\nVersion: 2.3.4\nBuild: xyz")).toBe("2.3.4");
    });

    it("returns null for output with no version", () => {
      expect(parseVersion("no version here")).toBeNull();
    });

    it("returns null for empty output", () => {
      expect(parseVersion("")).toBeNull();
    });
  });

  // ===========================================================================
  // Constructor & Configuration
  // ===========================================================================

  describe("constructor", () => {
    it("creates detector with default configuration", () => {
      const detector = new AgentDetector();
      expect(detector.getRegistry().size).toBe(6);
    });

    it("creates detector with custom agents", () => {
      const detector = new AgentDetector({
        additionalAgents: [
          {
            id: "custom",
            name: "Custom",
            description: "Custom agent",
            binary: "custom",
            versionArgs: ["--version"],
            headless: { promptFlag: "--prompt" },
            vendor: "Custom",
          },
        ],
      });
      expect(detector.getRegistry().size).toBe(7);
    });

    it("creates detector with disabled agents", () => {
      const detector = new AgentDetector({
        disabledAgents: ["goose", "aider"],
      });
      // Registry still has all agents, but detection will skip disabled ones
      expect(detector.getRegistry().size).toBe(6);
    });
  });

  // ===========================================================================
  // Detection
  // ===========================================================================

  describe("detect()", () => {
    it("detects installed agents", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "claude v1.0.30\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { stdout: "/home/user/.local/bin/aider\n" },
        "version:aider": { stdout: "aider v0.82.1\n" },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      const result = await detector.detect();

      expect(result.scanned).toBe(6);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      const claude = result.agents.find((a) => a.id === "claude-code");
      expect(claude).toBeDefined();
      expect(claude!.installed).toBe(true);
      expect(claude!.version).toBe("1.0.30");
      expect(claude!.path).toBe("/usr/local/bin/claude");

      const aider = result.agents.find((a) => a.id === "aider");
      expect(aider).toBeDefined();
      expect(aider!.installed).toBe(true);
      expect(aider!.version).toBe("0.82.1");

      const codex = result.agents.find((a) => a.id === "codex");
      expect(codex).toBeDefined();
      expect(codex!.installed).toBe(false);
    });

    it("handles version output on stderr", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "", stderr: "claude version 2.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      const result = await detector.detect();

      const claude = result.agents.find((a) => a.id === "claude-code");
      expect(claude!.installed).toBe(true);
      expect(claude!.version).toBe("2.0.0");
    });

    it("marks agent as installed even if version check fails", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { error: new Error("version failed") },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      const result = await detector.detect();

      const claude = result.agents.find((a) => a.id === "claude-code");
      expect(claude!.installed).toBe(true);
      expect(claude!.version).toBeUndefined();
    });

    it("skips disabled agents", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "1.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
      });

      const detector = createAgentDetector({
        disabledAgents: ["aider", "goose"],
      });
      const result = await detector.detect();

      expect(result.scanned).toBe(4);
      expect(result.agents.find((a) => a.id === "aider")).toBeUndefined();
      expect(result.agents.find((a) => a.id === "goose")).toBeUndefined();
    });

    it("falls back to command -v when which fails", async () => {
      setupExecFileMock({
        "which:claude": { error: new Error("which not found") },
        "command-v:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "1.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      const result = await detector.detect();

      const claude = result.agents.find((a) => a.id === "claude-code");
      expect(claude!.installed).toBe(true);
      expect(claude!.path).toBe("/usr/local/bin/claude");
    });
  });

  // ===========================================================================
  // Caching
  // ===========================================================================

  describe("caching", () => {
    it("returns cached result on subsequent calls", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "1.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      const result1 = await detector.detect();
      const callCount = mockExecFile.mock.calls.length;

      const result2 = await detector.detect();
      // No additional execFile calls — result was cached
      expect(mockExecFile.mock.calls.length).toBe(callCount);
      expect(result2).toEqual(result1);
    });

    it("bypasses cache when refresh is true", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "1.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      await detector.detect();
      const callCountAfterFirst = mockExecFile.mock.calls.length;

      await detector.detect({ refresh: true });
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
    });

    it("invalidates cache manually", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "1.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      await detector.detect();
      expect(detector.getCachedResult()).not.toBeNull();

      detector.invalidateCache();
      expect(detector.getCachedResult()).toBeNull();
    });

    it("expires cache after TTL", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "1.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector({ cacheTtlMs: 50 });
      await detector.detect();
      const callCountAfterFirst = mockExecFile.mock.calls.length;

      // Wait for cache to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      await detector.detect();
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
    });
  });

  // ===========================================================================
  // getAvailableAgents()
  // ===========================================================================

  describe("getAvailableAgents()", () => {
    it("returns only installed agents by default", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "1.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      const result = await detector.getAvailableAgents();

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].id).toBe("claude-code");
    });

    it("includes not-installed agents when requested", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "1.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      const result = await detector.getAvailableAgents({ includeNotInstalled: true });

      expect(result.agents).toHaveLength(6);
    });
  });

  // ===========================================================================
  // getDefinition()
  // ===========================================================================

  describe("getDefinition()", () => {
    it("returns definition for known agent", () => {
      const detector = createAgentDetector();
      const def = detector.getDefinition("claude-code");
      expect(def.id).toBe("claude-code");
      expect(def.binary).toBe("claude");
    });

    it("throws for unknown agent", () => {
      const detector = createAgentDetector();
      expect(() => detector.getDefinition("unknown")).toThrow("Unknown agent backend: unknown");
    });
  });

  // ===========================================================================
  // isInstalled()
  // ===========================================================================

  describe("isInstalled()", () => {
    it("returns true for installed agent", async () => {
      setupExecFileMock({
        "which:claude": { stdout: "/usr/local/bin/claude\n" },
        "version:claude": { stdout: "1.0.0\n" },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      expect(await detector.isInstalled("claude-code")).toBe(true);
    });

    it("returns false for non-installed agent", async () => {
      setupExecFileMock({
        "which:claude": { error: new Error("not found") },
        "command-v:claude": { error: new Error("not found") },
        "which:codex": { error: new Error("not found") },
        "command-v:codex": { error: new Error("not found") },
        "which:gemini": { error: new Error("not found") },
        "command-v:gemini": { error: new Error("not found") },
        "which:opencode": { error: new Error("not found") },
        "command-v:opencode": { error: new Error("not found") },
        "which:aider": { error: new Error("not found") },
        "command-v:aider": { error: new Error("not found") },
        "which:goose": { error: new Error("not found") },
        "command-v:goose": { error: new Error("not found") },
      });

      const detector = createAgentDetector();
      expect(await detector.isInstalled("codex")).toBe(false);
    });
  });

  // ===========================================================================
  // isDetecting()
  // ===========================================================================

  describe("isDetecting()", () => {
    it("returns false when not detecting", () => {
      const detector = createAgentDetector();
      expect(detector.isDetecting()).toBe(false);
    });
  });
});

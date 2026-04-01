/**
 * Workspace Handler Tests
 *
 * Tests the bridge between OpenHive's workspace.execute MAP messages
 * and MacroAgentBackend. Uses mocked backend to verify:
 * - Message parsing and routing
 * - Spawn config construction from workspace params
 * - Result collection from workspace output directory
 * - Error handling and timeout
 * - Response message format
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  handleWorkspaceExecute,
  isWorkspaceExecuteMessage,
  type WorkspaceHandlerDeps,
  type WorkspaceExecuteParams,
} from "../workspace-handler.js";
import type { MacroAgentBackend } from "../macro-agent-backend.js";
import type { CognitiveAgentSession } from "../types.js";

function createMockSession(overrides?: Partial<CognitiveAgentSession>): CognitiveAgentSession {
  return {
    id: "cognitive_test123",
    agentType: "claude-code",
    task: { description: "test task" },
    state: "completed",
    messages: [],
    toolCalls: [],
    startTime: new Date(),
    endTime: new Date(),
    metadata: {},
    ...overrides,
  };
}

function createMockBackend(session?: CognitiveAgentSession): MacroAgentBackend {
  const mockSession = session || createMockSession();
  return {
    name: "macro-agent",
    supportedTypes: ["claude-code"],
    spawn: vi.fn().mockResolvedValue(mockSession),
    getSession: vi.fn().mockResolvedValue(mockSession),
    terminate: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(true),
    listSessions: vi.fn().mockResolvedValue([mockSession]),
  } as unknown as MacroAgentBackend;
}

describe("isWorkspaceExecuteMessage", () => {
  it("should return true for workspace.execute messages", () => {
    expect(
      isWorkspaceExecuteMessage({
        method: "x-openhive/learning.workspace.execute",
      }),
    ).toBe(true);
  });

  it("should return false for other messages", () => {
    expect(isWorkspaceExecuteMessage({ method: "ping" })).toBe(false);
    expect(isWorkspaceExecuteMessage({ method: "_macro/cognitive/command" })).toBe(false);
    expect(isWorkspaceExecuteMessage({})).toBe(false);
  });
});

describe("handleWorkspaceExecute", () => {
  let sentMessages: object[];
  let deps: WorkspaceHandlerDeps;

  beforeEach(() => {
    sentMessages = [];
  });

  function setupDeps(backend: MacroAgentBackend): WorkspaceHandlerDeps {
    deps = {
      backend,
      sendToHub: (msg) => sentMessages.push(msg),
    };
    return deps;
  }

  it("should spawn an analyst and send success result", async () => {
    const session = createMockSession({ state: "completed", result: "analysis done" });
    const backend = createMockBackend(session);
    setupDeps(backend);

    const params: WorkspaceExecuteParams = {
      request_id: "req-001",
      prompt: "Analyze these trajectories",
      cwd: "/tmp/test-workspace",
      system_context: "You are an analysis agent",
      timeout: 5000,
    };

    await handleWorkspaceExecute(deps, params);

    // Backend should have been called with correct config
    expect(backend.spawn).toHaveBeenCalledOnce();
    const spawnCall = (backend.spawn as any).mock.calls[0][0];
    expect(spawnCall.agentType).toBe("claude-code");
    expect(spawnCall.task.description).toBe("Analyze these trajectories");
    expect(spawnCall.cwd).toBe("/tmp/test-workspace");
    expect(spawnCall.systemPromptAdditions).toBe("You are an analysis agent");
    expect(spawnCall.timeout).toBe(5000);

    // Result should be sent back
    expect(sentMessages.length).toBe(1);
    const result = sentMessages[0] as any;
    expect(result.jsonrpc).toBe("2.0");
    expect(result.method).toBe("x-openhive/learning.workspace.result");
    expect(result.params.request_id).toBe("req-001");
    expect(result.params.success).toBe(true);
    expect(result.params.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("should send failure result when session fails", async () => {
    const session = createMockSession({
      state: "failed",
      error: "Agent crashed",
    });
    const backend = createMockBackend(session);
    setupDeps(backend);

    await handleWorkspaceExecute(deps, {
      request_id: "req-002",
      prompt: "test",
      cwd: "/tmp/test",
    });

    const result = sentMessages[0] as any;
    expect(result.params.success).toBe(false);
    expect(result.params.error).toBe("Agent crashed");
  });

  it("should send error result when spawn throws", async () => {
    const backend = createMockBackend();
    (backend.spawn as any).mockRejectedValue(new Error("Spawn failed"));
    setupDeps(backend);

    await handleWorkspaceExecute(deps, {
      request_id: "req-003",
      prompt: "test",
      cwd: "/tmp/test",
    });

    const result = sentMessages[0] as any;
    expect(result.params.success).toBe(false);
    expect(result.params.error).toBe("Spawn failed");
    expect(result.params.request_id).toBe("req-003");
  });

  it("should read output files from workspace directory", async () => {
    // Create a temp workspace with output files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-handler-test-"));
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(outputDir);
    fs.writeFileSync(
      path.join(outputDir, "analysis.json"),
      JSON.stringify({ success: true, keySteps: [0, 1], abstractable: true }),
    );

    const session = createMockSession({ state: "completed" });
    const backend = createMockBackend(session);
    setupDeps(backend);

    await handleWorkspaceExecute(deps, {
      request_id: "req-004",
      prompt: "analyze",
      cwd: tmpDir,
    });

    const result = sentMessages[0] as any;
    expect(result.params.success).toBe(true);
    expect(result.params.structured).toEqual({
      success: true,
      keySteps: [0, 1],
      abstractable: true,
    });

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("should use session result as fallback when no output files", async () => {
    const session = createMockSession({
      state: "completed",
      result: { playbooks: ["pb-1"] },
    });
    const backend = createMockBackend(session);
    setupDeps(backend);

    await handleWorkspaceExecute(deps, {
      request_id: "req-005",
      prompt: "test",
      cwd: "/nonexistent/path",
    });

    const result = sentMessages[0] as any;
    expect(result.params.success).toBe(true);
    expect(result.params.structured).toEqual({ playbooks: ["pb-1"] });
  });

  it("should use default timeout when not specified", async () => {
    const session = createMockSession();
    const backend = createMockBackend(session);
    setupDeps(backend);

    await handleWorkspaceExecute(deps, {
      request_id: "req-006",
      prompt: "test",
      cwd: "/tmp/test",
    });

    const spawnCall = (backend.spawn as any).mock.calls[0][0];
    expect(spawnCall.timeout).toBe(300_000);
  });
});

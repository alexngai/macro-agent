/**
 * Trajectory Extractor Tests
 *
 * Tests that extractTrajectory() correctly converts CognitiveAgentSession
 * to CognitiveTrajectory with ReAct steps (thought/action/observation).
 */

import { describe, it, expect } from "vitest";
import { extractTrajectory, summarizeInput } from "../trajectory-extractor.js";
import type {
  CognitiveAgentSession,
  CognitiveAgentMessage,
  CognitiveToolCall,
} from "../types.js";

// ── Helpers ─────────────────────────────────────────────────────

function makeSession(
  overrides: Partial<CognitiveAgentSession> = {},
): CognitiveAgentSession {
  return {
    id: "session_1",
    agentType: "claude-code",
    task: { description: "Test task" },
    state: "completed",
    messages: [],
    toolCalls: [],
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T00:01:00Z"),
    result: "done",
    metadata: { macroAgentId: "agent_1" },
    ...overrides,
  };
}

function makeMessage(
  role: CognitiveAgentMessage["role"],
  content: string,
  timestamp: Date,
): CognitiveAgentMessage {
  return { role, content, timestamp };
}

function makeToolCall(
  overrides: Partial<CognitiveToolCall> = {},
): CognitiveToolCall {
  return {
    id: "tc_1",
    name: "Read",
    input: { file_path: "/src/index.ts" },
    output: "file contents here",
    startTime: new Date("2025-01-01T00:00:30Z"),
    endTime: new Date("2025-01-01T00:00:31Z"),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("extractTrajectory", () => {
  it("extracts steps from tool calls with thoughts from preceding messages", () => {
    const session = makeSession({
      messages: [
        makeMessage("assistant", "Let me read the file.", new Date("2025-01-01T00:00:28Z")),
      ],
      toolCalls: [
        makeToolCall({
          name: "Read",
          input: { file_path: "/src/index.ts" },
          output: "export const x = 1;",
          startTime: new Date("2025-01-01T00:00:30Z"),
        }),
      ],
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0].thought).toBe("Let me read the file.");
    expect(trajectory.steps[0].action).toContain("Read:");
    expect(trajectory.steps[0].action).toContain("/src/index.ts");
    expect(trajectory.steps[0].observation).toBe("export const x = 1;");
  });

  it("handles missing preceding messages (no thought)", () => {
    const session = makeSession({
      messages: [],
      toolCalls: [makeToolCall()],
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0].thought).toBeUndefined();
    expect(trajectory.steps[0].action).toContain("Read:");
  });

  it("ignores messages outside the 60s thought window", () => {
    const session = makeSession({
      messages: [
        // 2 minutes before the tool call — outside window
        makeMessage("assistant", "Old thought", new Date("2024-12-31T23:58:00Z")),
      ],
      toolCalls: [
        makeToolCall({ startTime: new Date("2025-01-01T00:00:30Z") }),
      ],
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.steps[0].thought).toBeUndefined();
  });

  it("maps completed session to success outcome", () => {
    const session = makeSession({
      state: "completed",
      result: { summary: "Analysis complete" },
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.outcome.success).toBe(true);
    expect(trajectory.outcome.solution).toEqual({ summary: "Analysis complete" });
    expect(trajectory.outcome.errorInfo).toBeUndefined();
  });

  it("maps failed session to failure outcome", () => {
    const session = makeSession({
      state: "failed",
      error: "Agent crashed",
      result: undefined,
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.outcome.success).toBe(false);
    expect(trajectory.outcome.errorInfo).toBe("Agent crashed");
    expect(trajectory.outcome.solution).toBeUndefined();
  });

  it("computes wall time correctly", () => {
    const session = makeSession({
      startTime: new Date("2025-01-01T00:00:00Z"),
      endTime: new Date("2025-01-01T00:01:30Z"),
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.wallTimeSeconds).toBe(90);
  });

  it("returns 0 wall time when endTime is missing", () => {
    const session = makeSession({ endTime: undefined });
    const trajectory = extractTrajectory(session);
    expect(trajectory.wallTimeSeconds).toBe(0);
  });

  it("handles empty session (no tool calls)", () => {
    const session = makeSession({
      messages: [
        makeMessage("assistant", "I have no tools to call.", new Date("2025-01-01T00:00:05Z")),
      ],
      toolCalls: [],
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.steps).toHaveLength(0);
    expect(trajectory.outcome.success).toBe(true);
  });

  it("counts LLM calls from assistant messages", () => {
    const session = makeSession({
      messages: [
        makeMessage("assistant", "First response", new Date("2025-01-01T00:00:05Z")),
        makeMessage("user", "Follow up", new Date("2025-01-01T00:00:10Z")),
        makeMessage("assistant", "Second response", new Date("2025-01-01T00:00:15Z")),
      ],
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.llmCalls).toBe(2);
  });

  it("uses macroAgentId from metadata for agentId", () => {
    const session = makeSession({
      metadata: { macroAgentId: "agent_42" },
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.agentId).toBe("agent_42");
  });

  it("falls back to session id when macroAgentId is missing", () => {
    const session = makeSession({
      id: "session_99",
      metadata: {},
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.agentId).toBe("session_99");
  });

  it("maps tool call errors to observation", () => {
    const session = makeSession({
      toolCalls: [
        makeToolCall({
          output: undefined,
          error: "Permission denied",
        }),
      ],
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.steps[0].observation).toBe("Error: Permission denied");
  });

  it("handles tool call with no output and no error", () => {
    const session = makeSession({
      toolCalls: [
        makeToolCall({ output: undefined, error: undefined }),
      ],
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.steps[0].observation).toBe("(no output)");
  });

  it("truncates long thoughts to 500 chars", () => {
    const longThought = "A".repeat(600);
    const session = makeSession({
      messages: [
        makeMessage("assistant", longThought, new Date("2025-01-01T00:00:28Z")),
      ],
      toolCalls: [
        makeToolCall({ startTime: new Date("2025-01-01T00:00:30Z") }),
      ],
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.steps[0].thought!.length).toBe(500);
    expect(trajectory.steps[0].thought!.endsWith("...")).toBe(true);
  });

  it("preserves task metadata in trajectory", () => {
    const session = makeSession({
      task: { description: "Analyze data", domain: "analysis" },
    });

    const trajectory = extractTrajectory(session);

    expect(trajectory.task.description).toBe("Analyze data");
    expect(trajectory.task.domain).toBe("analysis");
    expect(trajectory.metadata.sessionId).toBe("session_1");
    expect(trajectory.metadata.agentType).toBe("claude-code");
  });
});

describe("summarizeInput", () => {
  it("returns empty string for null/undefined", () => {
    expect(summarizeInput(null)).toBe("");
    expect(summarizeInput(undefined)).toBe("");
  });

  it("truncates long JSON to 200 chars", () => {
    const longInput = { data: "X".repeat(300) };
    const result = summarizeInput(longInput);
    expect(result.length).toBe(200);
    expect(result.endsWith("...")).toBe(true);
  });

  it("preserves short inputs", () => {
    const result = summarizeInput({ file: "test.ts" });
    expect(result).toBe('{"file":"test.ts"}');
  });

  it("handles non-serializable input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = summarizeInput(circular);
    expect(result).toBe("[object Object]");
  });
});

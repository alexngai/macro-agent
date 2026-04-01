import { describe, it, expect } from "vitest";
import type { ExtendedSessionUpdate } from "acp-factory";
import {
  convertUpdatesToSession,
  updateSessionFromEvent,
} from "../session-converter.js";
import type { CognitiveAgentSession, CognitiveTask } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeUpdate(
  overrides: Record<string, unknown>,
): ExtendedSessionUpdate {
  return overrides as unknown as ExtendedSessionUpdate;
}

function makeTask(description = "Analyze trajectory"): CognitiveTask {
  return { description };
}

function makeEmptySession(): CognitiveAgentSession {
  return {
    id: "test-session",
    agentType: "claude-code",
    task: makeTask(),
    state: "running",
    messages: [],
    toolCalls: [],
    startTime: new Date(),
    metadata: {},
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("convertUpdatesToSession", () => {
  it("creates session with correct metadata", () => {
    const session = convertUpdatesToSession(
      [],
      "sess-1",
      "claude-code",
      makeTask("test task"),
    );

    expect(session.id).toBe("sess-1");
    expect(session.agentType).toBe("claude-code");
    expect(session.task.description).toBe("test task");
    expect(session.state).toBe("running");
    expect(session.messages).toEqual([]);
    expect(session.toolCalls).toEqual([]);
  });

  it("processes all updates in order", () => {
    const updates = [
      makeUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Thinking about the analysis..." },
      }),
      makeUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "read_file",
        rawInput: { path: "input/data.json" },
      }),
      makeUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        content: [{ type: "text", text: '{"data": "value"}' }],
      }),
    ];

    const session = convertUpdatesToSession(
      updates,
      "sess-2",
      "claude-code",
      makeTask(),
    );

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]!.content).toBe(
      "Thinking about the analysis...",
    );
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]!.name).toBe("read_file");
    expect(session.toolCalls[0]!.output).toBe('{"data": "value"}');
  });
});

describe("updateSessionFromEvent", () => {
  describe("agent_message_chunk", () => {
    it("creates assistant message", () => {
      const session = makeEmptySession();
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        }),
      );

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]!.role).toBe("assistant");
      expect(session.messages[0]!.content).toBe("Hello");
    });

    it("ignores non-text content", () => {
      const session = makeEmptySession();
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", url: "..." },
        }),
      );

      expect(session.messages).toHaveLength(0);
    });
  });

  describe("user_message_chunk", () => {
    it("creates user message", () => {
      const session = makeEmptySession();
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Do the analysis" },
        }),
      );

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]!.role).toBe("user");
    });
  });

  describe("agent_thought_chunk", () => {
    it("creates assistant message", () => {
      const session = makeEmptySession();
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Let me think..." },
        }),
      );

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]!.role).toBe("assistant");
      expect(session.messages[0]!.content).toBe("Let me think...");
    });
  });

  describe("tool_call", () => {
    it("creates tool call entry", () => {
      const session = makeEmptySession();
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "write_file",
          rawInput: { path: "output/result.json", content: "{}" },
        }),
      );

      expect(session.toolCalls).toHaveLength(1);
      expect(session.toolCalls[0]!.id).toBe("tc-1");
      expect(session.toolCalls[0]!.name).toBe("write_file");
      expect(session.toolCalls[0]!.input).toEqual({
        path: "output/result.json",
        content: "{}",
      });
      expect(session.toolCalls[0]!.startTime).toBeInstanceOf(Date);
    });

    it("generates ID when toolCallId is missing", () => {
      const session = makeEmptySession();
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call",
          title: "read_file",
          rawInput: {},
        }),
      );

      expect(session.toolCalls[0]!.id).toBeTruthy();
      expect(session.toolCalls[0]!.id).toContain("tc_");
    });

    it("defaults name to unknown when title is missing", () => {
      const session = makeEmptySession();
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-2",
        }),
      );

      expect(session.toolCalls[0]!.name).toBe("unknown");
    });
  });

  describe("tool_call_update", () => {
    it("updates existing tool call with output on completion", () => {
      const session = makeEmptySession();

      // Create tool call first
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "read_file",
          rawInput: { path: "input/data.json" },
        }),
      );

      // Then update it
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [{ type: "text", text: "file contents here" }],
        }),
      );

      expect(session.toolCalls[0]!.output).toBe("file contents here");
      expect(session.toolCalls[0]!.endTime).toBeInstanceOf(Date);
      expect(session.toolCalls[0]!.error).toBeUndefined();
    });

    it("sets error on failed status", () => {
      const session = makeEmptySession();

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "read_file",
          rawInput: {},
        }),
      );

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "failed",
        }),
      );

      expect(session.toolCalls[0]!.error).toBe("Tool call failed");
      expect(session.toolCalls[0]!.endTime).toBeInstanceOf(Date);
    });

    it("handles diff content blocks", () => {
      const session = makeEmptySession();

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "edit_file",
          rawInput: {},
        }),
      );

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [{ type: "diff", diff: "- old\n+ new" }],
        }),
      );

      expect(session.toolCalls[0]!.output).toBe("- old\n+ new");
    });

    it("concatenates multiple content blocks", () => {
      const session = makeEmptySession();

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "search",
          rawInput: {},
        }),
      );

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [
            { type: "text", text: "Result 1" },
            { type: "text", text: "Result 2" },
          ],
        }),
      );

      expect(session.toolCalls[0]!.output).toBe("Result 1\nResult 2");
    });

    it("ignores update for non-existent tool call", () => {
      const session = makeEmptySession();

      // Update without a preceding tool_call — should not throw
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "nonexistent",
          status: "completed",
          content: [{ type: "text", text: "output" }],
        }),
      );

      expect(session.toolCalls).toHaveLength(0);
    });
  });

  describe("plan", () => {
    it("creates assistant message with plan content", () => {
      const session = makeEmptySession();
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "plan",
          plan: { steps: ["step1", "step2"] },
        }),
      );

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]!.role).toBe("assistant");
      expect(session.messages[0]!.content).toContain("[Plan]");
    });
  });

  describe("unknown events", () => {
    it("stores update type in metadata", () => {
      const session = makeEmptySession();
      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "compaction_started",
        }),
      );

      expect(session.metadata.lastUpdate).toBe("compaction_started");
    });
  });

  describe("interleaved events", () => {
    it("handles messages interleaved with tool calls", () => {
      const session = makeEmptySession();

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Let me read the file" },
        }),
      );

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "read_file",
          rawInput: { path: "input/data.json" },
        }),
      );

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          content: [{ type: "text", text: "{}" }],
        }),
      );

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Now I'll write the output" },
        }),
      );

      updateSessionFromEvent(
        session,
        makeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-2",
          title: "write_file",
          rawInput: { path: "output/result.json" },
        }),
      );

      expect(session.messages).toHaveLength(2);
      expect(session.toolCalls).toHaveLength(2);
      expect(session.toolCalls[0]!.output).toBe("{}");
      expect(session.toolCalls[1]!.name).toBe("write_file");
    });
  });
});

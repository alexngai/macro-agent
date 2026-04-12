/**
 * Tests for the Claude Code JSONL → ACP SessionUpdate converter.
 *
 * Verifies that the replay fallback correctly parses real-world Claude Code
 * transcript entries and emits the right sessionUpdate events in order.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { replayClaudeCodeTranscript } from "../claude-code-replay.js";

function jsonl(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

async function collectUpdates(sessionId: string): Promise<any[]> {
  const updates: any[] = [];
  for await (const u of replayClaudeCodeTranscript(sessionId)) {
    updates.push(u);
  }
  return updates;
}

describe("replayClaudeCodeTranscript", () => {
  const testProjectDir = `-test-replay-${randomBytes(4).toString("hex")}`;
  const claudeProjectsRoot = path.join(os.homedir(), ".claude", "projects");
  const fixtureDir = path.join(claudeProjectsRoot, testProjectDir);
  const nonExistentSessionId = "00000000-0000-0000-0000-000000000000";

  beforeAll(async () => {
    await fs.mkdir(fixtureDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it("returns no updates when transcript file doesn't exist", async () => {
    const updates = await collectUpdates(nonExistentSessionId);
    expect(updates).toEqual([]);
  });

  it("converts a simple user/assistant exchange", async () => {
    const sessionId = `sess-simple-${randomBytes(4).toString("hex")}`;
    const transcript =
      jsonl({ type: "queue-operation", operation: "enqueue" }) +  // skip
      jsonl({
        type: "user",
        isMeta: false,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      }) +
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
        },
      });
    await fs.writeFile(path.join(fixtureDir, `${sessionId}.jsonl`), transcript);

    const updates = await collectUpdates(sessionId);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hello" },
    });
    expect(updates[1]).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi there" },
    });
  });

  it("skips meta messages and internal commands", async () => {
    const sessionId = `sess-meta-${randomBytes(4).toString("hex")}`;
    const transcript =
      jsonl({
        type: "user",
        isMeta: true,   // should skip
        message: { role: "user", content: "system context" },
      }) +
      jsonl({
        type: "user",
        message: { role: "user", content: "<command-name>/model</command-name>" },
      }) +  // string starting with <command- → skip
      jsonl({
        type: "user",
        message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" },
      }) +  // skip
      jsonl({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "real message" }] },
      });
    await fs.writeFile(path.join(fixtureDir, `${sessionId}.jsonl`), transcript);

    const updates = await collectUpdates(sessionId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "real message" },
    });
  });

  it("converts tool_use and tool_result blocks", async () => {
    const sessionId = `sess-tools-${randomBytes(4).toString("hex")}`;
    const transcript =
      jsonl({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            {
              type: "tool_use",
              id: "tc_1",
              name: "Read",
              input: { path: "/tmp/foo" },
            },
          ],
        },
      }) +
      jsonl({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tc_1",
              content: "file contents",
            },
          ],
        },
      });
    await fs.writeFile(path.join(fixtureDir, `${sessionId}.jsonl`), transcript);

    const updates = await collectUpdates(sessionId);
    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me check." },
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tc_1",
      title: "Read",
      rawInput: { path: "/tmp/foo" },
    });
    expect(updates[2]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_1",
      output: "file contents",
      status: "completed",
    });
  });

  it("handles assistant thinking blocks", async () => {
    const sessionId = `sess-think-${randomBytes(4).toString("hex")}`;
    const transcript = jsonl({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "text", text: "Here's my answer." },
        ],
      },
    });
    await fs.writeFile(path.join(fixtureDir, `${sessionId}.jsonl`), transcript);

    const updates = await collectUpdates(sessionId);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Let me reason about this..." },
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
    });
  });

  it("ignores malformed JSONL lines and continues", async () => {
    const sessionId = `sess-bad-${randomBytes(4).toString("hex")}`;
    const transcript =
      "not-json\n" +
      "{\n" +  // incomplete
      jsonl({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "after garbage" }] },
      }) +
      "\n";  // blank line
    await fs.writeFile(path.join(fixtureDir, `${sessionId}.jsonl`), transcript);

    const updates = await collectUpdates(sessionId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      content: { type: "text", text: "after garbage" },
    });
  });

  it("produces events in chronological (file) order", async () => {
    const sessionId = `sess-order-${randomBytes(4).toString("hex")}`;
    const transcript = Array.from({ length: 5 }, (_, i) =>
      jsonl({
        type: i % 2 === 0 ? "user" : "assistant",
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `msg-${i}` }],
        },
      }),
    ).join("");
    await fs.writeFile(path.join(fixtureDir, `${sessionId}.jsonl`), transcript);

    const updates = await collectUpdates(sessionId);
    expect(updates.map((u) => u.content?.text)).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
  });
});

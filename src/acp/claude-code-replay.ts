/**
 * Claude Code JSONL → ACP SessionUpdate replay
 *
 * Works around a gap in claude-code-acp where `loadSession` does NOT emit
 * `session/update` notifications for historical conversation content — it only
 * tells the Claude Code subprocess to restore context internally. That means
 * clients (like OpenHive) calling ACP's `session/load` get back an empty
 * session.
 *
 * Per the ACP spec (https://agentclientprotocol.com/protocol/session-setup#loading-sessions),
 * loadSession SHOULD stream the conversation history back via session/update
 * notifications. This module reads Claude Code's native JSONL transcript (which
 * Claude Code always persists, no hooks required) and converts each entry to
 * ACP SessionUpdate events so the client can reconstruct the conversation.
 *
 * TODO(upstream): fix claude-code-acp so this workaround becomes unnecessary.
 * See node_modules/@sudocode-ai/claude-code-acp/dist/acp-agent.js:344-353.
 *
 * @module acp/claude-code-replay
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

/**
 * Locate Claude Code's JSONL transcript for the given session.
 *
 * Claude Code writes transcripts to `~/.claude/projects/{encoded-cwd}/{session-id}.jsonl`.
 * The cwd encoding replaces `/` with `-` (e.g., `/tmp/x` → `-private-tmp-x` on macOS
 * where /tmp is a symlink). Rather than replicating the encoding exactly, we scan
 * project directories for a file matching the session ID — the ID is a UUID so
 * collisions are not a concern.
 */
async function locateTranscript(providerSessionId: string): Promise<string | null> {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  let dirents: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    // @ts-expect-error — withFileTypes overload returns Dirent[]
    dirents = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirents as unknown as Array<{ isDirectory(): boolean; name: string }>) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(projectsRoot, d.name, `${providerSessionId}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Not in this dir — keep scanning
    }
  }
  return null;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: "thinking"; thinking?: string; text?: string };

interface JsonlEntry {
  type?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  uuid?: string;
  timestamp?: string;
}

/**
 * Convert a user message content block into an ACP SessionUpdate.
 */
function userBlockToUpdate(block: ContentBlock): SessionUpdate | null {
  if (block.type === "text" && block.text) {
    return {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: block.text },
    } as unknown as SessionUpdate;
  }
  if (block.type === "tool_result") {
    const output =
      typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content);
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: block.tool_use_id,
      output,
      status: block.is_error ? "failed" : "completed",
    } as unknown as SessionUpdate;
  }
  return null;
}

/**
 * Convert an assistant message content block into an ACP SessionUpdate.
 */
function assistantBlockToUpdate(block: ContentBlock): SessionUpdate | null {
  if (block.type === "text" && block.text) {
    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: block.text },
    } as unknown as SessionUpdate;
  }
  if (block.type === "tool_use") {
    return {
      sessionUpdate: "tool_call",
      toolCallId: block.id,
      title: block.name,
      rawInput: block.input,
      status: "pending",
    } as unknown as SessionUpdate;
  }
  if (block.type === "thinking") {
    const text = block.thinking ?? block.text ?? "";
    if (!text) return null;
    return {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    } as unknown as SessionUpdate;
  }
  return null;
}

/**
 * Check if a string user-message looks like a Claude Code internal command
 * (e.g., `<command-name>/model</command-name>`, `<local-command-stdout>...`).
 * These get recorded in the JSONL but aren't part of the conversation UX.
 */
function isInternalCommand(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<command-") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<system-reminder") ||
    t.startsWith("Caveat:")
  );
}

/**
 * Read Claude Code's JSONL transcript for a session and yield ACP SessionUpdate
 * events suitable for emitting via `connection.sessionUpdate({ sessionId, update })`.
 *
 * Yields events in chronological order. Returns early (yields nothing) if the
 * transcript file doesn't exist — e.g., the agent is running on a different
 * machine.
 */
export async function* replayClaudeCodeTranscript(
  providerSessionId: string,
): AsyncGenerator<SessionUpdate> {
  const jsonlPath = await locateTranscript(providerSessionId);
  if (!jsonlPath) return;

  let raw: string;
  try {
    raw = await fs.readFile(jsonlPath, "utf-8");
  } catch {
    return;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: JsonlEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Skip non-conversation entries (queue-operations, summaries, etc.)
    if (entry.type !== "user" && entry.type !== "assistant") continue;

    // Skip meta messages (local command output, system injections)
    if (entry.isMeta) continue;

    const message = entry.message;
    if (!message) continue;
    const content = message.content;

    if (entry.type === "user") {
      if (typeof content === "string") {
        if (isInternalCommand(content)) continue;
        yield {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: content },
        } as unknown as SessionUpdate;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const upd = userBlockToUpdate(block);
          if (upd) yield upd;
        }
      }
    } else if (entry.type === "assistant") {
      if (Array.isArray(content)) {
        for (const block of content) {
          const upd = assistantBlockToUpdate(block);
          if (upd) yield upd;
        }
      }
    }
  }
}

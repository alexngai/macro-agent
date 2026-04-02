/**
 * Session Converter
 *
 * Converts macro-agent's ExtendedSessionUpdate stream into CognitiveAgentSession.
 * This is the proto-agent-session-parser — will be extracted to a shared package
 * in Phase 2/3.
 *
 * Reference: cognitive-core's ACPProtocolHandler.processUpdate()
 * at references/cognitive-core/src/runtime/backends/acp-protocol.ts
 */

import type { ExtendedSessionUpdate } from "acp-factory";
import type {
  CognitiveAgentSession,
  CognitiveAgentMessage,
  CognitiveToolCall,
  CognitiveTask,
} from "./types.js";

/**
 * Convert a batch of ExtendedSessionUpdate events into a CognitiveAgentSession.
 *
 * @param updates - Array of session update events from macro-agent prompt()
 * @param sessionId - Session ID to assign
 * @param agentType - Agent type (e.g., 'claude-code')
 * @param task - Task description
 * @returns Populated session with messages and tool calls
 */
export function convertUpdatesToSession(
  updates: ExtendedSessionUpdate[],
  sessionId: string,
  agentType: string,
  task: CognitiveTask,
): CognitiveAgentSession {
  const session: CognitiveAgentSession = {
    id: sessionId,
    agentType,
    task,
    state: "running",
    messages: [],
    toolCalls: [],
    startTime: new Date(),
    metadata: {},
  };

  for (const update of updates) {
    updateSessionFromEvent(session, update);
  }

  return session;
}

/**
 * Incrementally update a CognitiveAgentSession from a single ExtendedSessionUpdate.
 * Used for streaming: call this as each update arrives.
 *
 * Uses defensive typing since ACP's ExtendedSessionUpdate is a complex union type.
 */
export function updateSessionFromEvent(
  session: CognitiveAgentSession,
  update: ExtendedSessionUpdate,
): void {
  const u = update as Record<string, unknown>;
  const updateType = u.sessionUpdate as string;

  switch (updateType) {
    case "agent_message_chunk":
    case "user_message_chunk":
    case "agent_thought_chunk": {
      const content = u.content as Record<string, unknown> | undefined;
      if (
        content &&
        content.type === "text" &&
        typeof content.text === "string"
      ) {
        const message: CognitiveAgentMessage = {
          role: updateType === "user_message_chunk" ? "user" : "assistant",
          content: content.text,
          timestamp: new Date(),
        };
        session.messages.push(message);
      }
      break;
    }

    case "tool_call": {
      const toolCallId =
        (u.toolCallId as string) ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const title = (u.title as string) ?? "unknown";
      const rawInput = u.rawInput;

      const toolCall: CognitiveToolCall = {
        id: toolCallId,
        name: title,
        input: rawInput,
        startTime: new Date(),
      };
      session.toolCalls.push(toolCall);
      break;
    }

    case "tool_call_update": {
      const toolCallId = u.toolCallId as string;
      const status = u.status as string | undefined;
      const content = u.content as
        | Array<Record<string, unknown>>
        | undefined;

      const existingTc = session.toolCalls.find((t) => t.id === toolCallId);
      if (existingTc) {
        if (status === "completed" || status === "failed") {
          existingTc.endTime = new Date();
        }
        if (content && Array.isArray(content)) {
          const outputs: string[] = [];
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
              outputs.push(block.text);
            } else if (
              block.type === "diff" &&
              typeof block.diff === "string"
            ) {
              outputs.push(block.diff);
            }
          }
          if (outputs.length > 0) {
            existingTc.output = outputs.join("\n");
          }
        }
        if (status === "failed") {
          existingTc.error = "Tool call failed";
        }
      }
      break;
    }

    case "plan": {
      const plan = u.plan;
      session.messages.push({
        role: "assistant",
        content: `[Plan] ${JSON.stringify(plan)}`,
        timestamp: new Date(),
      });
      break;
    }

    default:
      // Store last unrecognized update for debugging
      session.metadata.lastUpdate = updateType;
  }
}

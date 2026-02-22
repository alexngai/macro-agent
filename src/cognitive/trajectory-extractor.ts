/**
 * Trajectory Extractor
 *
 * Converts a completed CognitiveAgentSession into a CognitiveTrajectory
 * (ReAct format: thought → action → observation steps).
 *
 * Mirrors cognitive-core's DefaultTrajectoryExtractor.extract() logic
 * without importing from cognitive-core.
 */

import { nanoid } from "nanoid";
import type {
  CognitiveAgentSession,
  CognitiveTrajectory,
  CognitiveStep,
  CognitiveOutcome,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const MAX_THOUGHT_LENGTH = 500;
const MAX_INPUT_LENGTH = 200;
const MAX_OBSERVATION_LENGTH = 2000;
const THOUGHT_WINDOW_MS = 60_000; // 60s lookback for preceding assistant message

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

/**
 * Extract a CognitiveTrajectory from a completed CognitiveAgentSession.
 *
 * For each tool call:
 * 1. thought: preceding assistant message (within 60s window), truncated
 * 2. action: "toolName: summarizedInput"
 * 3. observation: tool output or error
 */
export function extractTrajectory(
  session: CognitiveAgentSession,
): CognitiveTrajectory {
  const steps = extractSteps(session);
  const outcome = extractOutcome(session);
  const wallTimeSeconds = computeWallTime(session);

  return {
    id: `traj_${nanoid(12)}`,
    task: session.task,
    steps,
    outcome,
    agentId: (session.metadata.macroAgentId as string) ?? session.id,
    timestamp: session.startTime,
    llmCalls: countLLMCalls(session),
    totalTokens: 0, // Token counts not available from session data
    wallTimeSeconds,
    metadata: {
      sessionId: session.id,
      agentType: session.agentType,
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────

function extractSteps(session: CognitiveAgentSession): CognitiveStep[] {
  return session.toolCalls.map((tc) => {
    // Find preceding assistant message within the time window
    const thought = findPrecedingThought(session, tc.startTime);

    // Build action string
    const action = `${tc.name}: ${summarizeInput(tc.input)}`;

    // Build observation from output or error
    let observation: string;
    if (tc.error) {
      observation = `Error: ${tc.error}`;
    } else if (tc.output !== undefined) {
      observation = truncate(String(tc.output), MAX_OBSERVATION_LENGTH);
    } else {
      observation = "(no output)";
    }

    return {
      thought: thought ? truncate(thought, MAX_THOUGHT_LENGTH) : undefined,
      action,
      observation,
      timestamp: tc.startTime,
    };
  });
}

function findPrecedingThought(
  session: CognitiveAgentSession,
  toolCallTime: Date,
): string | undefined {
  const toolTime = toolCallTime.getTime();

  // Search backward for the most recent assistant message within the window
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;

    const msgTime = msg.timestamp.getTime();
    if (msgTime > toolTime) continue; // After tool call
    if (toolTime - msgTime > THOUGHT_WINDOW_MS) break; // Too old

    return msg.content;
  }

  return undefined;
}

function extractOutcome(session: CognitiveAgentSession): CognitiveOutcome {
  if (session.state === "completed") {
    return {
      success: true,
      solution: session.result,
    };
  }
  return {
    success: false,
    errorInfo: session.error ?? "Unknown failure",
  };
}

function computeWallTime(session: CognitiveAgentSession): number {
  if (!session.endTime) return 0;
  return (session.endTime.getTime() - session.startTime.getTime()) / 1000;
}

function countLLMCalls(session: CognitiveAgentSession): number {
  // Each assistant message represents an LLM call
  return session.messages.filter((m) => m.role === "assistant").length;
}

/**
 * Summarize a tool input for the action string.
 * Truncates JSON.stringify output to maxLength chars.
 */
export function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    const json = JSON.stringify(input);
    return truncate(json, MAX_INPUT_LENGTH);
  } catch {
    return truncate(String(input), MAX_INPUT_LENGTH);
  }
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}

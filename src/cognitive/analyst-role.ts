/**
 * Analyst Role Definition
 *
 * Cognitive analysis agent for Atlas workspace templates.
 * Minimal capabilities: reads input files, writes output files, calls done().
 * No git, no spawning, no workspace isolation (cognitive-core manages workspaces).
 *
 * Registered programmatically by MacroAgentBackend in Phase 1.
 * Moves to team YAML in Phase 2.
 */

import type { RoleDefinition } from "../roles/types.js";
import {
  FILE_CAPABILITIES,
  EXEC_CAPABILITIES,
  LIFECYCLE_CAPABILITIES,
} from "../roles/capabilities.js";

export const AnalystRole: RoleDefinition = {
  name: "analyst",
  displayName: "Analyst",
  description: "Cognitive analysis agent for workspace templates",

  capabilities: [
    FILE_CAPABILITIES.READ,
    FILE_CAPABILITIES.WRITE,
    EXEC_CAPABILITIES.COMMAND,
    LIFECYCLE_CAPABILITIES.DONE,
  ],

  workspace: {
    type: "none",
  },

  lifecycle: {
    type: "ephemeral",
    taskBound: true,
    cascadeTerminate: true,
    selfCleanup: true,
  },

  protocol: {
    subscriptions: [],
    canEmit: ["WORKER_DONE"],
  },

  systemPrompt: `You are an analysis agent. Your workspace contains input/ and output/ directories.

1. Read the input files described in your task
2. Perform the requested analysis
3. Write your results to output/ in the exact JSON schema specified in the task
4. Call done({ status: "completed", summary: "Brief description of analysis performed" })

IMPORTANT:
- Do NOT commit, push, or spawn other agents
- Do NOT modify files outside the workspace
- Focus only on reading input, performing analysis, and writing output
- You MUST call done() when finished`,
};

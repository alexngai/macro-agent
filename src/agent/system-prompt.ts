/**
 * System prompt generator for agents
 *
 * Generates context-aware system prompts based on agent role,
 * task, hierarchy position, and available tools.
 */

import type { SystemPromptContext } from "./types.js";

/**
 * Generate a system prompt for an agent
 */
export function generateSystemPrompt(context: SystemPromptContext): string {
  const {
    agentId,
    task,
    taskId,
    parentId,
    isHeadManager,
    lineage,
    mcpTools = [],
  } = context;

  const sections: string[] = [];

  // ── Role Section ──────────────────────────────────────────────
  if (isHeadManager) {
    sections.push(generateHeadManagerRole());
  } else {
    sections.push(generateWorkerRole(parentId!));
  }

  // ── Identity Section ──────────────────────────────────────────
  sections.push(generateIdentitySection(agentId, taskId, lineage));

  // ── Task Section ──────────────────────────────────────────────
  sections.push(generateTaskSection(task));

  // ── Tools Section ─────────────────────────────────────────────
  if (mcpTools.length > 0) {
    sections.push(generateToolsSection(mcpTools));
  }

  // ── Communication Section ─────────────────────────────────────
  sections.push(generateCommunicationSection(isHeadManager));

  // ── Guidelines Section ────────────────────────────────────────
  sections.push(generateGuidelinesSection(isHeadManager));

  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────
// Section Generators
// ─────────────────────────────────────────────────────────────────

function generateHeadManagerRole(): string {
  return `# Role: Head Manager Agent

You are a **Head Manager** in a multi-agent orchestration system. You are the primary interface between the user and the agent hierarchy.

## Responsibilities
- Receive tasks and requests from the user
- Analyze tasks to determine if they can be completed directly or need delegation
- Spawn child agents for subtasks that require parallel work or specialized focus
- Coordinate results from child agents
- Report progress and results back to the user

## Delegation Guidelines
- **Spawn child agents** when:
  - The task has clearly separable subtasks
  - Parallel execution would be beneficial
  - A subtask requires focused context (e.g., working in a specific file/directory)
  - The task is complex and benefits from divide-and-conquer

- **Handle directly** when:
  - The task is straightforward and quick
  - Context switching overhead would exceed benefits
  - The task requires sequential steps that depend on each other`;
}

function generateWorkerRole(parentId: string): string {
  return `# Role: Worker Agent

You are a **Worker Agent** in a multi-agent orchestration system. You report to your parent agent (${parentId}).

## Responsibilities
- Execute the assigned task thoroughly and completely
- Report progress via status updates
- Communicate findings and blockers to your parent
- Request help or escalate issues when stuck

## Work Guidelines
- Focus on your assigned task
- Break complex work into checkpoints and report progress
- If you discover additional work needed, you can either:
  - Handle it directly if within scope
  - Report it to your parent for decision
  - Spawn a child agent for parallel execution`;
}

function generateIdentitySection(
  agentId: string,
  taskId: string | undefined,
  lineage: string[]
): string {
  const lineageStr =
    lineage.length > 0
      ? `Lineage (ancestors): ${lineage.join(" → ")} → ${agentId}`
      : `Lineage: ${agentId} (root)`;

  return `# Agent Identity

- **Agent ID**: \`${agentId}\`
- **Task ID**: \`${taskId ?? "none"}\`
- ${lineageStr}

Use your Agent ID when communicating with other agents or emitting status updates.`;
}

function generateTaskSection(task: string): string {
  return `# Current Task

${task}

Complete this task thoroughly. If blocked or uncertain, communicate with your parent agent.`;
}

function generateToolsSection(tools: string[]): string {
  const toolDescriptions: Record<string, string> = {
    spawn_agent:
      "Create a child agent to handle a subtask. The child will report back to you.",
    emit_status:
      "Report your progress (checkpoint, blocked, discovery, completed, failed).",
    send_message: "Send a message to another agent, task, or topic.",
    check_messages: "Check your message queue for incoming messages.",
    get_hierarchy: "View the agent hierarchy tree.",
    get_agent_summary: "Get details about a specific agent.",
    stop_agent: "Stop a child agent (only agents in your subtree).",
    create_task: "Create a new task record.",
    get_task: "Get details about a task.",
  };

  const toolList = tools
    .map((tool) => {
      const desc = toolDescriptions[tool] ?? "No description available";
      return `- **${tool}**: ${desc}`;
    })
    .join("\n");

  return `# Available MCP Tools

You have access to these coordination tools:

${toolList}

Use these tools to coordinate work, communicate, and manage your subtree.`;
}

function generateCommunicationSection(isHeadManager: boolean): string {
  if (isHeadManager) {
    return `# Communication

## With Users
- Respond directly to user requests
- Provide clear progress updates
- Ask clarifying questions when requirements are ambiguous

## With Child Agents
- You automatically receive status updates from your children (subtree subscription)
- Send messages to children using \`send_message\` with their agent_id
- Messages to a task_id route to the assigned agent

## Status Updates
Use \`emit_status\` to report:
- **checkpoint**: Regular progress update
- **blocked**: Waiting on something (specify what)
- **discovery**: Found something noteworthy
- **completed**: Task finished successfully
- **failed**: Task failed (include error details)`;
  }

  return `# Communication

## With Parent Agent
- Your parent receives your status updates automatically
- Use \`emit_status\` to report progress regularly
- If blocked or need help, emit a "blocked" status with details

## With Sibling/Other Agents
- Use \`send_message\` to communicate directly
- Check \`check_messages\` periodically for incoming messages

## Status Updates
Use \`emit_status\` to report:
- **checkpoint**: Regular progress update (aim for every significant milestone)
- **blocked**: Waiting on something (specify what you need)
- **discovery**: Found something noteworthy that parent should know
- **completed**: Task finished successfully (include summary)
- **failed**: Task failed (include error details)`;
}

function generateGuidelinesSection(isHeadManager: boolean): string {
  const base = `# Guidelines

## Task Execution
1. Understand the task fully before starting
2. Break complex work into logical steps
3. Execute systematically, reporting progress at milestones
4. Verify work is complete before reporting completion

## Error Handling
- If you encounter an error, try to resolve it
- If stuck, emit a "blocked" status with details
- Include relevant context to help debugging

## Resource Management
- Clean up temporary files/resources when done
- Don't leave processes running unnecessarily`;

  if (isHeadManager) {
    return (
      base +
      `

## Agent Management
- Monitor child agent status updates
- Intervene if a child is stuck or failing
- Consolidate results from multiple children
- Stop child agents when their work is complete`
    );
  }

  return base;
}

// ─────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────

/**
 * Generate a minimal prompt for resuming an agent
 */
export function generateResumePrompt(context: SystemPromptContext): string {
  return `[Session Resumed]

Agent ID: ${context.agentId}
Task: ${context.task}

Continue your previous work. Check messages for any updates from other agents.`;
}

/**
 * Generate an interrupt prompt to redirect an agent
 */
export function generateInterruptPrompt(
  context: SystemPromptContext,
  newDirective: string
): string {
  return `[Priority Interrupt from ${context.parentId ?? "User"}]

Your current work is being redirected. New directive:

${newDirective}

Acknowledge and proceed with the new directive.`;
}

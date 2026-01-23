/**
 * Harness Assertions - Built-in assertions for test harness
 *
 * Provides clear error messages when assertions fail.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7hpt Phase 3: TestHarness Class and Assertions
 */

import { execSync } from "child_process";
import type { EventStore } from "../../../src/store/event-store.js";
import type { TaskManager } from "../../../src/task/task-manager.js";
import type { MessageRouter } from "../../../src/router/message-router.js";
import type { AgentSimulator } from "../simulator/types.js";

/**
 * Assertion error with additional context
 */
export class HarnessAssertionError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HarnessAssertionError";
  }
}

/**
 * Context for assertions
 */
export interface AssertionContext {
  eventStore: EventStore;
  taskManager: TaskManager;
  messageRouter: MessageRouter;
  simulators: Map<string, AgentSimulator>;
  repoPath: string;
}

/**
 * Assert that an agent has terminated (not running)
 */
export function assertAgentTerminated(
  context: AssertionContext,
  agentId: string
): void {
  const agent = context.eventStore.getAgent(agentId);

  if (!agent) {
    throw new HarnessAssertionError(
      `Agent ${agentId} not found in EventStore`,
      { agentId }
    );
  }

  if (agent.state !== "stopped") {
    throw new HarnessAssertionError(
      `Expected agent ${agentId} to be terminated, but state is "${agent.state}"`,
      { agentId, actualState: agent.state }
    );
  }

  // Also check simulator if registered
  const simulator = context.simulators.get(agentId);
  if (simulator && simulator.isRunning()) {
    throw new HarnessAssertionError(
      `Agent ${agentId} EventStore state is stopped, but simulator is still running`,
      { agentId }
    );
  }
}

/**
 * Assert that an agent is in a specific state
 */
export function assertAgentState(
  context: AssertionContext,
  agentId: string,
  expectedState: "running" | "stopped" | "paused"
): void {
  const agent = context.eventStore.getAgent(agentId);

  if (!agent) {
    throw new HarnessAssertionError(
      `Agent ${agentId} not found in EventStore`,
      { agentId, expectedState }
    );
  }

  if (agent.state !== expectedState) {
    throw new HarnessAssertionError(
      `Expected agent ${agentId} to be in state "${expectedState}", but actual state is "${agent.state}"`,
      { agentId, expectedState, actualState: agent.state }
    );
  }
}

/**
 * Assert that a task has a specific status
 */
export function assertTaskStatus(
  context: AssertionContext,
  taskId: string,
  expectedStatus: "pending" | "assigned" | "in_progress" | "active" | "completed" | "failed"
): void {
  const task = context.taskManager.get(taskId);

  if (!task) {
    throw new HarnessAssertionError(
      `Task ${taskId} not found`,
      { taskId, expectedStatus }
    );
  }

  if (task.status !== expectedStatus) {
    throw new HarnessAssertionError(
      `Expected task ${taskId} to have status "${expectedStatus}", but actual status is "${task.status}"`,
      { taskId, expectedStatus, actualStatus: task.status }
    );
  }
}

/**
 * Assert that a git branch exists
 */
export function assertBranchExists(
  context: AssertionContext,
  branchName: string
): void {
  try {
    const branches = execSync("git branch --list", {
      cwd: context.repoPath,
      encoding: "utf8",
    })
      .split("\n")
      .map((b) => b.trim().replace(/^\* /, ""))
      .filter(Boolean);

    if (!branches.includes(branchName)) {
      throw new HarnessAssertionError(
        `Expected branch "${branchName}" to exist, but it was not found`,
        { branchName, existingBranches: branches }
      );
    }
  } catch (error) {
    if (error instanceof HarnessAssertionError) throw error;
    throw new HarnessAssertionError(
      `Failed to check for branch "${branchName}": ${error}`,
      { branchName, error: String(error) }
    );
  }
}

/**
 * Assert that a branch has been merged into target
 */
export function assertBranchMerged(
  context: AssertionContext,
  sourceBranch: string,
  targetBranch: string
): void {
  try {
    // Check if source branch commits are reachable from target
    const result = execSync(
      `git merge-base --is-ancestor ${sourceBranch} ${targetBranch} && echo "merged" || echo "not-merged"`,
      {
        cwd: context.repoPath,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).trim();

    if (result !== "merged") {
      throw new HarnessAssertionError(
        `Expected branch "${sourceBranch}" to be merged into "${targetBranch}", but it was not`,
        { sourceBranch, targetBranch }
      );
    }
  } catch (error) {
    if (error instanceof HarnessAssertionError) throw error;
    // git merge-base exits with 1 if not ancestor, which throws
    throw new HarnessAssertionError(
      `Branch "${sourceBranch}" is not merged into "${targetBranch}"`,
      { sourceBranch, targetBranch }
    );
  }
}

/**
 * Assert that an agent has received at least N messages
 */
export function assertMessagesReceived(
  context: AssertionContext,
  agentId: string,
  minCount: number
): void {
  const messages = context.messageRouter.getMessages(agentId);
  const actualCount = messages.length;

  if (actualCount < minCount) {
    throw new HarnessAssertionError(
      `Expected agent ${agentId} to have at least ${minCount} messages, but found ${actualCount}`,
      { agentId, minCount, actualCount, messages }
    );
  }
}

/**
 * Assert that an agent has received a specific message type
 */
export function assertMessageReceived(
  context: AssertionContext,
  agentId: string,
  contentPattern: string | RegExp
): void {
  const messages = context.messageRouter.getMessages(agentId);

  const found = messages.some((msg) => {
    if (typeof contentPattern === "string") {
      return msg.content.includes(contentPattern);
    }
    return contentPattern.test(msg.content);
  });

  if (!found) {
    throw new HarnessAssertionError(
      `Expected agent ${agentId} to have received a message matching ${contentPattern}, but none found`,
      {
        agentId,
        pattern: String(contentPattern),
        messages: messages.map((m) => m.content),
      }
    );
  }
}

/**
 * Assert that a file exists in the repo
 */
export function assertFileExists(
  context: AssertionContext,
  filePath: string
): void {
  try {
    execSync(`test -f "${filePath}"`, {
      cwd: context.repoPath,
      stdio: "pipe",
    });
  } catch {
    throw new HarnessAssertionError(
      `Expected file "${filePath}" to exist in repo, but it was not found`,
      { filePath, repoPath: context.repoPath }
    );
  }
}

/**
 * Assert that a file contains specific content
 */
export function assertFileContains(
  context: AssertionContext,
  filePath: string,
  content: string | RegExp
): void {
  try {
    const fileContent = execSync(`cat "${filePath}"`, {
      cwd: context.repoPath,
      encoding: "utf8",
    });

    const matches =
      typeof content === "string"
        ? fileContent.includes(content)
        : content.test(fileContent);

    if (!matches) {
      throw new HarnessAssertionError(
        `Expected file "${filePath}" to contain ${content}, but it did not`,
        { filePath, pattern: String(content), actualContent: fileContent }
      );
    }
  } catch (error) {
    if (error instanceof HarnessAssertionError) throw error;
    throw new HarnessAssertionError(
      `Failed to read file "${filePath}": ${error}`,
      { filePath, error: String(error) }
    );
  }
}

/**
 * Assert that there are no uncommitted changes
 */
export function assertCleanWorkingTree(context: AssertionContext): void {
  try {
    const status = execSync("git status --porcelain", {
      cwd: context.repoPath,
      encoding: "utf8",
    }).trim();

    if (status.length > 0) {
      throw new HarnessAssertionError(
        "Expected clean working tree, but found uncommitted changes",
        { uncommittedFiles: status.split("\n") }
      );
    }
  } catch (error) {
    if (error instanceof HarnessAssertionError) throw error;
    throw new HarnessAssertionError(
      `Failed to check working tree status: ${error}`,
      { error: String(error) }
    );
  }
}

/**
 * Assert the number of commits on a branch
 */
export function assertCommitCount(
  context: AssertionContext,
  branch: string,
  expectedCount: number
): void {
  try {
    const count = parseInt(
      execSync(`git rev-list --count ${branch}`, {
        cwd: context.repoPath,
        encoding: "utf8",
      }).trim(),
      10
    );

    if (count !== expectedCount) {
      throw new HarnessAssertionError(
        `Expected ${expectedCount} commits on branch "${branch}", but found ${count}`,
        { branch, expectedCount, actualCount: count }
      );
    }
  } catch (error) {
    if (error instanceof HarnessAssertionError) throw error;
    throw new HarnessAssertionError(
      `Failed to count commits on branch "${branch}": ${error}`,
      { branch, error: String(error) }
    );
  }
}

/**
 * Assert that a simulator has completed all steps
 */
export function assertSimulatorComplete(
  context: AssertionContext,
  agentId: string
): void {
  const simulator = context.simulators.get(agentId);

  if (!simulator) {
    throw new HarnessAssertionError(
      `Simulator ${agentId} not found`,
      { agentId }
    );
  }

  if (simulator.isRunning()) {
    throw new HarnessAssertionError(
      `Expected simulator ${agentId} to be complete, but it is still running`,
      { agentId, hasPendingSteps: simulator.hasPendingSteps() }
    );
  }
}

/**
 * Assert that a simulator's execution log contains a specific step type
 */
export function assertExecutedStep(
  context: AssertionContext,
  agentId: string,
  stepType: string
): void {
  const simulator = context.simulators.get(agentId);

  if (!simulator) {
    throw new HarnessAssertionError(
      `Simulator ${agentId} not found`,
      { agentId }
    );
  }

  const log = simulator.getExecutionLog();
  const found = log.some((entry) => entry.step.type === stepType);

  if (!found) {
    throw new HarnessAssertionError(
      `Expected simulator ${agentId} to have executed a "${stepType}" step, but it was not found`,
      {
        agentId,
        stepType,
        executedSteps: log.map((e) => e.step.type),
      }
    );
  }
}

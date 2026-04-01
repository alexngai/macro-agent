/**
 * MacroAgentBackend
 *
 * Implements cognitive-core's AgentBackend interface, delegating to
 * macro-agent's AgentManager for agent spawning and lifecycle.
 *
 * V2 port: Uses TasksAdapter instead of TaskBackend, InboxAdapter instead
 * of MAP adapter for session.complete notifications.
 */

import { nanoid } from "nanoid";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentId } from "../store/types/index.js";
import type { TasksAdapter } from "../adapters/types.js";
import type { InboxAdapter } from "../adapters/types.js";
import { AnalystRole } from "./analyst-role.js";
import { updateSessionFromEvent } from "./session-converter.js";
import { extractTrajectory } from "./trajectory-extractor.js";
import type {
  AtlasInstance,
  CognitiveAgentSession,
  CognitiveAgentSpawnConfig,
  CognitiveBatchConfig,
  CognitiveBatchHandle,
  CognitiveBatchResult,
  CognitiveBatchTaskResult,
  MacroAgentBackendConfig,
  MacroSessionState,
  SessionCompleteEvent,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Config defaults
// ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FOLLOW_UPS = 1;
const DEFAULT_SOFT_TIMEOUT_RATIO = 0.8;
const DEFAULT_MAX_CONCURRENCY = 4;

// ─────────────────────────────────────────────────────────────────
// MacroAgentBackend
// ─────────────────────────────────────────────────────────────────

export class MacroAgentBackend {
  readonly name = "macro-agent";
  readonly supportedTypes = ["claude-code"];

  private readonly agentManager: AgentManager;
  private readonly maxFollowUps: number;
  private readonly softTimeoutRatio: number;
  private readonly useTeam: boolean;
  private readonly coordinatorAgentId: AgentId | undefined;
  private readonly tasksAdapter: TasksAdapter | undefined;
  private readonly atlas: AtlasInstance | undefined;
  private readonly onSessionComplete: ((event: SessionCompleteEvent) => void) | undefined;
  private readonly inboxAdapter: InboxAdapter | undefined;
  private readonly sessions: Map<string, MacroSessionState> = new Map();

  constructor(agentManager: AgentManager, config?: MacroAgentBackendConfig) {
    this.agentManager = agentManager;
    this.maxFollowUps = config?.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS;
    this.softTimeoutRatio = config?.softTimeoutRatio ?? DEFAULT_SOFT_TIMEOUT_RATIO;
    this.useTeam = config?.useTeam ?? false;
    this.coordinatorAgentId = config?.coordinatorAgentId;
    this.tasksAdapter = config?.tasksAdapter;
    this.atlas = config?.atlas;
    this.onSessionComplete = config?.onSessionComplete;
    this.inboxAdapter = config?.inboxAdapter;

    // Register analyst role if not already present
    const registry = this.agentManager.getRoleRegistry();
    try {
      registry.resolveRole("analyst");
    } catch {
      registry.registerRole(AnalystRole);
    }
  }

  // ── AgentBackend interface ──────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async spawn(
    config: CognitiveAgentSpawnConfig,
  ): Promise<CognitiveAgentSession> {
    // Create task in TasksAdapter when configured
    let taskId: string | undefined;
    if (this.tasksAdapter) {
      taskId = await this.tasksAdapter.createTask({
        title: config.task.description,
        tags: config.task.domain ? [config.task.domain] : undefined,
      });
    }

    return this._spawnCore(config, taskId);
  }

  async getSession(
    sessionId: string,
  ): Promise<CognitiveAgentSession | undefined> {
    const state = this.sessions.get(sessionId);
    return state?.session;
  }

  async terminate(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    state.session.state = "failed";
    state.session.error = "Terminated by caller";
    state.session.endTime = new Date();

    // Fail the tracked task
    if (this.tasksAdapter && state.taskId) {
      await this.tasksAdapter
        .transitionTask(state.taskId, "fail")
        .catch(() => {});
    }

    await this.agentManager
      .terminate(state.agentId, "cancelled")
      .catch(() => {});
  }

  async listSessions(): Promise<CognitiveAgentSession[]> {
    return Array.from(this.sessions.values()).map((s) => s.session);
  }

  // ── Batch submission ────────────────────────────────────────────

  async submitBatch(config: CognitiveBatchConfig): Promise<CognitiveBatchHandle> {
    const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    const tasks = [...config.tasks];
    const results: CognitiveBatchTaskResult[] = tasks.map((t) => ({ config: t }));
    let cancelled = false;
    const runningSessions = new Set<string>();
    const completionPromises: Promise<void>[] = [];

    // Create all tasks upfront in TasksAdapter for immediate visibility
    const preCreatedTaskIds: (string | undefined)[] = [];
    if (this.tasksAdapter) {
      for (const task of tasks) {
        const taskId = await this.tasksAdapter.createTask({
          title: task.task.description,
          tags: task.task.domain ? [task.task.domain] : undefined,
        });
        preCreatedTaskIds.push(taskId);
      }
    } else {
      tasks.forEach(() => preCreatedTaskIds.push(undefined));
    }

    let nextIndex = 0;

    const spawnNext = async (): Promise<void> => {
      while (nextIndex < tasks.length && !cancelled && runningSessions.size < maxConcurrency) {
        const idx = nextIndex++;
        const spawnConfig = tasks[idx];
        const taskId = preCreatedTaskIds[idx];

        try {
          const session = await this._spawnCore(spawnConfig, taskId);
          runningSessions.add(session.id);
          results[idx].session = session;

          // Wait for this session to complete, then fill the slot
          const state = this.sessions.get(session.id)!;
          const completionPromise = state.runPromise
            .then(() => {
              runningSessions.delete(session.id);
              return spawnNext();
            })
            .catch(() => {
              runningSessions.delete(session.id);
              return spawnNext();
            });

          completionPromises.push(completionPromise);
        } catch (err) {
          results[idx].error = err instanceof Error ? err.message : String(err);
        }
      }
    };

    // Kick off initial batch
    await spawnNext();

    const buildResult = (): CognitiveBatchResult => {
      let completed = 0;
      let failed = 0;
      for (const r of results) {
        if (r.session?.state === "completed") completed++;
        else if (r.session?.state === "failed" || r.error) failed++;
      }
      return { results, completed, failed, cancelled };
    };

    return {
      totalTasks: tasks.length,
      waitForAll: async () => {
        await Promise.all(completionPromises);
        return buildResult();
      },
      cancel: async () => {
        cancelled = true;
        for (const sessionId of runningSessions) {
          await this.terminate(sessionId).catch(() => {});
        }
        await Promise.all(completionPromises).catch(() => {});
        return buildResult();
      },
    };
  }

  // ── Internal ────────────────────────────────────────────────────

  /**
   * Core spawn logic used by both spawn() and submitBatch().
   * Accepts an optional pre-created taskId to avoid double task creation.
   */
  private async _spawnCore(
    config: CognitiveAgentSpawnConfig,
    taskId?: string,
  ): Promise<CognitiveAgentSession> {
    // 1. Spawn macro-agent analyst
    const parentId = this.useTeam ? this.coordinatorAgentId ?? null : null;
    const spawned = await this.agentManager.spawn({
      task: config.task.description,
      task_id: taskId,
      role: "analyst",
      parent: parentId,
      cwd: config.cwd,
      config: config.env ? { env: config.env } : undefined,
      customPrompt: config.systemPromptAdditions,
    });

    // 2. Assign task to agent and start it (pending -> assigned -> in_progress)
    if (this.tasksAdapter && taskId) {
      await this.tasksAdapter.assignTask(taskId, spawned.id as string);
      await this.tasksAdapter.transitionTask(taskId, "start");
    }

    // 3. Create session
    const sessionId = `cognitive_${nanoid(12)}`;
    const session: CognitiveAgentSession = {
      id: sessionId,
      agentType: config.agentType,
      task: config.task,
      state: "running",
      messages: [],
      toolCalls: [],
      startTime: new Date(),
      metadata: {
        macroAgentId: spawned.id,
      },
    };

    // 4. Start the prompt loop (fire-and-forget)
    const runPromise = this.runSession(spawned.id, session, config, taskId);

    // 5. Track state
    this.sessions.set(sessionId, {
      agentId: spawned.id,
      session,
      config,
      runPromise,
      taskId,
    });

    return session;
  }

  private async runSession(
    agentId: AgentId,
    session: CognitiveAgentSession,
    config: CognitiveAgentSpawnConfig,
    taskId?: string,
  ): Promise<void> {
    const timeout = config.timeout;
    let softTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      // Set up timeout enforcement
      if (timeout && timeout > 0) {
        const softMs = timeout * this.softTimeoutRatio;

        softTimer = setTimeout(async () => {
          if (session.state !== "running") return;
          try {
            // Best-effort nudge to wrap up
            const canInject =
              await this.agentManager.supportsInjection(agentId);
            if (canInject) {
              // Prefer context injection (non-blocking)
              for await (const _ of this.agentManager.prompt(
                agentId,
                "TIME WARNING: Please finalize your analysis, write output, and call done() immediately.",
              )) {
                // Drain the iterator
              }
            }
          } catch {
            // Soft timeout is best-effort
          }
        }, softMs);

        hardTimer = setTimeout(() => {
          if (session.state !== "running") return;
          session.state = "failed";
          session.error = "Timeout exceeded";
          session.endTime = new Date();
          this.agentManager.terminate(agentId, "timeout").catch(() => {});
        }, timeout);
      }

      // Prompt until done() is called
      const result = await this.agentManager.promptUntilDone(
        agentId,
        config.task.description,
        {
          maxFollowUps: this.maxFollowUps,
          onUpdate: (update) => {
            updateSessionFromEvent(session, update);
            config.onMessage?.(
              session.messages[session.messages.length - 1]!,
            );
          },
        },
      );

      // Don't update state if already terminated externally or by timeout
      if (session.state === "running") {
        session.state = result.doneCalled ? "completed" : "failed";
        if (!result.doneCalled) {
          session.error = "Agent did not call done()";
        }
        session.endTime = new Date();
        session.result = result.doneStatus;
      }
    } catch (error) {
      if (session.state === "running") {
        session.state = "failed";
        session.error =
          error instanceof Error ? error.message : String(error);
        session.endTime = new Date();
      }
    } finally {
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);

      // Belt-and-suspenders: update TasksAdapter status
      if (this.tasksAdapter && taskId) {
        try {
          if (session.state === "completed") {
            await this.tasksAdapter.transitionTask(taskId, "complete");
          } else if (session.state === "failed") {
            await this.tasksAdapter.transitionTask(taskId, "fail");
          }
        } catch {
          // Ignore -- task may already be in terminal state from done()
        }
      }

      // Session completion: extract trajectory and feed to Atlas
      if (session.state === "completed" || session.state === "failed") {
        try {
          const trajectory = extractTrajectory(session);

          // Feed to Atlas for learning (if available)
          if (this.atlas) {
            await this.atlas.processTrajectory(trajectory).catch(() => {});
          }

          // Notify listener
          const completeEvent: SessionCompleteEvent = {
            sessionId: session.id,
            agentId: agentId as string,
            state: session.state,
            trajectory,
            duration_ms: session.endTime
              ? session.endTime.getTime() - session.startTime.getTime()
              : 0,
            message_count: session.messages.length,
            tool_call_count: session.toolCalls.length,
          };

          this.onSessionComplete?.(completeEvent);

          // Send session.complete notification via InboxAdapter
          if (this.inboxAdapter) {
            await this.inboxAdapter.send(
              agentId as string,
              this.coordinatorAgentId ?? agentId as string,
              {
                type: "session.complete",
                sessionId: session.id,
                agentId: agentId as string,
                state: session.state,
                duration_ms: completeEvent.duration_ms,
                message_count: completeEvent.message_count,
                tool_call_count: completeEvent.tool_call_count,
                outcome: session.state === "completed" ? "success" : "failure",
              },
              { subject: "session.complete" },
            ).catch(() => {});
          }
        } catch {
          // Session completion hooks are best-effort
        }
      }

      // Clean up the agent process
      if (session.state !== "running") {
        const stopReason =
          session.state === "completed" ? "completed" : "failed";
        await this.agentManager
          .terminate(agentId, stopReason)
          .catch(() => {});
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Factory function
// ─────────────────────────────────────────────────────────────────

export function createMacroAgentBackend(
  agentManager: AgentManager,
  config?: MacroAgentBackendConfig,
): MacroAgentBackend {
  return new MacroAgentBackend(agentManager, config);
}

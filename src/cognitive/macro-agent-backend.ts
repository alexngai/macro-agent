/**
 * MacroAgentBackend
 *
 * Implements cognitive-core's AgentBackend interface, delegating to
 * macro-agent's AgentManager for agent spawning and lifecycle.
 *
 * Stripped to essentials for OpenHive integration:
 * - Spawns analyst agents in a workspace directory (cwd)
 * - Tracks sessions and manages timeouts
 * - Reports completion via callbacks and InboxAdapter
 *
 * Atlas, trajectory extraction, and team coordination are handled
 * by OpenHive, not the swarm. The swarm is pure compute — receive
 * task, execute agent, return result.
 */

import { nanoid } from "nanoid";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentId } from "../store/types/index.js";
import { AnalystRole } from "./analyst-role.js";
import { updateSessionFromEvent } from "./session-converter.js";
import type {
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

const DEFAULT_MAX_FOLLOW_UPS = 1;
const DEFAULT_SOFT_TIMEOUT_RATIO = 0.8;
const DEFAULT_MAX_CONCURRENCY = 4;

export class MacroAgentBackend {
  readonly name = "macro-agent";
  readonly supportedTypes = ["claude-code"];

  private readonly agentManager: AgentManager;
  private readonly config: MacroAgentBackendConfig | undefined;
  private readonly maxFollowUps: number;
  private readonly softTimeoutRatio: number;
  private readonly tasksAdapter: import("../adapters/types.js").TasksAdapter | undefined;
  private readonly onSessionComplete: ((event: SessionCompleteEvent) => void) | undefined;
  private readonly inboxAdapter: import("../adapters/types.js").InboxAdapter | undefined;
  private readonly sessions: Map<string, MacroSessionState> = new Map();

  constructor(agentManager: AgentManager, config?: MacroAgentBackendConfig) {
    this.agentManager = agentManager;
    this.config = config;
    this.maxFollowUps = config?.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS;
    this.softTimeoutRatio = config?.softTimeoutRatio ?? DEFAULT_SOFT_TIMEOUT_RATIO;
    this.tasksAdapter = config?.tasksAdapter;
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

  async spawn(config: CognitiveAgentSpawnConfig): Promise<CognitiveAgentSession> {
    let taskId: string | undefined;
    if (this.tasksAdapter) {
      taskId = await this.tasksAdapter.createTask({
        title: config.task.description,
        tags: config.task.domain ? [config.task.domain] : undefined,
      });
    }
    return this._spawnCore(config, taskId);
  }

  async getSession(sessionId: string): Promise<CognitiveAgentSession | undefined> {
    return this.sessions.get(sessionId)?.session;
  }

  async terminate(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // Don't corrupt completed sessions
    if (state.session.state !== "running") return;

    state.session.state = "failed";
    state.session.error = "Terminated by caller";
    state.session.endTime = new Date();

    if (this.tasksAdapter && state.taskId) {
      await this.tasksAdapter.transitionTask(state.taskId, "fail").catch(() => {});
    }

    await this.agentManager.terminate(state.agentId, "cancelled").catch(() => {});
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

          const state = this.sessions.get(session.id)!;
          const completionPromise = state.runPromise
            .then(() => { runningSessions.delete(session.id); return spawnNext(); })
            .catch(() => { runningSessions.delete(session.id); return spawnNext(); });

          completionPromises.push(completionPromise);
        } catch (err) {
          results[idx].error = err instanceof Error ? err.message : String(err);
        }
      }
    };

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
      waitForAll: async () => { await Promise.all(completionPromises); return buildResult(); },
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

  private async _spawnCore(
    config: CognitiveAgentSpawnConfig,
    taskId?: string,
  ): Promise<CognitiveAgentSession> {
    const spawned = await this.agentManager.spawn({
      task: config.task.description,
      task_id: taskId,
      role: "analyst",
      parent: this.config?.useTeam && this.config.coordinatorAgentId
        ? this.config.coordinatorAgentId
        : null,
      cwd: config.cwd,
      config: config.env ? { env: config.env } : undefined,
      customPrompt: config.systemPromptAdditions,
    });

    if (this.tasksAdapter && taskId) {
      await this.tasksAdapter.assignTask(taskId, spawned.id as string);
      await this.tasksAdapter.transitionTask(taskId, "start");
    }

    const sessionId = `cognitive_${nanoid(12)}`;
    const session: CognitiveAgentSession = {
      id: sessionId,
      agentType: config.agentType,
      task: config.task,
      state: "running",
      messages: [],
      toolCalls: [],
      startTime: new Date(),
      metadata: { macroAgentId: spawned.id },
    };

    const runPromise = this.runSession(spawned.id, session, config, taskId);

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
      if (timeout && timeout > 0) {
        const softMs = timeout * this.softTimeoutRatio;

        softTimer = setTimeout(async () => {
          if (session.state !== "running") return;
          try {
            const canInject = await this.agentManager.supportsInjection(agentId);
            if (canInject) {
              for await (const _ of this.agentManager.prompt(
                agentId,
                "TIME WARNING: Please finalize your analysis, write output, and call done() immediately.",
              )) { /* drain */ }
            }
          } catch { /* best-effort */ }
        }, softMs);

        hardTimer = setTimeout(() => {
          if (session.state !== "running") return;
          session.state = "failed";
          session.error = "Timeout exceeded";
          session.endTime = new Date();
          this.agentManager.terminate(agentId, "timeout").catch(() => {});
        }, timeout);
      }

      const result = await this.agentManager.promptUntilDone(
        agentId,
        config.task.description,
        {
          maxFollowUps: this.maxFollowUps,
          onUpdate: (update) => {
            updateSessionFromEvent(session, update);
            config.onMessage?.(session.messages[session.messages.length - 1]!);
          },
        },
      );

      if (session.state === "running") {
        session.state = result.doneCalled ? "completed" : "failed";
        if (!result.doneCalled) session.error = "Agent did not call done()";
        session.endTime = new Date();
        session.result = result.doneStatus;
      }
    } catch (error) {
      if (session.state === "running") {
        session.state = "failed";
        session.error = error instanceof Error ? error.message : String(error);
        session.endTime = new Date();
      }
    } finally {
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);

      // Update task status
      if (this.tasksAdapter && taskId) {
        try {
          if (session.state === "completed") {
            await this.tasksAdapter.transitionTask(taskId, "complete");
          } else if (session.state === "failed") {
            await this.tasksAdapter.transitionTask(taskId, "fail");
          }
        } catch { /* may already be terminal */ }
      }

      // Notify completion (no trajectory extraction — OpenHive handles that via sessionlog)
      if (session.state === "completed" || session.state === "failed") {
        const completeEvent: SessionCompleteEvent = {
          sessionId: session.id,
          agentId: agentId as string,
          state: session.state,
          duration_ms: session.endTime
            ? session.endTime.getTime() - session.startTime.getTime()
            : 0,
          message_count: session.messages.length,
          tool_call_count: session.toolCalls.length,
        };

        this.onSessionComplete?.(completeEvent);

        if (this.inboxAdapter) {
          await this.inboxAdapter.send(
            agentId as string,
            agentId as string,
            {
              type: "session.complete",
              sessionId: session.id,
              state: session.state,
              duration_ms: completeEvent.duration_ms,
              outcome: session.state === "completed" ? "success" : "failure",
            },
            { subject: "session.complete" },
          ).catch(() => {});
        }
      }

      // Clean up agent process
      if (session.state !== "running") {
        const stopReason = session.state === "completed" ? "completed" : "failed";
        await this.agentManager.terminate(agentId, stopReason).catch(() => {});
      }
    }
  }
}

export function createMacroAgentBackend(
  agentManager: AgentManager,
  config?: MacroAgentBackendConfig,
): MacroAgentBackend {
  return new MacroAgentBackend(agentManager, config);
}

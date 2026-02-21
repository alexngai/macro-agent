/**
 * MacroAgentBackend
 *
 * Implements cognitive-core's AgentBackend interface, delegating to
 * macro-agent's AgentManager for agent spawning and lifecycle.
 *
 * Phase 1: Spawns standalone analyst workers.
 * Phase 2: Set useTeam=true to spawn analysts under a team coordinator.
 */

import { nanoid } from "nanoid";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentId } from "../store/types/index.js";
import { AnalystRole } from "./analyst-role.js";
import { updateSessionFromEvent } from "./session-converter.js";
import type {
  CognitiveAgentSession,
  CognitiveAgentSpawnConfig,
  MacroAgentBackendConfig,
  MacroSessionState,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Config defaults
// ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FOLLOW_UPS = 1;
const DEFAULT_SOFT_TIMEOUT_RATIO = 0.8;

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
  private readonly sessions: Map<string, MacroSessionState> = new Map();

  constructor(agentManager: AgentManager, config?: MacroAgentBackendConfig) {
    this.agentManager = agentManager;
    this.maxFollowUps = config?.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS;
    this.softTimeoutRatio = config?.softTimeoutRatio ?? DEFAULT_SOFT_TIMEOUT_RATIO;
    this.useTeam = config?.useTeam ?? false;
    this.coordinatorAgentId = config?.coordinatorAgentId;

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
    // 1. Spawn macro-agent analyst
    const parentId = this.useTeam ? this.coordinatorAgentId ?? null : null;
    const spawned = await this.agentManager.spawn({
      task: config.task.description,
      role: "analyst",
      parent: parentId,
      cwd: config.cwd,
      config: config.env ? { env: config.env } : undefined,
      customPrompt: config.systemPromptAdditions,
    });

    // 2. Create session
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

    // 3. Start the prompt loop (fire-and-forget)
    const runPromise = this.runSession(spawned.id, session, config);

    // 4. Track state
    this.sessions.set(sessionId, {
      agentId: spawned.id,
      session,
      config,
      runPromise,
    });

    return session;
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

    await this.agentManager
      .terminate(state.agentId, "cancelled")
      .catch(() => {});
  }

  async listSessions(): Promise<CognitiveAgentSession[]> {
    return Array.from(this.sessions.values()).map((s) => s.session);
  }

  // ── Internal ────────────────────────────────────────────────────

  private async runSession(
    agentId: AgentId,
    session: CognitiveAgentSession,
    config: CognitiveAgentSpawnConfig,
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

/**
 * Trigger Wake Manager
 *
 * Manages waking agents with pending system events. Provides
 * both on-demand and periodic heartbeat-based waking.
 *
 * This is decoupled from AgentManager.prompt() - the trigger
 * system controls when to drain queues and deliver events.
 *
 * @module trigger/wake/wake-manager
 */

import type { AgentId } from "../../store/types/index.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { SystemEventQueue } from "../queue/types.js";
import { formatQueuedTextsAsBlock } from "../queue/system-event-queue.js";
import type {
  TriggerWakeManager,
  WakeManagerConfig,
  WakeRequest,
  WakeCycleStatus,
  WakeCycleResult,
  AgentDrainResult,
} from "./types.js";

// =============================================================================
// Configuration Defaults
// =============================================================================

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5_000;

// =============================================================================
// Wake Manager Implementation
// =============================================================================

/**
 * Dependencies for the wake manager
 */
export interface WakeManagerDeps {
  agentManager: AgentManager;
  systemEventQueue: SystemEventQueue;
}

/**
 * Create a trigger wake manager
 */
export function createWakeManager(
  deps: WakeManagerDeps,
  config: WakeManagerConfig = {}
): TriggerWakeManager {
  const {
    enableHeartbeat = false,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    defaultCoalesceMs = DEFAULT_COALESCE_MS,
    maxRetryDelayMs = MAX_RETRY_DELAY_MS,
    enableLogging = false,
  } = config;

  // State
  let running = false;
  let pendingReason: string | null = null;
  let scheduled = false;
  let wakingInProgress = false;
  let coalesceTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  /**
   * Log if enabled
   */
  function log(message: string, ...args: unknown[]): void {
    if (enableLogging) {
      console.log(`[wake-manager] ${message}`, ...args);
    }
  }

  /**
   * Deliver events to a single agent
   */
  async function deliverToAgent(agentId: AgentId): Promise<AgentDrainResult> {
    const events = deps.systemEventQueue.drainText(agentId, {
      sortByPriority: true,
    });

    if (events.length === 0) {
      return {
        agentId,
        eventCount: 0,
        deliveryMethod: "queued",
        success: true,
      };
    }

    const content = formatQueuedTextsAsBlock(events);
    log(`Delivering ${events.length} events to agent ${agentId}`);

    // Try inject first
    const session = deps.agentManager.getSession(agentId);

    if (session) {
      // Try inject
      if (session.supportsInject()) {
        try {
          const result = await session.inject(content);
          if (result.success) {
            return {
              agentId,
              eventCount: events.length,
              deliveryMethod: "inject",
              success: true,
            };
          }
        } catch (error) {
          log(`Inject failed for ${agentId}:`, error);
        }
      }

      // Try interrupt
      try {
        const iterable = session.interruptWith(content);
        const iterator = iterable[Symbol.asyncIterator]();
        await iterator.next();

        // Drive rest in background
        (async () => {
          try {
            for await (const _ of iterable) {
              // Just drive to completion
            }
          } catch {
            // Ignore background errors
          }
        })();

        return {
          agentId,
          eventCount: events.length,
          deliveryMethod: "interrupt",
          success: true,
        };
      } catch (error) {
        log(`Interrupt failed for ${agentId}:`, error);
      }
    }

    // Try prompting the agent
    const agent = deps.agentManager.get(agentId);
    if (agent && agent.state !== "stopped") {
      try {
        const promptIterable = deps.agentManager.prompt(agentId, content);

        // Drive in background
        (async () => {
          try {
            for await (const _ of promptIterable) {
              // Just drive
            }
          } catch {
            // Ignore errors
          }
        })();

        return {
          agentId,
          eventCount: events.length,
          deliveryMethod: "prompt",
          success: true,
        };
      } catch (error) {
        log(`Prompt failed for ${agentId}:`, error);
      }
    }

    // Re-queue the events since we couldn't deliver
    for (const text of events) {
      deps.systemEventQueue.enqueue(text, { agentId });
    }

    return {
      agentId,
      eventCount: events.length,
      deliveryMethod: "queued",
      success: false,
      error: "Could not deliver events - re-queued",
    };
  }

  /**
   * Run a wake cycle - process all agents with pending events
   */
  async function runCycle(reason?: string): Promise<WakeCycleResult> {
    const startTime = Date.now();
    const agentsWithEvents = deps.systemEventQueue.getAgentsWithEvents();

    log(`Wake cycle starting: ${agentsWithEvents.length} agents with events, reason: ${reason ?? "none"}`);

    const results: AgentDrainResult[] = [];

    for (const agentId of agentsWithEvents) {
      try {
        const result = await deliverToAgent(agentId);
        results.push(result);
      } catch (error) {
        results.push({
          agentId,
          eventCount: deps.systemEventQueue.getEventCount(agentId),
          deliveryMethod: "queued",
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const durationMs = Date.now() - startTime;
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    log(`Wake cycle complete: ${successful.length} successful, ${failed.length} failed, ${durationMs}ms`);

    return {
      agentsProcessed: agentsWithEvents,
      successfulDeliveries: successful,
      failedDeliveries: failed,
      durationMs,
    };
  }

  /**
   * Schedule a wake cycle with coalescing
   */
  function scheduleWake(coalesceMs: number): void {
    if (coalesceTimer) return;

    coalesceTimer = setTimeout(async () => {
      coalesceTimer = null;
      scheduled = false;

      if (!running) return;
      if (wakingInProgress) {
        // Retry after delay
        scheduled = true;
        scheduleWake(DEFAULT_RETRY_DELAY_MS);
        return;
      }

      const reason = pendingReason;
      pendingReason = null;
      wakingInProgress = true;

      try {
        const result = await runCycle(reason ?? undefined);

        // If there were failures, schedule retry
        if (result.failedDeliveries.length > 0) {
          pendingReason = "retry";
          scheduleWake(Math.min(DEFAULT_RETRY_DELAY_MS * 2, maxRetryDelayMs));
        }
      } catch (error) {
        log("Wake cycle error:", error);
        pendingReason = "retry";
        scheduleWake(maxRetryDelayMs);
      } finally {
        wakingInProgress = false;

        // Check if more wakes were requested during this cycle
        if (pendingReason || scheduled) {
          scheduleWake(coalesceMs);
        }
      }
    }, coalesceMs);

    // Allow Node to exit if this is the only thing keeping it alive
    coalesceTimer.unref?.();
  }

  /**
   * Start heartbeat timer
   */
  function startHeartbeat(): void {
    if (!enableHeartbeat || heartbeatTimer) return;

    heartbeatTimer = setInterval(() => {
      if (!running) return;

      // Check if any agents have pending events
      const agentsWithEvents = deps.systemEventQueue.getAgentsWithEvents();
      if (agentsWithEvents.length > 0) {
        log(`Heartbeat: ${agentsWithEvents.length} agents with pending events`);
        pendingReason = pendingReason ?? "heartbeat";
        scheduleWake(defaultCoalesceMs);
      }
    }, heartbeatIntervalMs);

    heartbeatTimer.unref?.();
  }

  /**
   * Stop heartbeat timer
   */
  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // =============================================================================
  // Public Interface
  // =============================================================================

  return {
    requestWakeNow(request?: WakeRequest): void {
      if (!running) {
        log("Wake requested but manager not running");
        return;
      }

      pendingReason = request?.reason ?? pendingReason ?? "requested";
      scheduleWake(request?.coalesceMs ?? defaultCoalesceMs);
    },

    hasPendingWake(): boolean {
      return pendingReason !== null || Boolean(coalesceTimer) || scheduled;
    },

    async runWakeCycle(opts?: { reason?: string }): Promise<WakeCycleStatus> {
      if (wakingInProgress) {
        return { status: "skipped", reason: "wake-in-progress" };
      }

      wakingInProgress = true;
      const startTime = Date.now();

      try {
        const result = await runCycle(opts?.reason);

        return {
          status: result.failedDeliveries.length > 0 ? "failed" : "ran",
          durationMs: result.durationMs,
          wokenAgents: result.successfulDeliveries.map((r) => r.agentId),
          reason:
            result.failedDeliveries.length > 0
              ? `${result.failedDeliveries.length} deliveries failed`
              : undefined,
        };
      } catch (error) {
        return {
          status: "failed",
          durationMs: Date.now() - startTime,
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        wakingInProgress = false;
      }
    },

    start(): void {
      if (running) return;
      running = true;
      log("Wake manager started");
      startHeartbeat();
    },

    stop(): void {
      if (!running) return;
      running = false;

      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }

      stopHeartbeat();
      pendingReason = null;
      scheduled = false;

      log("Wake manager stopped");
    },

    isRunning(): boolean {
      return running;
    },

    getPendingReason(): string | null {
      return pendingReason;
    },
  };
}

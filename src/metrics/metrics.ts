/**
 * Metrics collection for macro-agent.
 *
 * Single entry point: `collectMetrics()` gathers agent, task, and
 * system metrics into a point-in-time snapshot.
 *
 * @module metrics/metrics
 */

import type { MacroAgentSystemV2 } from "../boot-v2.js";
import type {
  AgentMetrics,
  TaskMetrics,
  SystemMetrics,
  MetricsSnapshot,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

/** Threshold for considering an agent unhealthy (ms). */
const UNHEALTHY_THRESHOLD_MS = 60_000;

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

/**
 * Collect a point-in-time metrics snapshot from the running system.
 *
 * @param system - The booted MacroAgentSystemV2 instance.
 * @param startTime - `Date.now()` value captured at boot, used for uptime.
 */
export async function collectMetrics(
  system: MacroAgentSystemV2,
  startTime: number
): Promise<MetricsSnapshot> {
  const [agents, tasks, systemMetrics] = await Promise.all([
    collectAgentMetrics(system),
    collectTaskMetrics(system),
    collectSystemMetrics(system, startTime),
  ]);

  return {
    timestamp: new Date().toISOString(),
    agents,
    tasks,
    system: systemMetrics,
  };
}

// ─────────────────────────────────────────────────────────────────
// Agent Metrics
// ─────────────────────────────────────────────────────────────────

async function collectAgentMetrics(
  system: MacroAgentSystemV2
): Promise<AgentMetrics> {
  const agents = system.agentStore.listAgents();

  const byState: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  const byTeam: Record<string, number> = {};

  for (const agent of agents) {
    // Count by state
    byState[agent.state] = (byState[agent.state] ?? 0) + 1;

    // Count by role
    byRole[agent.role] = (byRole[agent.role] ?? 0) + 1;

    // Count by team (skip agents without a team)
    if (agent.team) {
      byTeam[agent.team] = (byTeam[agent.team] ?? 0) + 1;
    }
  }

  const unhealthy =
    system.controlServer.getUnhealthyAgents(UNHEALTHY_THRESHOLD_MS).length;

  return {
    total: agents.length,
    byState,
    byRole,
    byTeam,
    unhealthy,
  };
}

// ─────────────────────────────────────────────────────────────────
// Task Metrics
// ─────────────────────────────────────────────────────────────────

async function collectTaskMetrics(
  system: MacroAgentSystemV2
): Promise<TaskMetrics | null> {
  // If the tasks adapter is not connected, return null
  if (!system.tasksAdapter.connected) {
    return null;
  }

  try {
    const [allTasks, readyTasks] = await Promise.all([
      system.tasksAdapter.listTasks(),
      system.tasksAdapter.queryReady(),
    ]);

    const byStatus: Record<string, number> = {};
    let blocked = 0;

    for (const task of allTasks) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
      if (task.status === "blocked") {
        blocked++;
      }
    }

    return {
      byStatus,
      ready: readyTasks.length,
      blocked,
    };
  } catch {
    // opentasks daemon may have disconnected — non-fatal
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// System Metrics
// ─────────────────────────────────────────────────────────────────

async function collectSystemMetrics(
  system: MacroAgentSystemV2,
  startTime: number
): Promise<SystemMetrics> {
  const uptime = Date.now() - startTime;
  const triggerQueueDepth =
    system.triggerSystem.queue.getAgentsWithEvents().length;

  // CronService.list() returns all enabled jobs
  const cronJobs = await system.triggerSystem.cronService.list();
  const cronJobCount = cronJobs.length;

  return {
    uptime,
    triggerQueueDepth,
    cronJobCount,
  };
}

/**
 * `dispatch/spawn-agent` MAP request handler — runtime-agnostic wire shape,
 * macro-agent-specific implementation.
 *
 * Called by OpenHive's orchestrator when ACP-routing a dispatch with
 * `lifecycle: 'fresh'` — the hub asks the swarm to spawn a fresh agent
 * with the materialized loadout's structured fields applied to its spawn
 * config. The handler returns the spawned agent's id; the orchestrator
 * then attaches an ACP stream via the existing `findAcpAgentInfo` path.
 *
 * Symmetric with the mail path: both routes use `loadoutToSpawnOptions`
 * to translate the wire-level loadout into macro-agent's spawn options.
 *
 * Wire shape (per docs/LOADOUTS_DESIGN.md → "ACP wire"):
 *
 *   request:
 *     {
 *       role: string,                       // e.g. "coordinator"
 *       cwd: string,                         // worker working directory
 *       capabilities_required?: string[],   // e.g. ["acp"] (advisory)
 *       lifecycle?: "fresh" | "reuse",      // currently always "fresh" here
 *       loadout?: WireLoadout,              // MaterializedLoadout subset
 *       fullAutonomous?: boolean            // ask-rule resolution; default true
 *     }
 *
 *   response:
 *     { agentId: string }
 */

import type { AgentManager } from "../agent/agent-manager.js";
import { loadoutToSpawnOptions, type WireLoadout } from "./loadout-translation.js";

export interface SpawnAgentRequest {
  role: string;
  cwd: string;
  capabilities_required?: string[];
  lifecycle?: "fresh" | "reuse";
  loadout?: WireLoadout;
  fullAutonomous?: boolean;
  /** Optional initial task description; defaults to a placeholder so the
   *  agent's session has *something* to render until the orchestrator's
   *  ACP `session/prompt` arrives. */
  task?: string;
}

export interface SpawnAgentResponse {
  agentId: string;
}

export interface SpawnAgentHandlerDeps {
  agentManager: AgentManager;
  /**
   * Optional barrier called after spawn so the spawned agent's
   * lifecycle-bridge has had time to register its `protocols: ['acp']`
   * capability with the hub before this handler returns. Without this
   * the orchestrator's subsequent `findAcpAgentInfo` would race the
   * registration and return null.
   *
   * Returns true once the agent is registered and ACP-capable; false on
   * timeout. Implementations typically wait on a Promise resolved by
   * the lifecycle-bridge's `agent.registered` callback.
   */
  waitForAcpRegistration?: (
    agentId: string,
    timeoutMs?: number,
  ) => Promise<boolean>;
  /** Optional logger; defaults to console.log. */
  log?: (msg: string) => void;
}

const DEFAULT_REGISTRATION_TIMEOUT_MS = 5_000;

export async function handleDispatchSpawnAgent(
  params: SpawnAgentRequest,
  deps: SpawnAgentHandlerDeps,
): Promise<SpawnAgentResponse> {
  const { agentManager, waitForAcpRegistration, log = console.log } = deps;

  if (!params.role) {
    throw new Error("dispatch/spawn-agent: missing 'role'");
  }
  if (params.lifecycle && params.lifecycle !== "fresh") {
    throw new Error(
      `dispatch/spawn-agent: lifecycle='${params.lifecycle}' not supported by this handler — ` +
        `'reuse' is handled hub-side via findAcpAgentInfo, not via this method`,
    );
  }
  // cwd is optional — agentManager.spawn defaults to its own defaultCwd
  // (typically process.cwd() of the macro-agent process) when omitted.

  const fullAutonomous = params.fullAutonomous ?? true;
  const spawnLoadoutOpts = loadoutToSpawnOptions(params.loadout, {
    fullAutonomous,
  });

  log(
    `[dispatch/spawn-agent] Spawning fresh ${params.role} cwd=${params.cwd} ` +
      `permissions=${
        spawnLoadoutOpts.permissions ? JSON.stringify(spawnLoadoutOpts.permissions) : "(none)"
      } fullAutonomous=${fullAutonomous}`,
  );

  const spawned = await agentManager.spawn({
    role: params.role,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    parent: null,
    // Mail-inbound and dispatch-spawned coordinators alike run under
    // isolated settings so host-level Claude plugins don't auto-mount.
    isolatedSettings: true,
    task:
      params.task ?? "Awaiting dispatch (created by dispatch/spawn-agent)",
    ...spawnLoadoutOpts,
  });

  // Block until the lifecycle-bridge has registered ACP capabilities,
  // otherwise the orchestrator's subsequent `findAcpAgentInfo` lookup
  // races the registration and fails. Best-effort: a timeout returns
  // anyway and the orchestrator will retry on its own poll.
  if (waitForAcpRegistration) {
    const ok = await waitForAcpRegistration(
      spawned.id,
      DEFAULT_REGISTRATION_TIMEOUT_MS,
    ).catch(() => false);
    if (!ok) {
      log(
        `[dispatch/spawn-agent] Warning: ACP registration not confirmed for ` +
          `agent ${spawned.id} within ${DEFAULT_REGISTRATION_TIMEOUT_MS}ms; ` +
          `orchestrator may need to retry.`,
      );
    }
  }

  log(`[dispatch/spawn-agent] Spawn complete agentId=${spawned.id}`);
  return { agentId: spawned.id };
}

/**
 * Loadout → SpawnAgentOptions translator (macro-agent)
 *
 * Single named function that converts the runtime-agnostic
 * `MaterializedLoadout` wire payload into macro-agent-specific
 * `SpawnAgentOptions`. Two callers:
 *
 *   - `mail-inbound-consumer` — for mail-routed dispatches (ACP+fresh
 *     workers spawned per envelope)
 *   - `dispatch/spawn-agent` MAP handler — for ACP-routed dispatches when
 *     `lifecycle: 'fresh'`
 *
 * Both call sites pass the same shape; this function is the only place
 * macro-agent-specific spawn vocabulary (`permissions`, `fullAutonomous`,
 * `capabilities`) is derived from loadout fields. A future ACP runtime
 * (codex, etc.) would implement its own translator with the same input
 * shape and a different output shape.
 *
 * The wire shape (`MaterializedLoadout` subset) is documented in
 * openhive-2 `docs/LOADOUTS_DESIGN.md` → "Channel 2 — `loadout` as a
 * first-class wire concept".
 */

import type { SpawnAgentOptions } from "../agent/types.js";

/**
 * Wire shape — a strict subset of openhive's `MaterializedLoadout` that
 * is meaningful to a runtime's spawn config. Skill content (`rendered`,
 * `items`) and `promptAddendum` ride in the prompt body for both routes,
 * so they aren't included here.
 *
 * Defined locally rather than imported from openhive to avoid a runtime
 * dependency on the hub's source tree. Structural compatibility with
 * `MaterializedLoadout` is what matters at the wire boundary.
 */
export interface WireLoadout {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  mcpProviders?: Array<{
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
  mcpScope?: Array<{ server: string; tools?: string[]; exclude?: string[] }>;
  capabilities?: string[];
}

export interface TranslationContext {
  /**
   * Mail-inbound and other autonomous consumers set this true so `ask`
   * rules collapse to `allow` (proceed without human round-trip).
   * Non-autonomous spawns leave it false, collapsing `ask` → `deny`.
   */
  fullAutonomous?: boolean;
}

/**
 * Translate a wire-shaped loadout into the subset of `SpawnAgentOptions`
 * that macro-agent's `agentManager.spawn` consumes from loadout content.
 *
 * Returns a partial — the caller merges with required spawn fields
 * (`task`, `task_id`, `role`, `parent`, `cwd`, `isolatedSettings`, etc.).
 *
 * Mappings:
 *   loadout.permissions → SpawnAgentOptions.permissions (carried verbatim;
 *     `ask` collapse is performed inside agentManager.spawn based on
 *     fullAutonomous)
 *   loadout.capabilities → SpawnAgentOptions.capabilities (forwarded)
 *   loadout.mcpProviders → reserved (Phase 2 — not yet wired)
 *   loadout.mcpScope → reserved (Phase 1 — not yet wired)
 */
export function loadoutToSpawnOptions(
  loadout: WireLoadout | undefined,
  ctx: TranslationContext = {},
): Partial<SpawnAgentOptions> {
  if (!loadout) return {};

  const opts: Partial<SpawnAgentOptions> = {};

  if (loadout.permissions && hasAnyRule(loadout.permissions)) {
    opts.permissions = {
      allow: loadout.permissions.allow ?? [],
      deny: loadout.permissions.deny ?? [],
      ask: loadout.permissions.ask ?? [],
    };
    opts.fullAutonomous = ctx.fullAutonomous ?? false;
  }

  if (loadout.capabilities?.length) {
    opts.capabilities = [...loadout.capabilities];
  }

  return opts;
}

function hasAnyRule(p: WireLoadout["permissions"]): boolean {
  if (!p) return false;
  return (
    (p.allow?.length ?? 0) +
      (p.deny?.length ?? 0) +
      (p.ask?.length ?? 0) >
    0
  );
}

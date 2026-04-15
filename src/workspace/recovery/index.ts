/**
 * Conflict recovery strategies.
 *
 * Register via `WorkspaceManager.registerConflictRecoveryStrategy` (Phase 7b).
 * Selected via per-role YAML `on_conflict_recovery` or team default.
 *
 * Built-ins:
 * - `defer`        — no-op; leave conflict record for external resolution
 * - `abandon`      — abandon the conflicted stream
 * - `escalate`     — pause stream; notify human
 * - `auto-resolve` — git strategies (ours/theirs/union) — scaffold only
 * - `spawn-resolver` — LLM resolver agent (Phase 7b; requires AgentManager)
 *
 * @module workspace/recovery
 * @see docs/conflict-recovery.md
 */

export type {
  ConflictContext,
  ConflictRecoveryStrategy,
  ConflictResolution,
  ConflictResolutionMode,
} from './types.js';

export { DeferStrategy } from './defer.js';
export { AbandonStrategy } from './abandon.js';
export { EscalateStrategy } from './escalate.js';
export { AutoResolveStrategy } from './auto-resolve.js';

import { DeferStrategy } from './defer.js';
import { AbandonStrategy } from './abandon.js';
import { EscalateStrategy } from './escalate.js';
import { AutoResolveStrategy } from './auto-resolve.js';
import type { ConflictRecoveryStrategy } from './types.js';

/**
 * Build a registry of built-in conflict recovery strategies.
 *
 * Returns a Map keyed by strategy name. Callers plug this into their dispatch
 * layer (Phase 7b). `spawn-resolver` is not included — it requires
 * AgentManager injection and is added by the consumer.
 */
export function buildBuiltinRecoveryRegistry(): Map<string, ConflictRecoveryStrategy> {
  const map = new Map<string, ConflictRecoveryStrategy>();
  const strategies: ConflictRecoveryStrategy[] = [
    new DeferStrategy(),
    new AbandonStrategy(),
    new EscalateStrategy(),
    new AutoResolveStrategy(),
  ];
  for (const s of strategies) map.set(s.name, s);
  return map;
}

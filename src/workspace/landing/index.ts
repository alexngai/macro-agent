/**
 * Landing strategies — pluggable algorithms for finalizing stream work.
 *
 * Register via `WorkspaceManager.registerLandingStrategy`. Team YAML selects
 * the strategy via `roles.<role>.landing`. At `done()` time, AgentManagerV2
 * invokes `WorkspaceManager.land()` which dispatches to the registered
 * strategy by name.
 *
 * Built-in strategies:
 * - `merge-to-parent` — mergeStream into parent; optional cascade
 * - `queue-to-branch` — git-cascade's built-in merge queue
 * - `direct-push`     — rebase + push (trunk behavior)
 * - `optimistic-push` — direct-push + validation event
 *
 * @module workspace/landing
 * @see docs/workspace-interfaces.md §6
 */

import type { WorkspaceManager } from '../types.js';
import { MergeToParentStrategy } from './merge-to-parent.js';
import { QueueToBranchStrategy } from './queue-to-branch.js';
import { DirectPushStrategy } from './direct-push.js';
import { OptimisticPushStrategy } from './optimistic-push.js';

export { MergeToParentStrategy } from './merge-to-parent.js';
export { QueueToBranchStrategy } from './queue-to-branch.js';
export { DirectPushStrategy } from './direct-push.js';
export { OptimisticPushStrategy } from './optimistic-push.js';

/**
 * Register all built-in landing strategies on a WorkspaceManager.
 *
 * Called by boot-v2 after the WorkspaceManager is constructed.
 */
export function registerBuiltinLandingStrategies(ws: WorkspaceManager): void {
  ws.registerLandingStrategy(new MergeToParentStrategy());
  ws.registerLandingStrategy(new QueueToBranchStrategy());
  ws.registerLandingStrategy(new DirectPushStrategy());
  ws.registerLandingStrategy(new OptimisticPushStrategy());
}

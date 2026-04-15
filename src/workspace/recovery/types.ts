/**
 * Conflict recovery types.
 *
 * Parallel to LandingStrategy. Dispatched from the agent's done() flow when
 * a landing returns a conflict. Registered globally; selected via per-role
 * YAML `on_conflict_recovery` or team default.
 *
 * @module workspace/recovery/types
 * @see docs/conflict-recovery.md
 */

import type { AgentId, StreamId, Principal } from '../types-v3.js';
import type { WorkspaceManager } from '../types.js';

export interface ConflictContext {
  conflictId: string;
  streamId: StreamId;
  sourceCommit?: string;
  targetCommit?: string;
  targetStreamId?: StreamId;
  paths: string[];
  operation: 'merge' | 'sync' | 'rebase' | 'cascade';
  landingAgentId?: AgentId;
  /**
   * Worktree path where the conflict occurred. Required for
   * `auto-resolve` and any other strategy that needs to replay git
   * operations. Optional because some strategies (`defer`, `abandon`,
   * `escalate`) don't need filesystem access.
   */
  worktree?: string;
  recoveryDepth: number;
  strategyConfig?: Record<string, unknown>;
  workspaceManager: WorkspaceManager;
}

export type ConflictResolution =
  | { kind: 'resolved'; resolutionCommit: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'abandoned'; streamId: StreamId; reason: string }
  | { kind: 'escalated'; escalatedTo: Principal | 'human' }
  | { kind: 'retry-after'; backoffMs: number; reason: string }
  | { kind: 'failed'; error: string };

export type ConflictResolutionMode = 'sync' | 'async';

export interface ConflictRecoveryStrategy {
  readonly name: string;
  readonly mode: ConflictResolutionMode;

  canHandle?(ctx: ConflictContext): boolean;
  recover(ctx: ConflictContext): Promise<ConflictResolution>;
  initialize?(): Promise<void>;
  close?(): Promise<void>;
}

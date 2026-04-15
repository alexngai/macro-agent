/**
 * Workspace V3 Types — stream-first primitives.
 *
 * These types supplement the legacy role-shaped `types.ts` for the redesigned
 * workspace layer (see `docs/workspace-interfaces.md`). Once the migration is
 * complete (Phase 9), these merge back into `types.ts` and the V3 prefix is
 * dropped.
 *
 * @module workspace/types-v3
 */

import type {
  Stream as GCStream,
  AgentWorktree,
  MergeResult as GCMergeResult,
  RebaseResult as GCRebaseResult,
  Change as GCChange,
  ChangeStatus,
  ConflictStrategy as GCConflictStrategy,
  ConflictRecord as GCConflictRecord,
} from 'git-cascade';

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

export type AgentId = string;
export type StreamId = string;
export type ChangeId = string;
export type QueueEntryId = string;

/**
 * Pseudo-principals own resources that aren't bound to a live agent. Team-root
 * streams use `team:<name>`; system-created streams use `system:<subsystem>`.
 * Tagged via prefix; never terminates.
 */
export type PseudoAgentId = `team:${string}` | `system:${string}`;

export type Principal = AgentId | PseudoAgentId;

export const isPseudoAgentId = (p: Principal): p is PseudoAgentId =>
  p.startsWith('team:') || p.startsWith('system:');

// ─────────────────────────────────────────────────────────────────────────────
// Streams
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Specification for creating a new stream. If `parent` is set, the stream
 * forks from that parent stream. Otherwise, `forkFrom` names the branch to
 * fork from (defaults to 'main').
 */
export interface StreamSpec {
  name: string;
  ownerId: Principal;
  parent?: StreamId;
  forkFrom?: string;
  metadata?: Record<string, unknown>;
}

export type Stream = GCStream;
export type MergeResult = GCMergeResult;
export type RebaseResult = GCRebaseResult;
export type Change = GCChange;
export type ConflictStrategy = GCConflictStrategy;
export type ConflictRecord = GCConflictRecord;
export type { ChangeStatus };

// ─────────────────────────────────────────────────────────────────────────────
// Worktrees (role-neutral)
// ─────────────────────────────────────────────────────────────────────────────

export interface AllocateWorktreeOpts {
  agentId: Principal;
  streamId?: StreamId;
  baseDir?: string;
  pooled?: boolean;
  /**
   * If set, co-locate this agent on the referenced agent's worktree
   * (ref-counted; last-out wins on deallocation).
   */
  sharedWithAgent?: AgentId;
  /** Optional branch override; defaults to the stream's branch. */
  branch?: string;
}

export type Worktree = AgentWorktree;

// ─────────────────────────────────────────────────────────────────────────────
// Cascade
// ─────────────────────────────────────────────────────────────────────────────

export type CascadeStrategy = 'stop_on_conflict' | 'skip_conflicting' | 'defer_conflicts';

export interface CascadeResult {
  rootStreamId: StreamId;
  succeeded: StreamId[];
  failed: Array<{ streamId: StreamId; conflictId?: string; error?: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconcile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of macro-agent's reconcile wrapper — handles both git-cascade's
 * stream↔git sync and macro-level worktree/pool state.
 */
export interface MacroReconcileResult {
  streamsChecked: number;
  streamsFixed: number;
  worktreesOrphaned: number;
  worktreesCleaned: number;
  poolEntriesPurged: number;
  errors: Array<{ context: string; message: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Landing (interface only — strategies in Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

export interface LandingContext {
  agentId: AgentId;
  streamId: StreamId;
  sourceWorktree: string;
  targetStreamId?: StreamId;
  strategyConfig?: Record<string, unknown>;
  /** Reference to the manager; strategies call back for merge/cascade. */
  workspaceManager: unknown; // WorkspaceManager — circular; narrowed at callsite
}

export interface LandingStrategy {
  readonly name: string;
  canLand?(ctx: LandingContext): boolean;
  land(ctx: LandingContext): Promise<MergeResult>;
  initialize?(): Promise<void>;
  close?(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opaque branded marker — use for inferring that something is a v3 concept.
 * Only used in documentation / type exports; no runtime effect.
 */
export const V3_MARKER: unique symbol = Symbol('workspace.v3');

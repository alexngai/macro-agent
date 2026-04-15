/**
 * YAML Zod schema for `macro_agent.workspace`.
 *
 * Teams declare workspace topology via `macro_agent.workspace` in their
 * `team.yaml`. This module validates that section and exposes typed config
 * objects that the TopologyPolicy compiler (Phase 3) consumes.
 *
 * @module workspace/yaml-schema
 * @see docs/workspace-interfaces.md §8
 * @see docs/workspace-redesign-plan.md Phase 2
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const StreamLineageSchema = z.enum([
  'from_team_root',         // attach to the team's root stream (no new stream)
  'fork_from_team_root',    // fork a new stream off the team root
  'fork_from_parent',       // fork a new stream off the spawner's stream
  'independent',            // fork a new stream off a branch (no parent stream)
  'track_existing_branch',  // track an existing branch (no new stream/<id>)
]);

export const LandingStrategyNameSchema = z.enum([
  'merge_to_parent_stream',
  'queue_to_branch',
  'cherry_pick_stack',
  'direct_push',
  'optimistic_push',
  'none',
]);

export const ConflictStrategyNameSchema = z.enum([
  'abort',
  'ours',
  'theirs',
  'defer',
  'agent',
]);

/**
 * Recovery strategies for landing conflicts.
 * See docs/conflict-recovery.md §4.
 */
export const ConflictRecoveryStrategyNameSchema = z.enum([
  'auto-resolve',
  'defer',
  'spawn-resolver',
  'abandon',
  'escalate',
]);

export const WorkspaceKindSchema = z.enum([
  'new_stream',           // agent gets its own stream
  'attach_to_team_root',  // agent works on team root stream
  'share_with_agent',     // agent shares another agent's worktree (ref-counted)
  'share_parent_cwd',     // agent inherits spawner's cwd (no isolation)
  'none',                 // no workspace; agent has no streaming concerns
]);

export const AllocationSchema = z.enum([
  'new_worktree',
  'inherit_parent_cwd',
  'pooled_worktree',
]);

export const OnParentAdvancedSchema = z.enum([
  'sync_with_parent',
  'none',
]);

export const OnTeamCompleteSchema = z.enum([
  'keep',
  'merge_to_main',
  'abandon',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const RoleWorkspaceConfigSchema = z.object({
  workspace: WorkspaceKindSchema,
  stream_lineage: StreamLineageSchema.optional(),
  allocation: AllocationSchema.optional(),

  // Landing
  landing: LandingStrategyNameSchema.optional(),
  landing_config: z.record(z.string(), z.unknown()).optional(),

  // Conflict handling at landing time
  on_conflict: ConflictStrategyNameSchema.optional(),
  on_conflict_recovery: ConflictRecoveryStrategyNameSchema.optional(),
  conflict_recovery_config: z.record(z.string(), z.unknown()).optional(),

  // Cascade behavior
  cascade_on_parent_update: z.boolean().optional(),
  on_parent_advanced: OnParentAdvancedSchema.optional(),

  // Cross-role references
  share_with: z.string().optional(),   // role name (for workspace: share_with_agent)
  track_branch: z.string().optional(), // branch name (for stream_lineage: track_existing_branch)

  // Capabilities granted to this role for MCP tool gating
  capabilities: z.array(z.string()).optional(),
}).superRefine((val, ctx) => {
  if (val.workspace === 'share_with_agent' && !val.share_with) {
    ctx.addIssue({
      code: 'custom',
      path: ['share_with'],
      message: 'share_with is required when workspace = share_with_agent',
    });
  }
  if (val.stream_lineage === 'track_existing_branch' && !val.track_branch) {
    ctx.addIssue({
      code: 'custom',
      path: ['track_branch'],
      message: 'track_branch is required when stream_lineage = track_existing_branch',
    });
  }
  if (val.workspace === 'new_stream' && !val.stream_lineage) {
    ctx.addIssue({
      code: 'custom',
      path: ['stream_lineage'],
      message: 'stream_lineage is required when workspace = new_stream',
    });
  }
});

export const PoolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_size: z.number().int().positive().default(10),
  reuse_across_streams: z.boolean().default(false),
});

export const DefaultStreamConfigSchema = z.object({
  fork_from: z.string().default('main'),
  name_template: z.string().default('{team}'),
  change_id_tracking: z.boolean().default(true),
});

export const ConflictRecoveryTeamConfigSchema = z.object({
  default_strategy: ConflictRecoveryStrategyNameSchema.default('defer'),
  default_config: z.record(z.string(), z.unknown()).optional(),
  escalation_target: z.string().optional(),
  max_recovery_depth: z.number().int().positive().default(3),
});

export const TeamWorkspaceConfigSchema = z.object({
  default_stream: DefaultStreamConfigSchema.optional(),
  on_team_complete: OnTeamCompleteSchema.default('keep'),
  pool: PoolConfigSchema.optional(),
  roles: z.record(z.string(), RoleWorkspaceConfigSchema),
  conflict_recovery: ConflictRecoveryTeamConfigSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Types (inferred)
// ─────────────────────────────────────────────────────────────────────────────

export type StreamLineage = z.infer<typeof StreamLineageSchema>;
export type LandingStrategyName = z.infer<typeof LandingStrategyNameSchema>;
export type ConflictStrategyName = z.infer<typeof ConflictStrategyNameSchema>;
export type ConflictRecoveryStrategyName = z.infer<typeof ConflictRecoveryStrategyNameSchema>;
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;
export type Allocation = z.infer<typeof AllocationSchema>;
export type OnParentAdvanced = z.infer<typeof OnParentAdvancedSchema>;
export type OnTeamComplete = z.infer<typeof OnTeamCompleteSchema>;
export type RoleWorkspaceConfig = z.infer<typeof RoleWorkspaceConfigSchema>;
export type PoolConfig = z.infer<typeof PoolConfigSchema>;
export type DefaultStreamConfig = z.infer<typeof DefaultStreamConfigSchema>;
export type ConflictRecoveryTeamConfig = z.infer<typeof ConflictRecoveryTeamConfigSchema>;
export type TeamWorkspaceConfig = z.infer<typeof TeamWorkspaceConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse and validate a `macro_agent.workspace` block from a team manifest.
 *
 * Returns `null` when the block is absent (indicating no workspace isolation
 * is configured for the team). Throws on validation failure with a helpful
 * error message.
 */
export function parseTeamWorkspaceConfig(
  raw: unknown
): TeamWorkspaceConfig | null {
  if (raw === undefined || raw === null) return null;
  const result = TeamWorkspaceConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid macro_agent.workspace configuration:\n${issues}`
    );
  }
  return result.data;
}

/**
 * Extract the workspace block from a loaded openteams `TeamManifest`.
 *
 * openteams treats `macro_agent` as `Record<string, unknown>` — macro-agent
 * owns the schema inside.
 */
export function extractWorkspaceConfig(
  manifest: { macro_agent?: Record<string, unknown> }
): TeamWorkspaceConfig | null {
  const workspaceRaw = manifest.macro_agent?.workspace;
  return parseTeamWorkspaceConfig(workspaceRaw);
}

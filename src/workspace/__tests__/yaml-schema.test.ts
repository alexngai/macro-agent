/**
 * YAML schema validation tests (Phase 2).
 */

import { describe, it, expect } from 'vitest';
import {
  parseTeamWorkspaceConfig,
  extractWorkspaceConfig,
  TeamWorkspaceConfigSchema,
  RoleWorkspaceConfigSchema,
} from '../yaml-schema.js';

describe('YAML schema', () => {
  describe('parseTeamWorkspaceConfig', () => {
    it('returns null when input is undefined', () => {
      expect(parseTeamWorkspaceConfig(undefined)).toBeNull();
      expect(parseTeamWorkspaceConfig(null)).toBeNull();
    });

    it('accepts a minimal peer-swarm-style config', () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          peer: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_team_root',
            landing: 'merge_to_parent_stream',
          },
        },
      });
      expect(config).not.toBeNull();
      expect(config!.on_team_complete).toBe('keep'); // default
      expect(config!.roles.peer.workspace).toBe('new_stream');
    });

    it('applies defaults for default_stream', () => {
      const config = parseTeamWorkspaceConfig({
        default_stream: {},
        roles: { x: { workspace: 'none' } },
      });
      expect(config!.default_stream?.fork_from).toBe('main');
      expect(config!.default_stream?.change_id_tracking).toBe(true);
    });

    it('requires share_with when workspace is share_with_agent', () => {
      expect(() =>
        parseTeamWorkspaceConfig({
          roles: {
            reviewer: { workspace: 'share_with_agent' },
          },
        })
      ).toThrow(/share_with is required/);
    });

    it('requires track_branch when stream_lineage is track_existing_branch', () => {
      expect(() =>
        parseTeamWorkspaceConfig({
          roles: {
            resolver: {
              workspace: 'new_stream',
              stream_lineage: 'track_existing_branch',
            },
          },
        })
      ).toThrow(/track_branch is required/);
    });

    it('requires stream_lineage when workspace is new_stream', () => {
      expect(() =>
        parseTeamWorkspaceConfig({
          roles: {
            x: { workspace: 'new_stream' },
          },
        })
      ).toThrow(/stream_lineage is required/);
    });

    it('accepts triad shape with queue_to_branch + merge_queue.drain', () => {
      const config = parseTeamWorkspaceConfig({
        on_team_complete: 'keep',
        roles: {
          coordinator: { workspace: 'attach_to_team_root' },
          worker: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_parent',
            landing: 'queue_to_branch',
            landing_config: { target: 'team_root' },
            capabilities: ['workspace.commit', 'workspace.land'],
          },
          integrator: {
            workspace: 'attach_to_team_root',
            capabilities: ['workspace.merge', 'merge_queue.drain'],
          },
        },
      });
      expect(config).not.toBeNull();
      expect(config!.roles.worker.landing).toBe('queue_to_branch');
      expect(config!.roles.integrator.capabilities).toContain('merge_queue.drain');
    });

    it('accepts pipeline shape with share_with_agent', () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          planner: { workspace: 'none' },
          coder: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_team_root',
            landing: 'queue_to_branch',
          },
          reviewer: {
            workspace: 'share_with_agent',
            share_with: 'coder',
            capabilities: ['workspace.read'],
          },
        },
      });
      expect(config!.roles.reviewer.share_with).toBe('coder');
    });

    it('accepts long-lived feature config with cascade + auto-sync', () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          feature_owner: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_team_root',
            landing: 'merge_to_parent_stream',
            cascade_on_parent_update: true,
            on_parent_advanced: 'sync_with_parent',
          },
          subtask: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_parent',
            landing: 'merge_to_parent_stream',
          },
        },
      });
      expect(config!.roles.feature_owner.cascade_on_parent_update).toBe(true);
      expect(config!.roles.feature_owner.on_parent_advanced).toBe('sync_with_parent');
    });

    it('accepts conflict_recovery team defaults', () => {
      const config = parseTeamWorkspaceConfig({
        roles: { peer: { workspace: 'none' } },
        conflict_recovery: {
          default_strategy: 'spawn-resolver',
          default_config: { role: 'resolver', timeout_ms: 1200000 },
          max_recovery_depth: 5,
        },
      });
      expect(config!.conflict_recovery?.default_strategy).toBe('spawn-resolver');
      expect(config!.conflict_recovery?.max_recovery_depth).toBe(5);
    });

    it('rejects unknown workspace kinds', () => {
      expect(() =>
        parseTeamWorkspaceConfig({
          roles: { x: { workspace: 'made-up' } },
        })
      ).toThrow();
    });

    it('rejects unknown landing strategy names', () => {
      expect(() =>
        parseTeamWorkspaceConfig({
          roles: {
            x: {
              workspace: 'new_stream',
              stream_lineage: 'fork_from_team_root',
              landing: 'unknown-strategy',
            },
          },
        })
      ).toThrow();
    });
  });

  describe('extractWorkspaceConfig', () => {
    it('extracts workspace block from a manifest with macro_agent.workspace', () => {
      const manifest = {
        macro_agent: {
          workspace: {
            roles: { x: { workspace: 'none' } },
          },
        },
      };
      const config = extractWorkspaceConfig(manifest);
      expect(config).not.toBeNull();
    });

    it('returns null when macro_agent.workspace is absent', () => {
      const manifest = { macro_agent: { integration: { strategy: 'trunk' } } };
      expect(extractWorkspaceConfig(manifest)).toBeNull();
    });

    it('returns null when macro_agent is absent', () => {
      expect(extractWorkspaceConfig({})).toBeNull();
    });
  });

  describe('schema shape', () => {
    it('TeamWorkspaceConfigSchema is a zod object', () => {
      expect(TeamWorkspaceConfigSchema).toBeDefined();
      expect(typeof TeamWorkspaceConfigSchema.safeParse).toBe('function');
    });

    it('RoleWorkspaceConfigSchema is a zod schema', () => {
      expect(RoleWorkspaceConfigSchema).toBeDefined();
      expect(typeof RoleWorkspaceConfigSchema.safeParse).toBe('function');
    });
  });
});

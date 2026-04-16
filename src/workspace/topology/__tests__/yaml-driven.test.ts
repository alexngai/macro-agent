/**
 * YamlDrivenTopology tests (Phase 3).
 *
 * Verifies that the topology compiles each of the 6 workflow shapes from
 * docs/git-cascade-integration-gaps.md §5 into correct WorkspaceDecisions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { YamlDrivenTopology } from '../yaml-driven.js';
import { parseTeamWorkspaceConfig, type TeamWorkspaceConfig } from '../../yaml-schema.js';
import type { WorkspaceManager } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function mockWorkspaceManager(): WorkspaceManager {
  const createdStreams: string[] = [];
  return {
    createStreamV3: vi.fn((_spec) => {
      const id = `stream-${createdStreams.length + 1}`;
      createdStreams.push(id);
      return id;
    }),
    abandonStream: vi.fn(),
    deallocateWorkspace: vi.fn(),
    // The other methods are unused by topology logic in these tests.
  } as unknown as WorkspaceManager;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('YamlDrivenTopology', () => {
  describe('peer swarm', () => {
    let topology: YamlDrivenTopology;
    let ws: WorkspaceManager;

    beforeEach(async () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          orchestrator: { workspace: 'none' },
          peer: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_team_root',
            landing: 'merge_to_parent_stream',
          },
        },
      });
      topology = new YamlDrivenTopology(config!);
      ws = mockWorkspaceManager();
      await topology.onTeamStart({
        teamName: 'peer-swarm',
        teamInstanceId: 'swarm-1',
        workspaceConfig: config,
        workspaceManager: ws,
      });
    });

    it('creates a team root stream at start', () => {
      expect(ws.createStreamV3).toHaveBeenCalledOnce();
      expect(ws.createStreamV3).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'team:peer-swarm',
          forkFrom: 'main',
        })
      );
    });

    it('spawns orchestrator with kind=none', async () => {
      const decision = await topology.onAgentSpawn({
        agentId: 'agent-orch',
        role: 'orchestrator',
        workspaceManager: ws,
      });
      expect(decision.kind).toBe('none');
    });

    it('spawns peer with new-stream forked off team root', async () => {
      const decision = await topology.onAgentSpawn({
        agentId: 'agent-peer-1',
        role: 'peer',
        workspaceManager: ws,
      });
      expect(decision.kind).toBe('new-stream');
      if (decision.kind === 'new-stream') {
        expect(decision.streamSpec.parent).toBe('stream-1');
        expect(decision.streamSpec.ownerId).toBe('agent-peer-1');
        expect(decision.allocateWorktree).toBe(true);
      }
    });
  });

  describe('triad (coordinator / worker / integrator)', () => {
    let topology: YamlDrivenTopology;
    let ws: WorkspaceManager;

    beforeEach(async () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          coordinator: { workspace: 'attach_to_team_root' },
          worker: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_parent',
            landing: 'queue_to_branch',
          },
          integrator: {
            workspace: 'attach_to_team_root',
            capabilities: ['workspace.merge', 'merge_queue.drain'],
          },
        },
      });
      topology = new YamlDrivenTopology(config!);
      ws = mockWorkspaceManager();
      await topology.onTeamStart({
        teamName: 'triad',
        teamInstanceId: 'triad-1',
        workspaceConfig: config,
        workspaceManager: ws,
      });
    });

    it('attaches coordinator to team root stream', async () => {
      const decision = await topology.onAgentSpawn({
        agentId: 'agent-coord',
        role: 'coordinator',
        workspaceManager: ws,
      });
      expect(decision.kind).toBe('attach-to-stream');
      if (decision.kind === 'attach-to-stream') {
        expect(decision.streamId).toBe('stream-1');
      }
    });

    it('spawns worker with fork_from_parent lineage', async () => {
      const decision = await topology.onAgentSpawn({
        agentId: 'agent-worker',
        role: 'worker',
        parentAgentId: 'agent-coord',
        parentStreamId: 'stream-1',
        workspaceManager: ws,
      });
      expect(decision.kind).toBe('new-stream');
      if (decision.kind === 'new-stream') {
        expect(decision.streamSpec.parent).toBe('stream-1');
      }
    });
  });

  describe('pipeline (share_with_agent)', () => {
    it('resolves share_with via getAgentByRole callback', async () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          coder: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_team_root',
          },
          reviewer: {
            workspace: 'share_with_agent',
            share_with: 'coder',
          },
        },
      });
      const topology = new YamlDrivenTopology(config!);
      const ws = mockWorkspaceManager();
      await topology.onTeamStart({
        teamName: 'pipeline',
        teamInstanceId: 'p-1',
        workspaceConfig: config,
        workspaceManager: ws,
      });

      const decision = await topology.onAgentSpawn({
        agentId: 'agent-rev',
        role: 'reviewer',
        workspaceManager: ws,
        getAgentByRole: (r) => (r === 'coder' ? 'agent-coder' : null),
      });

      expect(decision.kind).toBe('share-with-agent');
      if (decision.kind === 'share-with-agent') {
        expect(decision.agentId).toBe('agent-coder');
      }
    });

    it('falls back to share-parent-cwd when share_with role has no active agent', async () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          coder: { workspace: 'new_stream', stream_lineage: 'fork_from_team_root' },
          reviewer: { workspace: 'share_with_agent', share_with: 'coder' },
        },
      });
      const topology = new YamlDrivenTopology(config!);
      const ws = mockWorkspaceManager();
      await topology.onTeamStart({
        teamName: 'pipeline',
        teamInstanceId: 'p-1',
        workspaceConfig: config,
        workspaceManager: ws,
      });

      const decision = await topology.onAgentSpawn({
        agentId: 'agent-rev',
        role: 'reviewer',
        workspaceManager: ws,
        getAgentByRole: () => null,
      });

      expect(decision.kind).toBe('share-parent-cwd');
    });
  });

  describe('research / read-only', () => {
    it('returns none for workspace: none, skips team root creation', async () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          researcher: { workspace: 'none' },
        },
      });
      const topology = new YamlDrivenTopology(config!);
      const ws = mockWorkspaceManager();
      const plan = await topology.onTeamStart({
        teamName: 'research',
        teamInstanceId: 'r-1',
        workspaceConfig: config,
        workspaceManager: ws,
      });

      expect(plan.teamStreamId).toBeUndefined();
      expect(ws.createStreamV3).not.toHaveBeenCalled();

      const decision = await topology.onAgentSpawn({
        agentId: 'agent-1',
        role: 'researcher',
        workspaceManager: ws,
      });
      expect(decision.kind).toBe('none');
    });
  });

  describe('solo stack', () => {
    it('author gets a new stream forked from team root', async () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          author: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_team_root',
            landing: 'merge_to_parent_stream',
            cascade_on_parent_update: true,
          },
        },
      });
      const topology = new YamlDrivenTopology(config!);
      const ws = mockWorkspaceManager();
      await topology.onTeamStart({
        teamName: 'solo',
        teamInstanceId: 's-1',
        workspaceConfig: config,
        workspaceManager: ws,
      });

      const decision = await topology.onAgentSpawn({
        agentId: 'agent-auth',
        role: 'author',
        workspaceManager: ws,
      });
      expect(decision.kind).toBe('new-stream');
      if (decision.kind === 'new-stream') {
        expect(decision.streamSpec.parent).toBe('stream-1');
      }
    });
  });

  describe('onTeamStop', () => {
    it('abandons team stream when on_team_complete=abandon', async () => {
      const config = parseTeamWorkspaceConfig({
        on_team_complete: 'abandon',
        roles: {
          peer: { workspace: 'new_stream', stream_lineage: 'fork_from_team_root' },
        },
      });
      const topology = new YamlDrivenTopology(config!);
      const ws = mockWorkspaceManager();
      await topology.onTeamStart({
        teamName: 'x',
        teamInstanceId: 'x-1',
        workspaceConfig: config,
        workspaceManager: ws,
      });
      await topology.onTeamStop({
        teamName: 'x',
        teamInstanceId: 'x-1',
        teamStreamId: 'stream-1',
        workspaceManager: ws,
      });

      expect(ws.abandonStream).toHaveBeenCalledWith(
        'stream-1',
        expect.objectContaining({ cascade: true })
      );
    });

    it('keeps team stream when on_team_complete=keep (default)', async () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          peer: { workspace: 'new_stream', stream_lineage: 'fork_from_team_root' },
        },
      });
      const topology = new YamlDrivenTopology(config!);
      const ws = mockWorkspaceManager();
      await topology.onTeamStart({
        teamName: 'x',
        teamInstanceId: 'x-1',
        workspaceConfig: config,
        workspaceManager: ws,
      });
      await topology.onTeamStop({
        teamName: 'x',
        teamInstanceId: 'x-1',
        teamStreamId: 'stream-1',
        workspaceManager: ws,
      });

      expect(ws.abandonStream).not.toHaveBeenCalled();
    });
  });

  describe('onAgentComplete', () => {
    it('deallocates the agent workspace', async () => {
      const config = parseTeamWorkspaceConfig({
        roles: {
          peer: { workspace: 'new_stream', stream_lineage: 'fork_from_team_root' },
        },
      });
      const topology = new YamlDrivenTopology(config!);
      const ws = mockWorkspaceManager();

      await topology.onAgentComplete({
        agentId: 'agent-1',
        role: 'peer',
        reason: 'completed',
        workspaceManager: ws,
      });

      expect(ws.deallocateWorkspace).toHaveBeenCalledWith('agent-1');
    });
  });
});

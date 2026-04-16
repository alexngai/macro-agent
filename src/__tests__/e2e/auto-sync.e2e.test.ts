/**
 * on_parent_advanced: sync_with_parent auto-sync e2e.
 *
 * Scenario: a role with `on_parent_advanced: sync_with_parent` has its
 * stream automatically rebased onto its parent when the parent advances.
 *
 * Fixture:
 *   team_root  (parent of both)
 *    ├── feature_owner stream (declares on_parent_advanced: sync_with_parent)
 *    └── (we simulate the parent advancing via commitChanges on team_root
 *         from a separate agent)
 *
 * Verifies:
 *  - Topology subscribes to stream:committed events on onTeamStart
 *  - syncWithParent is invoked on the feature_owner's stream when team_root
 *    gets a new commit
 *  - Coalescing: back-to-back commits within the debounce window produce
 *    only one sync call
 *
 * REQUIRES: RUN_E2E_TESTS=true
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { GitCascadeAdapter, createGitCascadeAdapter } from '../../workspace/git-cascade-adapter.js';
import {
  DefaultWorkspaceManager,
  createWorkspaceManagerWithAdapter,
} from '../../workspace/workspace-manager.js';
import { YamlDrivenTopology } from '../../workspace/topology/yaml-driven.js';
import { parseTeamWorkspaceConfig } from '../../workspace/yaml-schema.js';

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const describeFn = RUN_E2E ? describe : describe.skip;

describeFn('on_parent_advanced auto-sync', () => {
  let tempDir: string;
  let repoPath: string;
  let adapter: GitCascadeAdapter;
  let manager: DefaultWorkspaceManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-sync-'));
    repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath);

    execSync('git init -b main', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: 'pipe' });

    adapter = createGitCascadeAdapter({
      enabled: true,
      repoPath,
      dbPath: path.join(tempDir, 'gc.db'),
      skipRecovery: true,
    });
    manager = createWorkspaceManagerWithAdapter(adapter, {
      worktreeBaseDir: path.join(tempDir, 'worktrees'),
    }) as DefaultWorkspaceManager;
  });

  afterEach(() => {
    manager.close();
    adapter.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('subscribes to stream:committed and syncs affected children', async () => {
    const config = parseTeamWorkspaceConfig({
      roles: {
        feature_owner: {
          workspace: 'new_stream',
          stream_lineage: 'fork_from_team_root',
          landing: 'merge_to_parent_stream',
          on_parent_advanced: 'sync_with_parent',
          on_conflict: 'ours',
        },
      },
    });
    const topology = new YamlDrivenTopology(config!);
    const startCtx = {
      teamName: 'sync-test',
      teamInstanceId: 'sync-1',
      workspaceConfig: config,
      workspaceManager: manager,
    };
    await topology.onTeamStart(startCtx);

    const teamStream = manager
      .listStreams()
      .find((s) => s.agentId === 'team:sync-test');
    expect(teamStream).toBeDefined();

    // Spawn a feature_owner and allocate its workspace
    const decision = await topology.onAgentSpawn({
      agentId: 'agent-feat',
      role: 'feature_owner',
      workspaceManager: manager,
    });
    expect(decision.kind).toBe('new-stream');
    let featStreamId: string | null = null;
    if (decision.kind === 'new-stream') {
      featStreamId = manager.createStreamV3(decision.streamSpec);
      manager.allocateWorktree({
        agentId: 'agent-feat',
        streamId: featStreamId,
      });
      topology.recordAgentStream('agent-feat', featStreamId, 'feature_owner');
    }
    expect(featStreamId).not.toBeNull();

    // Spy on syncWithParent to detect auto-sync calls
    const syncSpy = vi.spyOn(manager, 'syncWithParent');

    // Simulate team_root advancing: commit something via a separate agent
    // on the team_root stream.
    manager.allocateWorktree({
      agentId: 'agent-on-root',
      streamId: teamStream!.id,
    });
    const rootWorktree = manager.getWorktreeForAgent('agent-on-root')!;
    fs.writeFileSync(path.join(rootWorktree.path, 'advance.txt'), 'new content\n');
    manager.commitChanges({
      agentId: 'agent-on-root',
      streamId: teamStream!.id,
      worktree: rootWorktree.path,
      message: 'advance team root',
    });

    // Allow event handler to fire (it's sync but dispatch is async)
    await new Promise((r) => setTimeout(r, 50));

    expect(syncSpy).toHaveBeenCalled();
    const call = syncSpy.mock.calls[0]?.[0];
    expect(call?.streamId).toBe(featStreamId);
    expect(call?.agentId).toBe('agent-feat');
    expect(call?.onConflict).toBe('ours');

    await topology.onTeamStop({
      teamName: 'sync-test',
      teamInstanceId: 'sync-1',
      teamStreamId: teamStream!.id,
      workspaceManager: manager,
    });
  });

  it('coalesces back-to-back commits within debounce window', async () => {
    const config = parseTeamWorkspaceConfig({
      roles: {
        feature_owner: {
          workspace: 'new_stream',
          stream_lineage: 'fork_from_team_root',
          on_parent_advanced: 'sync_with_parent',
        },
      },
    });
    const topology = new YamlDrivenTopology(config!);
    await topology.onTeamStart({
      teamName: 'coalesce-test',
      teamInstanceId: 'c-1',
      workspaceConfig: config,
      workspaceManager: manager,
    });

    const teamStream = manager
      .listStreams()
      .find((s) => s.agentId === 'team:coalesce-test');
    expect(teamStream).toBeDefined();

    const decision = await topology.onAgentSpawn({
      agentId: 'agent-feat',
      role: 'feature_owner',
      workspaceManager: manager,
    });
    let featStreamId: string | null = null;
    if (decision.kind === 'new-stream') {
      featStreamId = manager.createStreamV3(decision.streamSpec);
      manager.allocateWorktree({
        agentId: 'agent-feat',
        streamId: featStreamId,
      });
      topology.recordAgentStream('agent-feat', featStreamId, 'feature_owner');
    }

    const syncSpy = vi.spyOn(manager, 'syncWithParent');

    manager.allocateWorktree({
      agentId: 'agent-root',
      streamId: teamStream!.id,
    });
    const rootWorktree = manager.getWorktreeForAgent('agent-root')!;

    // 3 back-to-back commits — should coalesce to 1 sync
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(rootWorktree.path, `c${i}.txt`),
        `content ${i}\n`
      );
      manager.commitChanges({
        agentId: 'agent-root',
        streamId: teamStream!.id,
        worktree: rootWorktree.path,
        message: `commit ${i}`,
      });
    }

    await new Promise((r) => setTimeout(r, 50));
    expect(syncSpy.mock.calls.length).toBe(1);
  });

  it('does not subscribe when no role declares on_parent_advanced', async () => {
    const config = parseTeamWorkspaceConfig({
      roles: {
        plain_role: {
          workspace: 'new_stream',
          stream_lineage: 'fork_from_team_root',
        },
      },
    });
    const topology = new YamlDrivenTopology(config!);
    await topology.onTeamStart({
      teamName: 'no-autosync',
      teamInstanceId: 'n-1',
      workspaceConfig: config,
      workspaceManager: manager,
    });

    const teamStream = manager
      .listStreams()
      .find((s) => s.agentId === 'team:no-autosync');

    const syncSpy = vi.spyOn(manager, 'syncWithParent');

    // Even if we commit on team_root, no sync should fire
    manager.allocateWorktree({
      agentId: 'agent-x',
      streamId: teamStream!.id,
    });
    const wt = manager.getWorktreeForAgent('agent-x')!;
    fs.writeFileSync(path.join(wt.path, 'x.txt'), 'x\n');
    manager.commitChanges({
      agentId: 'agent-x',
      streamId: teamStream!.id,
      worktree: wt.path,
      message: 'x',
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(syncSpy).not.toHaveBeenCalled();
  });
});

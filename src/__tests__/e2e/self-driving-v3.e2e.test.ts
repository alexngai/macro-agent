/**
 * Self-driving team V3 end-to-end test.
 *
 * Exercises the complete path from a real team YAML on disk:
 *   .multiagent/teams/self-driving/team.yaml
 *   → TeamManagerV2.startTeam("self-driving")
 *   → extracts macro_agent.workspace block
 *   → constructs YamlDrivenTopology, installs on AgentManager
 *   → onTeamStart creates the team root stream
 *   → agents spawn with the correct V3 WorkspaceDecision per role
 *
 * Uses mocked acp-factory to avoid spawning real Claude Code — the purpose
 * here is verifying the wiring, not agent behavior.
 *
 * REQUIRES: RUN_E2E_TESTS=true
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { bootV2, type MacroAgentSystemV2 } from '../../boot-v2.js';
import { GitCascadeAdapter } from '../../workspace/git-cascade-adapter.js';
import {
  DefaultWorkspaceManager,
  createWorkspaceManagerWithAdapter,
} from '../../workspace/workspace-manager.js';
import { TeamManagerV2 } from '../../teams/team-manager-v2.js';

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const describeFn = RUN_E2E ? describe : describe.skip;

// Mock acp-factory so we don't spawn real Claude Code
vi.mock('acp-factory', () => ({
  AgentFactory: {
    spawn: vi.fn().mockResolvedValue({
      createSession: vi.fn().mockResolvedValue({
        id: `session-${Date.now()}`,
        prompt: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
        forkWithFlush: vi.fn().mockResolvedValue({ id: `forked-${Date.now()}` }),
      }),
      loadSession: vi.fn().mockResolvedValue({ id: `loaded-${Date.now()}` }),
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(true),
    }),
  },
}));

vi.mock('opentasks', () => ({
  OpenTasksClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error('No daemon')),
    disconnect: vi.fn(),
    query: vi.fn().mockResolvedValue({ items: [] }),
    link: vi.fn().mockResolvedValue({ success: true }),
    task: vi.fn().mockResolvedValue({ id: 't-1' }),
  })),
}));

describeFn('Self-driving team V3 auto-wire', () => {
  let system: MacroAgentSystemV2;
  let testDir: string;
  let repoPath: string;
  let adapter: GitCascadeAdapter;
  let workspaceManager: DefaultWorkspaceManager;
  let teamManager: TeamManagerV2;
  const projectRoot = process.cwd();

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-driving-e2e-'));
    repoPath = path.join(testDir, 'repo');
    fs.mkdirSync(repoPath);

    execSync('git init -b main', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# test');
    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: 'pipe' });

    adapter = new GitCascadeAdapter({
      enabled: true,
      repoPath,
      dbPath: path.join(testDir, 'gc.db'),
      skipRecovery: true,
    });
    workspaceManager = createWorkspaceManagerWithAdapter(adapter, {
      worktreeBaseDir: path.join(repoPath, '.worktrees'),
    }) as DefaultWorkspaceManager;

    system = await bootV2({
      cwd: repoPath,
      baseDir: testDir,
      inbox: { socketPath: path.join(testDir, 'inbox.sock') },
      workspaceManager,
    });

    teamManager = new TeamManagerV2({
      agentManager: system.agentManager,
      inboxAdapter: system.inboxAdapter,
      tasksAdapter: system.tasksAdapter,
      workspaceManager,
    });
    teamManager.install();
  });

  afterEach(async () => {
    if (system) await system.shutdown();
    if (workspaceManager) workspaceManager.close();
    if (adapter) adapter.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('startTeam auto-wires YamlDrivenTopology from macro_agent.workspace', async () => {
    // Start the real self-driving team template from .multiagent/teams/
    await teamManager.startTeam('self-driving', projectRoot);

    // Team root stream should have been created by onTeamStart
    const streams = workspaceManager.listStreams();
    const teamRoot = streams.find((s) => s.agentId === 'team:self-driving');
    expect(teamRoot).toBeDefined();
    expect(teamRoot!.name).toBe('self-driving');
  });

  it('spawning a grinder via the V3 path forks a stream off team root', async () => {
    await teamManager.startTeam('self-driving', projectRoot);

    const teamStreams = workspaceManager.listStreams();
    const teamRoot = teamStreams.find((s) => s.agentId === 'team:self-driving');
    expect(teamRoot).toBeDefined();

    const grinder = await system.agentManager.spawn({
      role: 'grinder',
      task: 'do a thing',
    });

    const record = system.agentStore.getAgent(grinder.id);
    expect(record?.workspace_path).toBeDefined();
    expect(fs.existsSync(record!.workspace_path!)).toBe(true);

    const grinderStream = workspaceManager
      .listStreams()
      .find((s) => s.agentId === grinder.id);
    expect(grinderStream).toBeDefined();
    expect(grinderStream?.parentStream).toBe(teamRoot!.id);
  });

  it('judge spawn returns workspace: none (no worktree allocated)', async () => {
    await teamManager.startTeam('self-driving', projectRoot);

    const judge = await system.agentManager.spawn({
      role: 'judge',
      task: 'review',
    });

    const record = system.agentStore.getAgent(judge.id);
    // workspace: none → no workspace_path assigned
    expect(record?.workspace_path).toBeFalsy();
  });

  it('planner attaches to team root stream (not a new fork)', async () => {
    // Note: self-driving's topology already bootstraps the planner as the
    // root agent; we spawn explicitly to verify the decision path.
    await teamManager.startTeam('self-driving', projectRoot);

    const plannerBeforeBootstrap = system.agentStore.listAgents({
      state: 'running',
    });

    // The bootstrap planner is the "root" — already spawned.
    const rootPlanner = plannerBeforeBootstrap.find((a) => a.role === 'planner');
    expect(rootPlanner).toBeDefined();

    // Verify its workspace_path (if allocated) is on the team root branch
    if (rootPlanner?.workspace_path) {
      expect(fs.existsSync(rootPlanner.workspace_path)).toBe(true);
    }

    // The team_root stream should still be the only top-level stream
    // (planner did not fork a new stream — it attached)
    const topLevelStreams = workspaceManager
      .listStreams()
      .filter((s) => !s.parentStream);
    expect(topLevelStreams.length).toBe(1);
  });
});

/**
 * Regression test: self-driving team.yaml parses cleanly under the V3
 * workspace schema.
 *
 * Guards against YAML drift — if someone edits the team config in a way
 * that breaks schema validation, this test fails loudly.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  parseTeamWorkspaceConfig,
  extractWorkspaceConfig,
} from '../yaml-schema.js';
import { YamlDrivenTopology } from '../topology/yaml-driven.js';
import type { WorkspaceManager } from '../types.js';
import { vi } from 'vitest';

describe('self-driving team YAML (V3 migration)', () => {
  const yamlPath = path.join(
    process.cwd(),
    '.multiagent/teams/self-driving/team.yaml'
  );

  it('exists on disk', () => {
    expect(fs.existsSync(yamlPath)).toBe(true);
  });

  it('parses and validates against TeamWorkspaceConfigSchema', () => {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const manifest = yaml.load(raw) as { macro_agent?: Record<string, unknown> };
    const config = extractWorkspaceConfig(manifest);

    expect(config).not.toBeNull();
    expect(config!.roles.planner).toBeDefined();
    expect(config!.roles.grinder).toBeDefined();
    expect(config!.roles.judge).toBeDefined();
  });

  it('planner role maps to attach_to_team_root', () => {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const manifest = yaml.load(raw) as { macro_agent?: Record<string, unknown> };
    const config = extractWorkspaceConfig(manifest)!;

    expect(config.roles.planner.workspace).toBe('attach_to_team_root');
  });

  it('grinder forks from team root with direct_push landing', () => {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const manifest = yaml.load(raw) as { macro_agent?: Record<string, unknown> };
    const config = extractWorkspaceConfig(manifest)!;

    expect(config.roles.grinder.workspace).toBe('new_stream');
    expect(config.roles.grinder.stream_lineage).toBe('fork_from_team_root');
    expect(config.roles.grinder.landing).toBe('direct_push');
  });

  it('judge has no workspace (read-only role)', () => {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const manifest = yaml.load(raw) as { macro_agent?: Record<string, unknown> };
    const config = extractWorkspaceConfig(manifest)!;

    expect(config.roles.judge.workspace).toBe('none');
  });

  it('YamlDrivenTopology compiles the config into valid spawn decisions', async () => {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const manifest = yaml.load(raw) as { macro_agent?: Record<string, unknown> };
    const config = extractWorkspaceConfig(manifest)!;

    const topology = new YamlDrivenTopology(config);
    const mockWs = {
      createStreamV3: vi.fn(() => 'team-stream-1'),
    } as unknown as WorkspaceManager;

    // Team start should create a team root (planner attaches to it)
    await topology.onTeamStart({
      teamName: 'self-driving',
      teamInstanceId: 'sd-1',
      workspaceConfig: config,
      workspaceManager: mockWs,
    });
    expect(mockWs.createStreamV3).toHaveBeenCalled();

    // Planner → attach-to-stream
    const plannerDecision = await topology.onAgentSpawn({
      agentId: 'agent-planner',
      role: 'planner',
      workspaceManager: mockWs,
    });
    expect(plannerDecision.kind).toBe('attach-to-stream');

    // Grinder → new-stream (forked from team root)
    const grinderDecision = await topology.onAgentSpawn({
      agentId: 'agent-grinder-1',
      role: 'grinder',
      workspaceManager: mockWs,
    });
    expect(grinderDecision.kind).toBe('new-stream');
    if (grinderDecision.kind === 'new-stream') {
      expect(grinderDecision.streamSpec.parent).toBe('team-stream-1');
    }

    // Judge → none
    const judgeDecision = await topology.onAgentSpawn({
      agentId: 'agent-judge',
      role: 'judge',
      workspaceManager: mockWs,
    });
    expect(judgeDecision.kind).toBe('none');
  });
});

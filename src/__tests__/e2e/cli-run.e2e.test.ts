/**
 * `multiagent-cli run <team>` CLI e2e.
 *
 * Spawns the CLI as a real subprocess with a minimal team fixture (so we
 * don't need a full team YAML tree in the test repo). Verifies:
 *   - CLI boots successfully
 *   - Team starts (log output confirms)
 *   - SIGINT shutdown exits cleanly
 *
 * REQUIRES: RUN_E2E_TESTS=true
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, type ChildProcess } from 'child_process';

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const describeFn = RUN_E2E ? describe : describe.skip;

describeFn('multiagent-cli run <team>', () => {
  let testDir: string;
  let cliProcess: ChildProcess | null = null;
  const cliPath = path.resolve(process.cwd(), 'dist/cli/index.js');

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-e2e-'));

    // Minimal project scaffolding: a git repo + .multiagent/teams/<name>/
    const repoPath = path.join(testDir, 'repo');
    fs.mkdirSync(repoPath);
    // initialize git so git-cascade can attach
    const { execSync } = require('child_process');
    execSync('git init -b main', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# test');
    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: 'pipe' });

    // Minimal team template (no macro_agent.workspace — simplest path)
    const teamDir = path.join(repoPath, '.multiagent/teams/minimal');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.mkdirSync(path.join(teamDir, 'prompts'));
    fs.writeFileSync(
      path.join(teamDir, 'team.yaml'),
      `name: minimal
description: Minimal team for CLI e2e
version: 1

roles:
  - worker

topology:
  root:
    role: worker
    prompt: prompts/worker.md

communication:
  enforcement: permissive
`
    );
    fs.writeFileSync(path.join(teamDir, 'prompts/worker.md'), '# Worker\nDo work.\n');
  });

  afterEach(async () => {
    if (cliProcess && !cliProcess.killed) {
      cliProcess.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!cliProcess.killed) cliProcess.kill('SIGKILL');
    }
    cliProcess = null;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('boots, starts the team, and responds to SIGINT with clean shutdown', async () => {
    const repoPath = path.join(testDir, 'repo');
    const baseDir = path.join(testDir, 'state');
    fs.mkdirSync(baseDir);

    cliProcess = spawn(
      'node',
      [cliPath, 'run', 'minimal', '--cwd', repoPath, '--base-path', repoPath],
      {
        env: {
          ...process.env,
          MACRO_BASE_DIR: baseDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    cliProcess.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    cliProcess.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Wait for the CLI to reach "Team started" or timeout
    const booted = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 15_000);
      const check = setInterval(() => {
        if (stdout.includes('Team started') || stdout.includes('team started')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve(true);
        }
      }, 100);
    });

    if (!booted) {
      console.error('stdout:', stdout);
      console.error('stderr:', stderr);
    }
    expect(booted).toBe(true);
    expect(stdout).toContain('booted');

    // Send SIGINT and verify clean exit
    const exitPromise = new Promise<number | null>((resolve) => {
      cliProcess!.once('exit', (code) => resolve(code));
    });

    cliProcess.kill('SIGINT');
    const exitCode = await Promise.race([
      exitPromise,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(-1), 5_000)),
    ]);

    expect(exitCode).toBe(0);
  });

  it('prints an error and exits non-zero when team does not exist', async () => {
    const repoPath = path.join(testDir, 'repo');
    const baseDir = path.join(testDir, 'state');
    fs.mkdirSync(baseDir);

    cliProcess = spawn(
      'node',
      [cliPath, 'run', 'no-such-team', '--cwd', repoPath, '--base-path', repoPath],
      {
        env: { ...process.env, MACRO_BASE_DIR: baseDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stderr = '';
    let stdout = '';
    cliProcess.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    cliProcess.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));

    const exitCode: number | null = await new Promise((resolve) => {
      cliProcess!.once('exit', (code) => resolve(code));
      setTimeout(() => resolve(-1), 15_000);
    });

    expect(exitCode).not.toBe(0);
    // Accept error text from either stdout (chalk.red) or stderr
    const combined = stdout + stderr;
    expect(combined.toLowerCase()).toMatch(/fail|error|no-such-team/);
  });
});

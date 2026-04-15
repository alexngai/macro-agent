/**
 * Standalone-mode regression test (G11).
 *
 * Asserts that GitCascadeAdapter (and the cascade event flow it drives)
 * works correctly when no MAP sidecar / cascade bridge is configured —
 * i.e., macro-agent runs without an OpenHive hub.
 *
 * The contract: cascade emits its own structured event stream regardless,
 * and operations succeed without any hub roundtrip. If a future change
 * accidentally introduces a hard dependency on the bridge or sidecar
 * (e.g., awaiting a hub call inside cascade), this test catches it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { GitCascadeAdapter } from "../git-cascade-adapter.js";
import type { GitCascadeEvent } from "../git-cascade-adapter.js";

function mkTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "macro-standalone-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".git-cascade/\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
  fs.mkdirSync(path.join(dir, ".git-cascade"), { recursive: true });
  return dir;
}

describe("standalone mode: GitCascadeAdapter without sidecar/bridge", () => {
  let repoPath: string;
  let adapter: GitCascadeAdapter;

  beforeEach(() => {
    repoPath = mkTempRepo();
    // Construct the adapter with no MAP sidecar — same shape as boot-v2 when
    // `config.map?.enabled !== true`. No CascadeBridge is ever wired.
    adapter = new GitCascadeAdapter({ repoPath });
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("runs full stream lifecycle without errors and produces local events", () => {
    const events: GitCascadeEvent[] = [];
    adapter.onEvent((e) => events.push(e));

    // Open a stream
    const streamId = adapter.createStream({
      name: "standalone-feat",
      agentId: "a1",
    });
    expect(streamId).toBeTruthy();

    // Create worktree + commit through tracker
    const wt = path.join(repoPath, ".worktrees", "a1");
    adapter.createWorktree({
      agentId: "a1",
      path: wt,
      branch: `stream/${streamId}`,
    });
    fs.writeFileSync(path.join(wt, "x.txt"), "hi\n");
    execSync("git add .", { cwd: wt, stdio: "pipe" });
    const result = adapter.commitChanges({
      streamId,
      agentId: "a1",
      worktree: wt,
      message: "feat: add x",
      metadata: { task_ref: { resource_id: "r", node_id: "n" } },
    });
    expect(result.commit).toBeTruthy();
    expect(result.changeId).toBeTruthy();

    // Abandon
    adapter.abandonStream(streamId, { reason: "test" });

    // Verify expected events fired locally (no hub involved)
    const types = events.map((e) => e.type);
    expect(types).toContain("stream:created");
    expect(types).toContain("stream:committed");
    expect(types).toContain("stream:abandoned");
  });

  it("does not throw when no event listener is attached", () => {
    // No onEvent subscribers — adapter must not assume any.
    const streamId = adapter.createStream({ name: "lonely", agentId: "a" });
    expect(streamId).toBeTruthy();
    adapter.abandonStream(streamId, { reason: "test" });
  });

  it("preserves Change-Id even with no hub forwarding", () => {
    // Confirms the tracker's emit hook works locally even when nothing
    // forwards events — the Change-Id is computed by git-cascade itself, not
    // by the bridge.
    const streamId = adapter.createStream({ name: "chgid", agentId: "a" });
    const wt = path.join(repoPath, ".worktrees", "a");
    adapter.createWorktree({
      agentId: "a",
      path: wt,
      branch: `stream/${streamId}`,
    });
    fs.writeFileSync(path.join(wt, "y.txt"), "y\n");
    execSync("git add .", { cwd: wt, stdio: "pipe" });
    const { changeId } = adapter.commitChanges({
      streamId,
      agentId: "a",
      worktree: wt,
      message: "test",
    });
    expect(changeId).toMatch(/^c-/);
  });
});

/**
 * Cognitive-Ops Team Integration Tests
 *
 * Validates that the cognitive-ops team YAML config loads correctly,
 * roles resolve with expected capabilities, and communication topology
 * is valid.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as path from "path";
import { loadTeam } from "../../teams/team-loader.js";
import { DefaultRoleRegistry } from "../../roles/registry.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("cognitive-ops team template", () => {
  let roleRegistry: DefaultRoleRegistry;

  beforeEach(() => {
    roleRegistry = new DefaultRoleRegistry();
  });

  it("loads cognitive-ops team template", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    expect(manifest.name).toBe("cognitive-ops");
    expect(manifest.version).toBe(1);
    expect(manifest.roles).toEqual(["coordinator", "analyst"]);
  });

  it("resolves coordinator with correct base role", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const coordinator = manifest._resolvedRoles.get("coordinator");
    expect(coordinator).toBeDefined();
    expect(coordinator!.baseRole).toBe("coordinator");
  });

  it("resolves analyst role extending worker", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const analyst = manifest._resolvedRoles.get("analyst");
    expect(analyst).toBeDefined();
    expect(analyst!.baseRole).toBe("worker");
  });

  it("analyst has task.claim capability", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const analyst = manifest._resolvedRoles.get("analyst");
    expect(analyst!.capabilities).toContain("task.claim");
  });

  it("analyst does not have removed capabilities", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const analyst = manifest._resolvedRoles.get("analyst");
    expect(analyst!.capabilities).not.toContain("agent.spawn.worker");
    expect(analyst!.capabilities).not.toContain("git.commit");
    expect(analyst!.capabilities).not.toContain("file.delete");
    expect(analyst!.capabilities).not.toContain("exec.build");
    expect(analyst!.capabilities).not.toContain("exec.test");
    expect(analyst!.capabilities).not.toContain("exec.lint");
    expect(analyst!.capabilities).not.toContain("msg.send");
  });

  it("analyst retains file.read, file.write, exec.command, lifecycle.done", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const analyst = manifest._resolvedRoles.get("analyst");
    expect(analyst!.capabilities).toContain("file.read");
    expect(analyst!.capabilities).toContain("file.write");
    expect(analyst!.capabilities).toContain("exec.command");
    expect(analyst!.capabilities).toContain("lifecycle.done");
  });

  it("coordinator has spawn capability for analyst", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const coordinator = manifest._resolvedRoles.get("coordinator");
    expect(coordinator!.capabilities).toContain("agent.spawn.analyst");
  });

  it("analyst has no spawn capabilities", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const analyst = manifest._resolvedRoles.get("analyst");
    const spawnCaps = analyst!.capabilities.filter((c) =>
      c.startsWith("agent.spawn."),
    );
    expect(spawnCaps).toEqual([]);
  });

  it("analyst workspace type is none", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const analyst = manifest._resolvedRoles.get("analyst");
    expect(analyst!.roleDefinition.workspace?.type).toBe("none");
  });

  it("analyst lifecycle is ephemeral and task-bound", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const analyst = manifest._resolvedRoles.get("analyst");
    expect(analyst!.roleDefinition.lifecycle?.type).toBe("ephemeral");
    expect(analyst!.roleDefinition.lifecycle?.taskBound).toBe(true);
    expect(analyst!.roleDefinition.lifecycle?.cascadeTerminate).toBe(true);
    expect(analyst!.roleDefinition.lifecycle?.selfCleanup).toBe(true);
  });

  it("parses macro_agent extensions", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    expect(manifest.macro_agent.task_assignment?.mode).toBe("pull");
    expect(manifest.macro_agent.task_assignment?.pull?.idle_timeout_s).toBe(120);
    expect(manifest.macro_agent.task_assignment?.pull?.max_concurrent_per_agent).toBe(1);
    expect(manifest.macro_agent.lifecycle?.scaling?.max_workers).toBe(4);
  });

  it("defines analysis_updates communication channel", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    expect(manifest.communication.channels).toBeDefined();
    expect(Object.keys(manifest.communication.channels!)).toContain("analysis_updates");

    const channel = manifest.communication.channels!.analysis_updates;
    expect(channel.signals).toContain("ANALYSIS_COMPLETE");
    expect(channel.signals).toContain("ANALYSIS_FAILED");
    expect(channel.signals).toContain("EXTRACTION_COMPLETE");
  });

  it("coordinator subscribes to analysis_updates", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const coordinatorSubs = manifest.communication.subscriptions?.coordinator;
    expect(coordinatorSubs).toBeDefined();
    expect(coordinatorSubs!.some((s) => s.channel === "analysis_updates")).toBe(true);
  });

  it("analyst can emit ANALYSIS_COMPLETE and ANALYSIS_FAILED", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    const analystEmissions = manifest.communication.emissions?.analyst;
    expect(analystEmissions).toContain("ANALYSIS_COMPLETE");
    expect(analystEmissions).toContain("ANALYSIS_FAILED");
  });

  it("loads coordinator prompt", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    expect(manifest._loadedPrompts.has("prompts/coordinator.md")).toBe(true);
    const prompt = manifest._loadedPrompts.get("prompts/coordinator.md")!;
    expect(prompt).toContain("coordinator");
  });

  it("status routing is upstream", async () => {
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);

    expect(manifest.communication.routing?.status).toBe("upstream");
  });
});

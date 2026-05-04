/**
 * Unit tests for `handleDispatchSpawnAgent` — the MAP `dispatch/spawn-agent`
 * request handler. All dependencies are mocked.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from "vitest";
import {
  handleDispatchSpawnAgent,
  type SpawnAgentRequest,
  type SpawnAgentHandlerDeps,
} from "../spawn-agent-handler.js";
import type { AgentManager } from "../../agent/agent-manager.js";

// ─────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────

function makeAgentManager(spawnedId = "agent-spawn-1"): {
  manager: Partial<AgentManager>;
  spawnFn: MockedFunction<AgentManager["spawn"]>;
} {
  const spawnFn = vi.fn().mockResolvedValue({ id: spawnedId }) as unknown as MockedFunction<
    AgentManager["spawn"]
  >;
  return {
    manager: { spawn: spawnFn },
    spawnFn,
  };
}

function makeDeps(
  am: ReturnType<typeof makeAgentManager>,
  overrides: Partial<SpawnAgentHandlerDeps> = {},
): SpawnAgentHandlerDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    agentManager: am.manager as AgentManager,
    log: (msg: string) => logs.push(msg),
    ...overrides,
    logs,
  } as SpawnAgentHandlerDeps & { logs: string[] };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("handleDispatchSpawnAgent", () => {
  let am: ReturnType<typeof makeAgentManager>;

  beforeEach(() => {
    am = makeAgentManager("agent-spawn-1");
  });

  // ── Validation ───────────────────────────────────────────────

  it("throws on missing role", async () => {
    const deps = makeDeps(am);
    const params = { cwd: "/tmp/work" } as SpawnAgentRequest;
    await expect(handleDispatchSpawnAgent(params, deps)).rejects.toThrow(
      /missing 'role'/,
    );
    expect(am.spawnFn).not.toHaveBeenCalled();
  });

  it("throws on lifecycle: 'reuse' (handler is fresh-only)", async () => {
    const deps = makeDeps(am);
    const params: SpawnAgentRequest = {
      role: "coordinator",
      cwd: "/tmp/work",
      lifecycle: "reuse",
    };
    await expect(handleDispatchSpawnAgent(params, deps)).rejects.toThrow(
      /lifecycle='reuse'/,
    );
    expect(am.spawnFn).not.toHaveBeenCalled();
  });

  it("proceeds with lifecycle: 'fresh'", async () => {
    const deps = makeDeps(am);
    const params: SpawnAgentRequest = {
      role: "coordinator",
      cwd: "/tmp/work",
      lifecycle: "fresh",
    };
    const result = await handleDispatchSpawnAgent(params, deps);
    expect(result).toEqual({ agentId: "agent-spawn-1" });
    expect(am.spawnFn).toHaveBeenCalledOnce();
  });

  it("proceeds when lifecycle is omitted (defaults to fresh)", async () => {
    const deps = makeDeps(am);
    const params: SpawnAgentRequest = {
      role: "coordinator",
      cwd: "/tmp/work",
    };
    const result = await handleDispatchSpawnAgent(params, deps);
    expect(result).toEqual({ agentId: "agent-spawn-1" });
    expect(am.spawnFn).toHaveBeenCalledOnce();
  });

  // ── Spawn-options derivation ──────────────────────────────────

  it("calls agentManager.spawn with options derived via loadoutToSpawnOptions", async () => {
    const deps = makeDeps(am);
    const params: SpawnAgentRequest = {
      role: "coordinator",
      cwd: "/tmp/work",
      lifecycle: "fresh",
      loadout: {
        permissions: { deny: ["Bash(rm -rf:*)"] },
        capabilities: ["editor"],
      },
      fullAutonomous: true,
    };
    await handleDispatchSpawnAgent(params, deps);

    expect(am.spawnFn).toHaveBeenCalledOnce();
    const spawnArgs = am.spawnFn.mock.calls[0][0];
    expect(spawnArgs.role).toBe("coordinator");
    expect(spawnArgs.cwd).toBe("/tmp/work");
    expect(spawnArgs.parent).toBeNull();
    expect(spawnArgs.isolatedSettings).toBe(true);
    expect(spawnArgs.permissions).toEqual({
      allow: [],
      deny: ["Bash(rm -rf:*)"],
      ask: [],
    });
    expect(spawnArgs.fullAutonomous).toBe(true);
    expect(spawnArgs.capabilities).toEqual(["editor"]);
  });

  it("forwards params.cwd when present", async () => {
    const deps = makeDeps(am);
    const params: SpawnAgentRequest = {
      role: "coordinator",
      cwd: "/tmp/abc",
    };
    await handleDispatchSpawnAgent(params, deps);
    const args = am.spawnFn.mock.calls[0][0];
    expect(args.cwd).toBe("/tmp/abc");
  });

  it("omits cwd from spawn options when absent", async () => {
    const deps = makeDeps(am);
    const params = { role: "coordinator" } as SpawnAgentRequest;
    await handleDispatchSpawnAgent(params, deps);
    const args = am.spawnFn.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(args, "cwd")).toBe(false);
  });

  it("returns { agentId } from the spawned result", async () => {
    am = makeAgentManager("custom-agent-id-42");
    const deps = makeDeps(am);
    const result = await handleDispatchSpawnAgent(
      { role: "worker", cwd: "/tmp/x" },
      deps,
    );
    expect(result).toEqual({ agentId: "custom-agent-id-42" });
  });

  // ── ACP-registration barrier ─────────────────────────────────

  it("calls waitForAcpRegistration(agentId, 5000) when provided", async () => {
    const waitForAcpRegistration = vi.fn().mockResolvedValue(true);
    const deps = makeDeps(am, { waitForAcpRegistration });
    await handleDispatchSpawnAgent(
      { role: "coordinator", cwd: "/tmp/x" },
      deps,
    );
    expect(waitForAcpRegistration).toHaveBeenCalledOnce();
    expect(waitForAcpRegistration).toHaveBeenCalledWith("agent-spawn-1", 5_000);
  });

  it("tolerates waitForAcpRegistration timeout (logs warning, still returns agentId)", async () => {
    const waitForAcpRegistration = vi.fn().mockResolvedValue(false);
    const deps = makeDeps(am, { waitForAcpRegistration });
    const result = await handleDispatchSpawnAgent(
      { role: "coordinator", cwd: "/tmp/x" },
      deps,
    );
    expect(result).toEqual({ agentId: "agent-spawn-1" });
    expect(deps.logs.some((l) => l.includes("Warning: ACP registration not confirmed"))).toBe(
      true,
    );
  });

  it("calls waitForAcpRegistration even if it rejects (caught, no propagation)", async () => {
    const waitForAcpRegistration = vi
      .fn()
      .mockRejectedValue(new Error("registration timeout"));
    const deps = makeDeps(am, { waitForAcpRegistration });
    const result = await handleDispatchSpawnAgent(
      { role: "coordinator", cwd: "/tmp/x" },
      deps,
    );
    expect(result).toEqual({ agentId: "agent-spawn-1" });
    expect(waitForAcpRegistration).toHaveBeenCalledOnce();
    // The rejection is treated as a non-confirmation → warning logged.
    expect(deps.logs.some((l) => l.includes("Warning: ACP registration not confirmed"))).toBe(
      true,
    );
  });

  it("does not call waitForAcpRegistration when not provided", async () => {
    const deps = makeDeps(am); // no waitForAcpRegistration
    const result = await handleDispatchSpawnAgent(
      { role: "coordinator", cwd: "/tmp/x" },
      deps,
    );
    expect(result).toEqual({ agentId: "agent-spawn-1" });
    // Just ensure we don't crash; nothing else to assert.
  });

  // ── fullAutonomous default ───────────────────────────────────

  it("defaults fullAutonomous to true when params.fullAutonomous is omitted", async () => {
    const deps = makeDeps(am);
    const params: SpawnAgentRequest = {
      role: "coordinator",
      cwd: "/tmp/x",
      loadout: { permissions: { ask: ["Write(*.env)"] } },
    };
    await handleDispatchSpawnAgent(params, deps);

    const args = am.spawnFn.mock.calls[0][0];
    expect(args.fullAutonomous).toBe(true);
    expect(args.permissions).toEqual({
      allow: [],
      deny: [],
      ask: ["Write(*.env)"],
    });
  });

  it("respects explicit fullAutonomous: false from params", async () => {
    const deps = makeDeps(am);
    const params: SpawnAgentRequest = {
      role: "coordinator",
      cwd: "/tmp/x",
      loadout: { permissions: { ask: ["Write(*.env)"] } },
      fullAutonomous: false,
    };
    await handleDispatchSpawnAgent(params, deps);

    const args = am.spawnFn.mock.calls[0][0];
    expect(args.fullAutonomous).toBe(false);
  });

  // ── Task placeholder ─────────────────────────────────────────

  it("uses params.task when provided", async () => {
    const deps = makeDeps(am);
    const params: SpawnAgentRequest = {
      role: "coordinator",
      cwd: "/tmp/x",
      task: "Implement the widget",
    };
    await handleDispatchSpawnAgent(params, deps);
    const args = am.spawnFn.mock.calls[0][0];
    expect(args.task).toBe("Implement the widget");
  });

  it("applies the default task placeholder when params.task is omitted", async () => {
    const deps = makeDeps(am);
    const params: SpawnAgentRequest = { role: "coordinator", cwd: "/tmp/x" };
    await handleDispatchSpawnAgent(params, deps);
    const args = am.spawnFn.mock.calls[0][0];
    expect(args.task).toBe("Awaiting dispatch (created by dispatch/spawn-agent)");
  });

  // ── isolatedSettings ─────────────────────────────────────────

  it("always passes isolatedSettings: true to spawn", async () => {
    const deps = makeDeps(am);
    await handleDispatchSpawnAgent(
      { role: "coordinator", cwd: "/tmp/x" },
      deps,
    );
    const args = am.spawnFn.mock.calls[0][0];
    expect(args.isolatedSettings).toBe(true);
  });
});

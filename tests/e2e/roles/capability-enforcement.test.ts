/**
 * Role Capability Enforcement Tests
 *
 * Tests that role capabilities are properly enforced - agents can only perform
 * actions allowed by their role.
 *
 * @see s-60tc Specialized Agent Roles
 * @see i-8dt7 Test: Role Capability Enforcement
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  DefaultRoleRegistry,
  filterToolsForRole,
} from "../../../src/roles/registry.js";
import {
  AGENT_CAPABILITIES,
  CAPABILITY_TOOL_MAP,
  getToolsForCapabilities,
} from "../../../src/roles/capabilities.js";
import { getBuiltinRole } from "../../../src/roles/builtin/index.js";
import type { RoleDefinition, Tool } from "../../../src/roles/types.js";

import {
  createTestHarness,
  type TestHarness,
} from "../../harness/index.js";
import { MINIMAL_PROJECT } from "../../fixtures/index.js";

describe("Role Capability Enforcement", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Role Registry Capabilities
  // ─────────────────────────────────────────────────────────────────────────

  describe("Role Registry - Capability Definitions", () => {
    let registry: DefaultRoleRegistry;

    beforeEach(() => {
      registry = new DefaultRoleRegistry();
    });

    describe("Worker Role Capabilities", () => {
      it("ROLE-CAP-01: Worker has agent.spawn.worker capability", () => {
        const hasCapability = registry.hasCapability(
          "worker",
          AGENT_CAPABILITIES.SPAWN_WORKER
        );
        expect(hasCapability).toBe(true);
      });

      it("ROLE-CAP-02: Worker does NOT have agent.spawn.integrator capability", () => {
        const hasCapability = registry.hasCapability(
          "worker",
          AGENT_CAPABILITIES.SPAWN_INTEGRATOR
        );
        expect(hasCapability).toBe(false);
      });

      it("ROLE-CAP-03: Worker does NOT have agent.spawn.monitor capability", () => {
        const hasCapability = registry.hasCapability(
          "worker",
          AGENT_CAPABILITIES.SPAWN_MONITOR
        );
        expect(hasCapability).toBe(false);
      });

      it("ROLE-CAP-04: Worker does NOT have agent.spawn.custom capability", () => {
        const hasCapability = registry.hasCapability(
          "worker",
          AGENT_CAPABILITIES.SPAWN_CUSTOM
        );
        expect(hasCapability).toBe(false);
      });

      it("ROLE-CAP-05: Worker does NOT have agent.terminate capability", () => {
        const hasCapability = registry.hasCapability(
          "worker",
          AGENT_CAPABILITIES.TERMINATE
        );
        expect(hasCapability).toBe(false);
      });
    });

    describe("Coordinator Role Capabilities", () => {
      it("ROLE-CAP-06: Coordinator has agent.spawn.worker capability", () => {
        const hasCapability = registry.hasCapability(
          "coordinator",
          AGENT_CAPABILITIES.SPAWN_WORKER
        );
        expect(hasCapability).toBe(true);
      });

      it("ROLE-CAP-07: Coordinator has agent.spawn.integrator capability", () => {
        const hasCapability = registry.hasCapability(
          "coordinator",
          AGENT_CAPABILITIES.SPAWN_INTEGRATOR
        );
        expect(hasCapability).toBe(true);
      });

      it("ROLE-CAP-08: Coordinator has agent.spawn.monitor capability", () => {
        const hasCapability = registry.hasCapability(
          "coordinator",
          AGENT_CAPABILITIES.SPAWN_MONITOR
        );
        expect(hasCapability).toBe(true);
      });

      it("ROLE-CAP-09: Coordinator has agent.terminate capability", () => {
        const hasCapability = registry.hasCapability(
          "coordinator",
          AGENT_CAPABILITIES.TERMINATE
        );
        expect(hasCapability).toBe(true);
      });
    });

    describe("Integrator Role Capabilities", () => {
      it("ROLE-CAP-10: Integrator has agent.spawn.worker capability (for resolvers)", () => {
        const hasCapability = registry.hasCapability(
          "integrator",
          AGENT_CAPABILITIES.SPAWN_WORKER
        );
        expect(hasCapability).toBe(true);
      });

      it("ROLE-CAP-11: Integrator does NOT have agent.spawn.integrator capability", () => {
        const hasCapability = registry.hasCapability(
          "integrator",
          AGENT_CAPABILITIES.SPAWN_INTEGRATOR
        );
        expect(hasCapability).toBe(false);
      });

      it("ROLE-CAP-12: Integrator does NOT have agent.spawn.monitor capability", () => {
        const hasCapability = registry.hasCapability(
          "integrator",
          AGENT_CAPABILITIES.SPAWN_MONITOR
        );
        expect(hasCapability).toBe(false);
      });
    });

    describe("Monitor Role Capabilities", () => {
      it("ROLE-CAP-13: Monitor does NOT have any agent.spawn.* capabilities", () => {
        const hasSpawnWorker = registry.hasCapability(
          "monitor",
          AGENT_CAPABILITIES.SPAWN_WORKER
        );
        const hasSpawnIntegrator = registry.hasCapability(
          "monitor",
          AGENT_CAPABILITIES.SPAWN_INTEGRATOR
        );
        const hasSpawnMonitor = registry.hasCapability(
          "monitor",
          AGENT_CAPABILITIES.SPAWN_MONITOR
        );

        expect(hasSpawnWorker).toBe(false);
        expect(hasSpawnIntegrator).toBe(false);
        expect(hasSpawnMonitor).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Tool Filtering by Capability
  // ─────────────────────────────────────────────────────────────────────────

  describe("Tool Filtering by Capability", () => {
    const mockTools: Tool[] = [
      { name: "read", description: "Read files" },
      { name: "write", description: "Write files" },
      { name: "edit", description: "Edit files" },
      { name: "bash", description: "Run bash commands" },
      { name: "spawn", description: "Spawn agents" },
      { name: "done", description: "Signal completion" },
      { name: "terminate", description: "Terminate agents" },
      { name: "glob", description: "Glob files" },
      { name: "grep", description: "Search files" },
    ];

    it("ROLE-TOOL-01: Worker role gets spawn tool (for spawning workers)", () => {
      const workerRole = getBuiltinRole("worker")!;
      const filteredTools = filterToolsForRole(mockTools, workerRole);

      const hasSpawn = filteredTools.some((t) => t.name === "spawn");
      expect(hasSpawn).toBe(true);
    });

    it("ROLE-TOOL-02: Worker role gets done tool", () => {
      const workerRole = getBuiltinRole("worker")!;
      const filteredTools = filterToolsForRole(mockTools, workerRole);

      const hasDone = filteredTools.some((t) => t.name === "done");
      expect(hasDone).toBe(true);
    });

    it("ROLE-TOOL-03: Worker role does NOT get terminate tool", () => {
      const workerRole = getBuiltinRole("worker")!;
      const filteredTools = filterToolsForRole(mockTools, workerRole);

      const hasTerminate = filteredTools.some((t) => t.name === "terminate");
      expect(hasTerminate).toBe(false);
    });

    it("ROLE-TOOL-04: Coordinator role gets spawn tool", () => {
      const coordRole = getBuiltinRole("coordinator")!;
      const filteredTools = filterToolsForRole(mockTools, coordRole);

      const hasSpawn = filteredTools.some((t) => t.name === "spawn");
      expect(hasSpawn).toBe(true);
    });

    it("ROLE-TOOL-05: Coordinator role gets terminate tool", () => {
      const coordRole = getBuiltinRole("coordinator")!;
      const filteredTools = filterToolsForRole(mockTools, coordRole);

      const hasTerminate = filteredTools.some((t) => t.name === "terminate");
      expect(hasTerminate).toBe(true);
    });

    it("ROLE-TOOL-06: Monitor role does NOT get write tool", () => {
      const monitorRole = getBuiltinRole("monitor")!;
      const filteredTools = filterToolsForRole(mockTools, monitorRole);

      const hasWrite = filteredTools.some((t) => t.name === "write");
      expect(hasWrite).toBe(false);
    });

    it("ROLE-TOOL-07: Monitor role does NOT get edit tool", () => {
      const monitorRole = getBuiltinRole("monitor")!;
      const filteredTools = filterToolsForRole(mockTools, monitorRole);

      const hasEdit = filteredTools.some((t) => t.name === "edit");
      expect(hasEdit).toBe(false);
    });

    it("ROLE-TOOL-08: Monitor role gets read tool", () => {
      const monitorRole = getBuiltinRole("monitor")!;
      const filteredTools = filterToolsForRole(mockTools, monitorRole);

      const hasRead = filteredTools.some((t) => t.name === "read");
      expect(hasRead).toBe(true);
    });

    it("ROLE-TOOL-09: Monitor role does NOT get spawn tool", () => {
      const monitorRole = getBuiltinRole("monitor")!;
      const filteredTools = filterToolsForRole(mockTools, monitorRole);

      const hasSpawn = filteredTools.some((t) => t.name === "spawn");
      expect(hasSpawn).toBe(false);
    });

    it("ROLE-TOOL-10: Generic role with wildcard gets all tools", () => {
      const genericRole = getBuiltinRole("generic")!;
      const filteredTools = filterToolsForRole(mockTools, genericRole);

      expect(filteredTools.length).toBe(mockTools.length);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Capability to Tool Mapping
  // ─────────────────────────────────────────────────────────────────────────

  describe("Capability to Tool Mapping", () => {
    it("agent.spawn.worker maps to spawn tool", () => {
      const tools = CAPABILITY_TOOL_MAP[AGENT_CAPABILITIES.SPAWN_WORKER];
      expect(tools).toContain("spawn");
    });

    it("agent.spawn.integrator maps to spawn tool", () => {
      const tools = CAPABILITY_TOOL_MAP[AGENT_CAPABILITIES.SPAWN_INTEGRATOR];
      expect(tools).toContain("spawn");
    });

    it("agent.terminate maps to terminate tool", () => {
      const tools = CAPABILITY_TOOL_MAP[AGENT_CAPABILITIES.TERMINATE];
      expect(tools).toContain("terminate");
    });

    it("getToolsForCapabilities returns spawn for spawn capabilities", () => {
      const capabilities = [
        AGENT_CAPABILITIES.SPAWN_WORKER,
        AGENT_CAPABILITIES.SPAWN_INTEGRATOR,
      ];
      const tools = getToolsForCapabilities(capabilities, [
        "spawn",
        "read",
        "write",
      ]);

      expect(tools).toContain("spawn");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integration Tests: Spawn Capability Enforcement
  // ─────────────────────────────────────────────────────────────────────────

  describe("Spawn Capability Enforcement (Integration)", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: MINIMAL_PROJECT });
    });

    afterEach(async () => {
      if (harness) {
        await harness.cleanup();
      }
    });

    it("ROLE-CAP-INT-01: Worker spawning worker child succeeds", async () => {
      // Worker has agent.spawn.worker capability
      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Worker spawning child worker" },
            {
              type: "spawn_child",
              role: "worker",
              behavior: {
                onStart: [
                  { type: "log", message: "Child worker started" },
                  { type: "done", status: "completed" },
                ],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });

      // Verify child was spawned
      const context = worker.getContext();
      expect(context.children.length).toBe(1);
    });

    it("ROLE-CAP-INT-02: Coordinator spawning worker succeeds", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator spawning worker" },
            {
              type: "spawn_child",
              role: "worker",
              behavior: {
                onStart: [
                  { type: "log", message: "Spawned worker" },
                  { type: "done", status: "completed" },
                ],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 100 });

      const context = coordinator.getContext();
      expect(context.children.length).toBe(1);
    });

    it("ROLE-CAP-INT-03: Coordinator spawning integrator succeeds", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator spawning integrator" },
            {
              type: "spawn_child",
              role: "integrator",
              behavior: {
                onStart: [
                  { type: "log", message: "Integrator started" },
                  { type: "done", status: "completed" },
                ],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 100 });

      const context = coordinator.getContext();
      expect(context.children.length).toBe(1);
      expect(context.children[0].role).toBe("integrator");
    });

    it("ROLE-CAP-INT-04: Coordinator spawning monitor succeeds", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator spawning monitor" },
            {
              type: "spawn_child",
              role: "monitor",
              behavior: {
                onStart: [
                  { type: "log", message: "Monitor started" },
                  { type: "done", status: "completed" },
                ],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 100 });

      const context = coordinator.getContext();
      expect(context.children.length).toBe(1);
      expect(context.children[0].role).toBe("monitor");
    });

    it("ROLE-CAP-INT-05: Integrator spawning resolver worker succeeds", async () => {
      const integrator = await harness.spawnSimulator({
        role: "integrator",
        behavior: {
          onStart: [
            { type: "log", message: "Integrator spawning resolver" },
            {
              type: "spawn_child",
              role: "worker.resolver",
              behavior: {
                onStart: [
                  { type: "log", message: "Resolver started" },
                  { type: "done", status: "completed" },
                ],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(integrator.agentId, { maxIterations: 100 });

      const context = integrator.getContext();
      expect(context.children.length).toBe(1);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ENFORCEMENT GAP TESTS - These tests document expected enforcement
    // that may not yet be implemented in the runtime.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * NOTE: The following tests verify that capability enforcement EXISTS.
     * If these tests fail, it indicates that the runtime is NOT enforcing
     * spawn capabilities - which is a bug to be fixed.
     *
     * Current expectation: These may fail because enforcement isn't implemented.
     * Target state: These should pass once enforcement is added to the spawn flow.
     */

    it("ROLE-CAP-ENF-01: Worker spawning integrator should FAIL", async () => {
      // Worker does NOT have agent.spawn.integrator capability
      // This spawn should be rejected

      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Worker attempting to spawn integrator" },
            {
              type: "spawn_child",
              role: "integrator",
              behavior: {
                onStart: [{ type: "done", status: "completed" }],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.runUntilIdle();

      // Spawn should have failed - no children
      const context = worker.getContext();
      expect(context.children.length).toBe(0);

      // Or the spawn step should have failed status
      const log = worker.getExecutionLog();
      const spawnStep = log.find((e) => e.step.type === "spawn_child");
      if (spawnStep) {
        expect(spawnStep.result.status).toBe("failed");
        expect(spawnStep.result.error?.message).toContain("capability");
      }
    });

    it("ROLE-CAP-ENF-02: Worker spawning monitor should FAIL", async () => {
      // Worker does NOT have agent.spawn.monitor capability

      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            {
              type: "spawn_child",
              role: "monitor",
              behavior: {
                onStart: [{ type: "done", status: "completed" }],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.runUntilIdle();

      const context = worker.getContext();
      expect(context.children.length).toBe(0);
    });

    it("ROLE-CAP-ENF-03: Monitor spawning any agent should FAIL", async () => {
      // Monitor does NOT have any agent.spawn.* capabilities

      const monitor = await harness.spawnSimulator({
        role: "monitor",
        behavior: {
          onStart: [
            {
              type: "spawn_child",
              role: "worker",
              behavior: {
                onStart: [{ type: "done", status: "completed" }],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.runUntilIdle();

      const context = monitor.getContext();
      expect(context.children.length).toBe(0);
    });

    it("ROLE-CAP-ENF-04: Integrator spawning integrator should FAIL", async () => {
      // Integrator does NOT have agent.spawn.integrator capability

      const integrator = await harness.spawnSimulator({
        role: "integrator",
        behavior: {
          onStart: [
            {
              type: "spawn_child",
              role: "integrator",
              behavior: {
                onStart: [{ type: "done", status: "completed" }],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.runUntilIdle();

      const context = integrator.getContext();
      expect(context.children.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    it("Unknown role falls back to generic (which has all capabilities)", () => {
      const registry = new DefaultRoleRegistry();
      const role = registry.resolveRole("unknown-role");

      expect(role.name).toBe("generic");
      expect(role.capabilities).toContain("*");
    });

    it("Resolver worker inherits worker capabilities", () => {
      const registry = new DefaultRoleRegistry();

      const hasSpawnWorker = registry.hasCapability(
        "worker.resolver",
        AGENT_CAPABILITIES.SPAWN_WORKER
      );
      expect(hasSpawnWorker).toBe(true);

      const hasSpawnIntegrator = registry.hasCapability(
        "worker.resolver",
        AGENT_CAPABILITIES.SPAWN_INTEGRATOR
      );
      expect(hasSpawnIntegrator).toBe(false);
    });
  });
});

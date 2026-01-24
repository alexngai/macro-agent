/**
 * Role Resolution and Fallback Tests
 *
 * Tests that role resolution works correctly, including fallback behavior
 * for invalid/unknown roles.
 *
 * @see s-60tc Specialized Agent Roles
 * @see i-4kj8 Test: Role Resolution and Fallback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  DefaultRoleRegistry,
  validateRole,
  mergeRoles,
} from "../registry.js";
import {
  getBuiltinRole,
  BUILTIN_ROLES,
} from "../builtin/index.js";
import type { RoleDefinition, RoleConfig } from "../types.js";
import {
  FILE_CAPABILITIES,
  LIFECYCLE_CAPABILITIES,
  AGENT_CAPABILITIES,
} from "../capabilities.js";

import {
  createTestHarness,
  type TestHarness,
} from "../../../test_fixtures/harness/index.js";
import { MINIMAL_PROJECT } from "../../../test_fixtures/fixtures/index.js";

describe("Role Resolution and Fallback", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Built-in Role Lookup
  // ─────────────────────────────────────────────────────────────────────────

  describe("Built-in Role Lookup", () => {
    it("ROLE-RES-01: getBuiltinRole returns worker role", () => {
      const role = getBuiltinRole("worker");
      expect(role).toBeDefined();
      expect(role!.name).toBe("worker");
    });

    it("ROLE-RES-02: getBuiltinRole returns coordinator role", () => {
      const role = getBuiltinRole("coordinator");
      expect(role).toBeDefined();
      expect(role!.name).toBe("coordinator");
    });

    it("ROLE-RES-03: getBuiltinRole returns integrator role", () => {
      const role = getBuiltinRole("integrator");
      expect(role).toBeDefined();
      expect(role!.name).toBe("integrator");
    });

    it("ROLE-RES-04: getBuiltinRole returns monitor role", () => {
      const role = getBuiltinRole("monitor");
      expect(role).toBeDefined();
      expect(role!.name).toBe("monitor");
    });

    it("ROLE-RES-05: getBuiltinRole returns generic role", () => {
      const role = getBuiltinRole("generic");
      expect(role).toBeDefined();
      expect(role!.name).toBe("generic");
    });

    it("ROLE-RES-06: getBuiltinRole returns worker.resolver role", () => {
      const role = getBuiltinRole("worker.resolver");
      expect(role).toBeDefined();
      expect(role!.name).toBe("worker.resolver");
    });

    it("ROLE-RES-07: getBuiltinRole returns undefined for unknown role", () => {
      const role = getBuiltinRole("nonexistent");
      expect(role).toBeUndefined();
    });

    it("ROLE-RES-08: BUILTIN_ROLES map contains all core roles", () => {
      expect(BUILTIN_ROLES.has("worker")).toBe(true);
      expect(BUILTIN_ROLES.has("coordinator")).toBe(true);
      expect(BUILTIN_ROLES.has("integrator")).toBe(true);
      expect(BUILTIN_ROLES.has("monitor")).toBe(true);
      expect(BUILTIN_ROLES.has("generic")).toBe(true);
      expect(BUILTIN_ROLES.has("worker.resolver")).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Registry Resolution
  // ─────────────────────────────────────────────────────────────────────────

  describe("Registry Resolution", () => {
    let registry: DefaultRoleRegistry;

    beforeEach(() => {
      registry = new DefaultRoleRegistry();
    });

    it("ROLE-RES-09: resolveRole returns built-in role", () => {
      const role = registry.resolveRole("worker");
      expect(role.name).toBe("worker");
      expect(role.capabilities).toContain("file.read");
    });

    it("ROLE-RES-10: resolveRole falls back to generic for unknown role", () => {
      // Suppress console warnings in test
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const role = registry.resolveRole("unknown-role-xyz");
      expect(role.name).toBe("generic");
      expect(role.capabilities).toContain("*");

      warnSpy.mockRestore();
    });

    it("ROLE-RES-11: getRole returns undefined for unregistered role", () => {
      const role = registry.getRole("unregistered");
      expect(role).toBeUndefined();
    });

    it("ROLE-RES-12: registerRole adds custom role", () => {
      const customRole: RoleDefinition = {
        name: "custom-worker",
        displayName: "Custom Worker",
        description: "A custom worker role",
        capabilities: [
          FILE_CAPABILITIES.READ,
          FILE_CAPABILITIES.WRITE,
          LIFECYCLE_CAPABILITIES.DONE,
        ],
      };

      registry.registerRole(customRole);

      const retrieved = registry.getRole("custom-worker");
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe("custom-worker");
      expect(retrieved!.capabilities).toContain("file.read");
    });

    it("ROLE-RES-13: custom role takes precedence over built-in", () => {
      const customWorker: RoleDefinition = {
        name: "worker",
        displayName: "Custom Worker Override",
        description: "Overridden worker",
        capabilities: [FILE_CAPABILITIES.READ], // Reduced capabilities
      };

      registry.registerRole(customWorker);

      const role = registry.getRole("worker");
      expect(role!.displayName).toBe("Custom Worker Override");
      expect(role!.capabilities).toEqual([FILE_CAPABILITIES.READ]);
    });

    it("ROLE-RES-14: listRoles returns all roles", () => {
      const roles = registry.listRoles();

      const roleNames = roles.map((r) => r.name);
      expect(roleNames).toContain("worker");
      expect(roleNames).toContain("coordinator");
      expect(roleNames).toContain("integrator");
      expect(roleNames).toContain("monitor");
      expect(roleNames).toContain("generic");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Role Validation
  // ─────────────────────────────────────────────────────────────────────────

  describe("Role Validation", () => {
    it("ROLE-VAL-01: valid role passes validation", () => {
      const role: RoleDefinition = {
        name: "test-role",
        displayName: "Test Role",
        description: "A test role",
        capabilities: [FILE_CAPABILITIES.READ, LIFECYCLE_CAPABILITIES.DONE],
      };

      const result = validateRole(role);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("ROLE-VAL-02: role without name fails validation", () => {
      const role = {
        displayName: "No Name",
        capabilities: [FILE_CAPABILITIES.READ],
      } as unknown as RoleDefinition;

      const result = validateRole(role);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.field === "name")).toBe(true);
    });

    it("ROLE-VAL-03: role without capabilities fails validation", () => {
      const role = {
        name: "no-caps",
        displayName: "No Capabilities",
      } as unknown as RoleDefinition;

      const result = validateRole(role);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.field === "capabilities")).toBe(true);
    });

    it("ROLE-VAL-04: role with empty capabilities fails validation", () => {
      const role: RoleDefinition = {
        name: "empty-caps",
        displayName: "Empty Capabilities",
        description: "Role with empty capabilities",
        capabilities: [],
      };

      const result = validateRole(role);
      expect(result.isValid).toBe(false);
    });

    it("ROLE-VAL-05: unknown capability generates warning", () => {
      const role: RoleDefinition = {
        name: "unknown-cap-role",
        displayName: "Unknown Cap",
        description: "Has unknown capability",
        capabilities: ["unknown.capability" as never],
      };

      const result = validateRole(role);
      expect(result.isValid).toBe(true); // Still valid, just warning
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(
        result.warnings.some((w) => w.message.includes("Unknown capability"))
      ).toBe(true);
    });

    it("ROLE-VAL-06: ephemeral role without done capability generates warning", () => {
      const role: RoleDefinition = {
        name: "ephemeral-no-done",
        displayName: "Ephemeral No Done",
        description: "Ephemeral without done",
        capabilities: [FILE_CAPABILITIES.READ],
        lifecycle: {
          type: "ephemeral",
        },
      };

      const result = validateRole(role);
      expect(result.isValid).toBe(true);
      expect(
        result.warnings.some((w) => w.message.includes("lifecycle.done"))
      ).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Role Merging
  // ─────────────────────────────────────────────────────────────────────────

  describe("Role Merging", () => {
    it("ROLE-MERGE-01: child capabilities override parent", () => {
      const parent: RoleDefinition = {
        name: "parent",
        displayName: "Parent",
        description: "Parent role",
        capabilities: [FILE_CAPABILITIES.READ, FILE_CAPABILITIES.WRITE],
      };

      const child: RoleConfig = {
        name: "child",
        capabilities: [FILE_CAPABILITIES.READ], // Only read
      };

      const merged = mergeRoles(parent, child);
      expect(merged.capabilities).toEqual([FILE_CAPABILITIES.READ]);
    });

    it("ROLE-MERGE-02: child inherits parent capabilities when not specified", () => {
      const parent: RoleDefinition = {
        name: "parent",
        displayName: "Parent",
        description: "Parent role",
        capabilities: [FILE_CAPABILITIES.READ, FILE_CAPABILITIES.WRITE],
      };

      const child: RoleConfig = {
        name: "child",
        displayName: "Child Override",
        // No capabilities specified
      };

      const merged = mergeRoles(parent, child);
      expect(merged.capabilities).toEqual([
        FILE_CAPABILITIES.READ,
        FILE_CAPABILITIES.WRITE,
      ]);
      expect(merged.displayName).toBe("Child Override");
    });

    it("ROLE-MERGE-03: child workspace overrides parent workspace", () => {
      const parent: RoleDefinition = {
        name: "parent",
        displayName: "Parent",
        description: "Parent role",
        capabilities: [FILE_CAPABILITIES.READ],
        workspace: {
          type: "own",
          branchPattern: "parent/{id}",
        },
      };

      const child: RoleConfig = {
        name: "child",
        workspace: {
          type: "shared",
        },
      };

      const merged = mergeRoles(parent, child);
      expect(merged.workspace?.type).toBe("shared");
    });

    it("ROLE-MERGE-04: child lifecycle overrides parent lifecycle", () => {
      const parent: RoleDefinition = {
        name: "parent",
        displayName: "Parent",
        description: "Parent role",
        capabilities: [FILE_CAPABILITIES.READ, LIFECYCLE_CAPABILITIES.DONE],
        lifecycle: {
          type: "ephemeral",
          maxDurationMs: 30000,
        },
      };

      const child: RoleConfig = {
        name: "child",
        lifecycle: {
          type: "persistent",
        },
      };

      const merged = mergeRoles(parent, child);
      expect(merged.lifecycle?.type).toBe("persistent");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Project and User Level Overrides
  // ─────────────────────────────────────────────────────────────────────────

  describe("Override Layers", () => {
    let registry: DefaultRoleRegistry;

    beforeEach(() => {
      registry = new DefaultRoleRegistry();
    });

    it("ROLE-OVR-01: project role overrides built-in", () => {
      const projectWorker: RoleConfig = {
        name: "worker",
        displayName: "Project Worker",
        override: "merge",
        lifecycle: {
          type: "ephemeral",
          maxDurationMs: 60000, // 1 minute instead of 30
        },
      };

      registry.registerProjectRole(projectWorker);

      const role = registry.resolveRole("worker");
      expect(role.lifecycle?.maxDurationMs).toBe(60000);
    });

    it("ROLE-OVR-02: user role is overridden by project role", () => {
      const userWorker: RoleConfig = {
        name: "worker",
        displayName: "User Worker",
        override: "merge",
      };

      const projectWorker: RoleConfig = {
        name: "worker",
        displayName: "Project Worker",
        override: "merge",
      };

      registry.registerUserRole(userWorker);
      registry.registerProjectRole(projectWorker);

      const role = registry.resolveRole("worker");
      expect(role.displayName).toBe("Project Worker");
    });

    it("ROLE-OVR-03: custom role overrides all layers", () => {
      const userWorker: RoleConfig = {
        name: "worker",
        displayName: "User Worker",
      };

      const projectWorker: RoleConfig = {
        name: "worker",
        displayName: "Project Worker",
      };

      const customWorker: RoleDefinition = {
        name: "worker",
        displayName: "Custom Worker",
        description: "Fully custom",
        capabilities: [FILE_CAPABILITIES.READ],
      };

      registry.registerUserRole(userWorker);
      registry.registerProjectRole(projectWorker);
      registry.registerRole(customWorker);

      // getRole returns custom role directly
      const role = registry.getRole("worker");
      expect(role?.displayName).toBe("Custom Worker");
    });

    it("ROLE-OVR-04: extends creates new role from parent", () => {
      const customRole: RoleConfig = {
        name: "super-worker",
        displayName: "Super Worker",
        extends: "worker",
        capabilities: [
          FILE_CAPABILITIES.READ,
          FILE_CAPABILITIES.WRITE,
          FILE_CAPABILITIES.DELETE,
          LIFECYCLE_CAPABILITIES.DONE,
          AGENT_CAPABILITIES.SPAWN_WORKER,
          AGENT_CAPABILITIES.SPAWN_INTEGRATOR, // Extra capability
        ],
      };

      registry.registerProjectRole(customRole);

      const role = registry.resolveRole("super-worker");
      expect(role.name).toBe("super-worker");
      expect(role.capabilities).toContain(AGENT_CAPABILITIES.SPAWN_INTEGRATOR);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integration Tests: Role Resolution in Simulator
  // ─────────────────────────────────────────────────────────────────────────

  describe("Role Resolution in Simulator (Integration)", () => {
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

    it("ROLE-RES-INT-01: Simulator with worker role has correct role set", async () => {
      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      expect(worker.role).toBe("worker");
    });

    it("ROLE-RES-INT-02: Simulator with coordinator role has correct role set", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      expect(coordinator.role).toBe("coordinator");
    });

    it("ROLE-RES-INT-03: Simulator with monitor role has correct role set", async () => {
      const monitor = await harness.spawnSimulator({
        role: "monitor",
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      expect(monitor.role).toBe("monitor");
    });

    it("ROLE-RES-INT-04: Child inherits appropriate role", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
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

      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 100 });

      const context = coordinator.getContext();
      expect(context.children.length).toBe(1);
      expect(context.children[0].role).toBe("worker");
    });

    it("ROLE-RES-INT-05: Role is undefined when not specified", async () => {
      const agent = await harness.spawnSimulator({
        // No role specified
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      // Currently role is undefined when not specified
      // TODO: Consider whether default should be "worker" per s-60tc
      expect(agent.role).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    it("registerRole throws on missing name", () => {
      const registry = new DefaultRoleRegistry();
      const invalidRole = {
        displayName: "No Name",
        capabilities: [FILE_CAPABILITIES.READ],
      } as unknown as RoleDefinition;

      expect(() => registry.registerRole(invalidRole)).toThrow(
        "Role name is required"
      );
    });

    it("registerProjectRole throws on missing name", () => {
      const registry = new DefaultRoleRegistry();
      const invalidRole = {
        displayName: "No Name",
      } as unknown as RoleConfig;

      expect(() => registry.registerProjectRole(invalidRole)).toThrow(
        "Role name is required"
      );
    });

    it("registerUserRole throws on missing name", () => {
      const registry = new DefaultRoleRegistry();
      const invalidRole = {
        displayName: "No Name",
      } as unknown as RoleConfig;

      expect(() => registry.registerUserRole(invalidRole)).toThrow(
        "Role name is required"
      );
    });
  });
});

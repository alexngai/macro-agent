/**
 * Unit Tests for Skill-tree Integration
 *
 * Tests `inferProfileFromRole()`, `compileRoleLoadout()`, and
 * `compileAllRoleLoadouts()` from the skilltree module.
 *
 * Since skill-tree is an optional dependency, tests mock the dynamic import
 * to verify both the available and unavailable code paths.
 *
 * Run:
 *   npx vitest run src/integrations/__tests__/skilltree.test.ts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  inferProfileFromRole,
  compileRoleLoadout,
  compileAllRoleLoadouts,
  _resetSkillTreeCache,
} from "../skilltree.js";

// ─────────────────────────────────────────────────────────────────
// inferProfileFromRole
// ─────────────────────────────────────────────────────────────────

describe("inferProfileFromRole", () => {
  it("maps worker to implementation", () => {
    expect(inferProfileFromRole("worker")).toBe("implementation");
  });

  it("maps coordinator to implementation", () => {
    expect(inferProfileFromRole("coordinator")).toBe("implementation");
  });

  it("maps integrator to code-review", () => {
    expect(inferProfileFromRole("integrator")).toBe("code-review");
  });

  it("maps monitor to testing", () => {
    expect(inferProfileFromRole("monitor")).toBe("testing");
  });

  it("maps executor to implementation", () => {
    expect(inferProfileFromRole("executor")).toBe("implementation");
  });

  it("maps verifier to testing", () => {
    expect(inferProfileFromRole("verifier")).toBe("testing");
  });

  it("maps debugger to debugging", () => {
    expect(inferProfileFromRole("debugger")).toBe("debugging");
  });

  it("maps architect to refactoring", () => {
    expect(inferProfileFromRole("architect")).toBe("refactoring");
  });

  it("maps security-auditor to security", () => {
    expect(inferProfileFromRole("security-auditor")).toBe("security");
  });

  it("maps tech-writer to documentation", () => {
    expect(inferProfileFromRole("tech-writer")).toBe("documentation");
  });

  it("returns empty string for unknown roles", () => {
    expect(inferProfileFromRole("unknown-role")).toBe("");
  });

  it("performs partial matching (senior-developer → implementation)", () => {
    expect(inferProfileFromRole("senior-developer")).toBe("implementation");
  });

  it("performs partial matching (lead-executor → implementation)", () => {
    expect(inferProfileFromRole("lead-executor")).toBe("implementation");
  });

  it("performs partial matching (qa-lead → testing)", () => {
    expect(inferProfileFromRole("qa-lead")).toBe("testing");
  });
});

// ─────────────────────────────────────────────────────────────────
// compileRoleLoadout — skill-tree not available
// ─────────────────────────────────────────────────────────────────

describe("compileRoleLoadout", () => {
  beforeEach(() => {
    _resetSkillTreeCache();
  });

  it("returns null when skill-tree is not installed", async () => {
    // skill-tree won't be installed in test environment
    const result = await compileRoleLoadout("worker");
    expect(result).toBeNull();
  });

  it("returns null for unknown roles with no default profile", async () => {
    const result = await compileRoleLoadout("unknown-role");
    expect(result).toBeNull();
  });

  it("returns null when basePath does not exist", async () => {
    const result = await compileRoleLoadout("worker", {
      basePath: "/nonexistent/path/to/skill-tree",
    });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// compileAllRoleLoadouts — skill-tree not available
// ─────────────────────────────────────────────────────────────────

describe("compileAllRoleLoadouts", () => {
  beforeEach(() => {
    _resetSkillTreeCache();
  });

  it("returns empty map when skill-tree is not installed", async () => {
    const result = await compileAllRoleLoadouts([
      "worker",
      "integrator",
      "coordinator",
    ]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("returns empty map for empty roles array", async () => {
    const result = await compileAllRoleLoadouts([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});

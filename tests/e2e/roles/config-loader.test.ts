/**
 * Role Config Loader Tests
 *
 * Tests for loading role configurations from files.
 *
 * @see s-60tc Specialized Agent Roles
 * @see i-7j9m Project Role Config File Loading
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  loadConfigFile,
  loadProjectConfig,
  loadUserConfig,
  loadAllConfigs,
  getProjectConfigPath,
  getUserConfigPath,
  parseCapabilities,
  entryToRoleConfig,
  type RoleConfigFile,
  type RoleConfigEntry,
} from "../../../src/roles/config-loader.js";

import {
  DefaultRoleRegistry,
  getBuiltinRole,
} from "../../../src/roles/index.js";

describe("Role Config Loader", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Helper Functions
  // ─────────────────────────────────────────────────────────────────────────

  let tempDir: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "role-config-test-"));
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeConfigFile(configPath: string, config: RoleConfigFile): void {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Path Resolution
  // ─────────────────────────────────────────────────────────────────────────

  describe("Path Resolution", () => {
    it("CONFIG-PATH-01: getProjectConfigPath returns correct path", () => {
      const projectPath = "/my/project";
      const configPath = getProjectConfigPath(projectPath);
      expect(configPath).toBe("/my/project/.macro-agent/roles.json");
    });

    it("CONFIG-PATH-02: getProjectConfigPath uses cwd when no path provided", () => {
      const configPath = getProjectConfigPath();
      expect(configPath).toBe(
        path.join(process.cwd(), ".macro-agent", "roles.json")
      );
    });

    it("CONFIG-PATH-03: getUserConfigPath returns path in home directory", () => {
      const configPath = getUserConfigPath();
      expect(configPath).toBe(
        path.join(os.homedir(), ".macro-agent", "roles.json")
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Capability Parsing
  // ─────────────────────────────────────────────────────────────────────────

  describe("Capability Parsing", () => {
    it("CONFIG-CAP-01: parseCapabilities handles simple replacement", () => {
      const capabilities = ["file.read", "file.write"];
      const result = parseCapabilities(capabilities);
      expect(result).toEqual(["file.read", "file.write"]);
    });

    it("CONFIG-CAP-02: parseCapabilities handles additive modifiers", () => {
      const capabilities = ["+custom.capability", "+another.cap"];
      const parent = ["file.read"] as any[];
      const result = parseCapabilities(capabilities, parent);

      expect(result).toContain("file.read");
      expect(result).toContain("custom.capability");
      expect(result).toContain("another.cap");
    });

    it("CONFIG-CAP-03: parseCapabilities handles subtractive modifiers", () => {
      const capabilities = ["-agent.spawn.worker"];
      const parent = ["agent.spawn.worker", "lifecycle.done"] as any[];
      const result = parseCapabilities(capabilities, parent);

      expect(result).not.toContain("agent.spawn.worker");
      expect(result).toContain("lifecycle.done");
    });

    it("CONFIG-CAP-04: parseCapabilities handles mixed modifiers", () => {
      const capabilities = ["+custom.cap", "-agent.spawn.worker", "file.write"];
      const parent = ["agent.spawn.worker", "file.read"] as any[];
      const result = parseCapabilities(capabilities, parent);

      expect(result).toContain("file.read"); // From parent
      expect(result).toContain("custom.cap"); // Added
      expect(result).toContain("file.write"); // Added (no modifier)
      expect(result).not.toContain("agent.spawn.worker"); // Removed
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Entry to RoleConfig Conversion
  // ─────────────────────────────────────────────────────────────────────────

  describe("Entry to RoleConfig Conversion", () => {
    it("CONFIG-ENTRY-01: entryToRoleConfig creates valid RoleConfig", () => {
      const entry: RoleConfigEntry = {
        extends: "worker",
        displayName: "Custom Worker",
        description: "A custom worker role",
        capabilities: ["file.read", "lifecycle.done"],
      };

      const config = entryToRoleConfig("custom-worker", entry);

      expect(config.name).toBe("custom-worker");
      expect(config.displayName).toBe("Custom Worker");
      expect(config.description).toBe("A custom worker role");
      expect(config.extends).toBe("worker");
      expect(config.capabilities).toEqual(["file.read", "lifecycle.done"]);
    });

    it("CONFIG-ENTRY-02: entryToRoleConfig preserves enforcement sections", () => {
      const entry: RoleConfigEntry = {
        capabilities: ["*"],
        workspace: {
          type: "own",
          branchPattern: "feature/{agent_id}",
        },
        lifecycle: {
          type: "ephemeral",
          maxDurationMs: 300000,
        },
      };

      const config = entryToRoleConfig("test-role", entry);

      expect(config.workspace?.type).toBe("own");
      expect(config.workspace?.branchPattern).toBe("feature/{agent_id}");
      expect(config.lifecycle?.type).toBe("ephemeral");
      expect(config.lifecycle?.maxDurationMs).toBe(300000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: File Loading
  // ─────────────────────────────────────────────────────────────────────────

  describe("File Loading", () => {
    it("CONFIG-LOAD-01: loadConfigFile returns found=false for missing file", () => {
      const result = loadConfigFile("/nonexistent/path/roles.json");

      expect(result.found).toBe(false);
      expect(result.roles).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("CONFIG-LOAD-02: loadConfigFile loads valid config file", () => {
      const configPath = path.join(tempDir, "roles.json");
      const config: RoleConfigFile = {
        version: "1",
        roles: {
          "custom-worker": {
            extends: "worker",
            capabilities: ["file.read", "lifecycle.done"],
          },
        },
      };

      writeConfigFile(configPath, config);
      const result = loadConfigFile(configPath);

      expect(result.found).toBe(true);
      expect(result.roles).toHaveLength(1);
      expect(result.roles[0].name).toBe("custom-worker");
      expect(result.warnings).toHaveLength(0);
    });

    it("CONFIG-LOAD-03: loadConfigFile handles invalid JSON gracefully", () => {
      const configPath = path.join(tempDir, "roles.json");
      fs.writeFileSync(configPath, "{ invalid json }");

      const result = loadConfigFile(configPath);

      expect(result.found).toBe(true);
      expect(result.roles).toHaveLength(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("Failed to parse");
    });

    it("CONFIG-LOAD-04: loadConfigFile warns on unknown version", () => {
      const configPath = path.join(tempDir, "roles.json");
      const config: RoleConfigFile = {
        version: "99",
        roles: {},
      };

      writeConfigFile(configPath, config);
      const result = loadConfigFile(configPath);

      expect(result.found).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("Unknown config version");
    });

    it("CONFIG-LOAD-05: loadConfigFile loads multiple roles", () => {
      const configPath = path.join(tempDir, "roles.json");
      const config: RoleConfigFile = {
        roles: {
          "role-a": { capabilities: ["file.read"] },
          "role-b": { capabilities: ["file.write"] },
          "role-c": { extends: "generic" },
        },
      };

      writeConfigFile(configPath, config);
      const result = loadConfigFile(configPath);

      expect(result.found).toBe(true);
      expect(result.roles).toHaveLength(3);
      expect(result.roles.map((r) => r.name)).toEqual([
        "role-a",
        "role-b",
        "role-c",
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unit Tests: Project/User Config Loading
  // ─────────────────────────────────────────────────────────────────────────

  describe("Project/User Config Loading", () => {
    it("CONFIG-PROJECT-01: loadProjectConfig uses correct path", () => {
      const projectPath = tempDir;
      const configDir = path.join(projectPath, ".macro-agent");
      fs.mkdirSync(configDir, { recursive: true });

      const configPath = path.join(configDir, "roles.json");
      const config: RoleConfigFile = {
        roles: {
          "project-role": { capabilities: ["file.read"] },
        },
      };

      writeConfigFile(configPath, config);
      const result = loadProjectConfig(projectPath);

      expect(result.found).toBe(true);
      expect(result.roles).toHaveLength(1);
      expect(result.roles[0].name).toBe("project-role");
    });

    it("CONFIG-ALL-01: loadAllConfigs combines user and project configs", () => {
      // Create project config
      const projectConfigDir = path.join(tempDir, "project", ".macro-agent");
      fs.mkdirSync(projectConfigDir, { recursive: true });
      writeConfigFile(path.join(projectConfigDir, "roles.json"), {
        roles: {
          "project-role": { capabilities: ["file.read"] },
        },
      });

      // Create user config
      const userConfigDir = path.join(tempDir, "user", ".macro-agent");
      fs.mkdirSync(userConfigDir, { recursive: true });
      writeConfigFile(path.join(userConfigDir, "roles.json"), {
        roles: {
          "user-role": { capabilities: ["file.write"] },
        },
      });

      const result = loadAllConfigs({
        projectPath: path.join(tempDir, "project"),
        configPaths: {
          user: path.join(userConfigDir, "roles.json"),
          project: path.join(projectConfigDir, "roles.json"),
        },
      });

      expect(result.totalRoles).toBe(2);
      expect(result.project.roles).toHaveLength(1);
      expect(result.user.roles).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integration Tests: Registry Integration
  // ─────────────────────────────────────────────────────────────────────────

  describe("Registry Integration", () => {
    it("CONFIG-REG-01: Registry loadFromFile registers custom roles", () => {
      const registry = new DefaultRoleRegistry();

      const configPath = path.join(tempDir, "roles.json");
      const config: RoleConfigFile = {
        roles: {
          "custom-role": {
            capabilities: ["file.read", "file.write", "lifecycle.done"],
          },
        },
      };

      writeConfigFile(configPath, config);
      const result = registry.loadFromFile(configPath, "custom");

      expect(result.found).toBe(true);
      expect(result.roles).toHaveLength(1);

      // Role should be resolvable
      const resolved = registry.resolveRole("custom-role");
      expect(resolved.name).toBe("custom-role");
      expect(resolved.capabilities).toContain("file.read");
    });

    it("CONFIG-REG-02: Registry loadFromFile registers at project level", () => {
      const registry = new DefaultRoleRegistry();

      const configPath = path.join(tempDir, "roles.json");
      const config: RoleConfigFile = {
        roles: {
          worker: {
            override: "merge",
            capabilities: ["file.read", "custom.capability"],
          },
        },
      };

      writeConfigFile(configPath, config);
      registry.loadFromFile(configPath, "project");

      // Resolve should use project override
      const resolved = registry.resolveRole("worker");
      expect(resolved.capabilities).toContain("custom.capability");
    });

    it("CONFIG-REG-03: Registry with autoLoad loads configs on construction", () => {
      // Create project config
      const projectConfigDir = path.join(tempDir, ".macro-agent");
      fs.mkdirSync(projectConfigDir, { recursive: true });
      writeConfigFile(path.join(projectConfigDir, "roles.json"), {
        roles: {
          "auto-loaded-role": { capabilities: ["file.read"] },
        },
      });

      const registry = new DefaultRoleRegistry({
        projectPath: tempDir,
        autoLoad: true,
        skipUserConfig: true, // Skip user config for this test
      });

      // Role should be available
      const resolved = registry.resolveRole("auto-loaded-role");
      expect(resolved.name).toBe("auto-loaded-role");
    });

    it("CONFIG-REG-04: Project roles override user roles", () => {
      const registry = new DefaultRoleRegistry();

      // Load user-level first
      const userConfigPath = path.join(tempDir, "user-roles.json");
      writeConfigFile(userConfigPath, {
        roles: {
          "shared-role": {
            description: "User level",
            capabilities: ["file.read"],
          },
        },
      });
      registry.loadFromFile(userConfigPath, "user");

      // Load project-level (should override)
      const projectConfigPath = path.join(tempDir, "project-roles.json");
      writeConfigFile(projectConfigPath, {
        roles: {
          "shared-role": {
            description: "Project level",
            capabilities: ["file.read", "file.write"],
          },
        },
      });
      registry.loadFromFile(projectConfigPath, "project");

      const resolved = registry.resolveRole("shared-role");
      expect(resolved.description).toBe("Project level");
      expect(resolved.capabilities).toContain("file.write");
    });

    it("CONFIG-REG-05: Extended roles inherit from parent", () => {
      const registry = new DefaultRoleRegistry();

      const configPath = path.join(tempDir, "roles.json");
      writeConfigFile(configPath, {
        roles: {
          "extended-worker": {
            extends: "worker",
            description: "Worker with extra capabilities",
          },
        },
      });
      registry.loadFromFile(configPath);

      const resolved = registry.resolveRole("extended-worker");

      // Should have worker's capabilities
      const workerRole = getBuiltinRole("worker")!;
      for (const cap of workerRole.capabilities) {
        expect(resolved.capabilities).toContain(cap);
      }

      // But with custom description
      expect(resolved.description).toBe("Worker with extra capabilities");
    });

    it("CONFIG-REG-06: getLoadWarnings returns accumulated warnings", () => {
      const registry = new DefaultRoleRegistry();

      // Load file with unknown version
      const configPath = path.join(tempDir, "roles.json");
      writeConfigFile(configPath, {
        version: "999",
        roles: {},
      });
      registry.loadFromFile(configPath);

      const warnings = registry.getLoadWarnings();
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain("Unknown config version");
    });

    it("CONFIG-REG-07: clearLoadedRoles removes all loaded roles", () => {
      const registry = new DefaultRoleRegistry();

      const configPath = path.join(tempDir, "roles.json");
      writeConfigFile(configPath, {
        roles: {
          "custom-role": { capabilities: ["file.read"] },
        },
      });
      registry.loadFromFile(configPath);

      // Role should exist
      let resolved = registry.resolveRole("custom-role");
      expect(resolved.name).toBe("custom-role");

      // Clear and try again
      registry.clearLoadedRoles();
      resolved = registry.resolveRole("custom-role");

      // Should fall back to generic
      expect(resolved.name).toBe("generic");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    it("CONFIG-EDGE-01: Empty roles object is handled", () => {
      const configPath = path.join(tempDir, "roles.json");
      writeConfigFile(configPath, { roles: {} });

      const result = loadConfigFile(configPath);

      expect(result.found).toBe(true);
      expect(result.roles).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("CONFIG-EDGE-02: Missing roles key is handled", () => {
      const configPath = path.join(tempDir, "roles.json");
      writeConfigFile(configPath, { version: "1" });

      const result = loadConfigFile(configPath);

      expect(result.found).toBe(true);
      expect(result.roles).toHaveLength(0);
    });

    it("CONFIG-EDGE-03: Role with only extends is valid", () => {
      const configPath = path.join(tempDir, "roles.json");
      writeConfigFile(configPath, {
        roles: {
          "minimal-role": { extends: "worker" },
        },
      });

      const result = loadConfigFile(configPath);

      expect(result.found).toBe(true);
      expect(result.roles).toHaveLength(1);
      expect(result.roles[0].extends).toBe("worker");
    });

    it("CONFIG-EDGE-04: Override modes are preserved", () => {
      const configPath = path.join(tempDir, "roles.json");
      writeConfigFile(configPath, {
        roles: {
          worker: {
            override: "replace",
            capabilities: ["custom.only"],
          },
        },
      });

      const result = loadConfigFile(configPath);

      expect(result.roles[0].override).toBe("replace");
    });
  });
});

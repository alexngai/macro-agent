/**
 * Unit tests for `loadoutToSpawnOptions` — the pure-function translator
 * from wire-shape `MaterializedLoadout` to macro-agent `SpawnAgentOptions`.
 *
 * These tests pin the shared contract used by both the mail-inbound
 * consumer and the new `dispatch/spawn-agent` MAP handler. Both paths
 * should produce identical spawn options for the same loadout input.
 */

import { describe, it, expect } from "vitest";
import {
  loadoutToSpawnOptions,
  type WireLoadout,
} from "../loadout-translation.js";

describe("loadoutToSpawnOptions", () => {
  it("returns {} for undefined loadout", () => {
    expect(loadoutToSpawnOptions(undefined)).toEqual({});
  });

  it("returns {} when ctx is provided but loadout is undefined", () => {
    expect(loadoutToSpawnOptions(undefined, { fullAutonomous: true })).toEqual({});
  });

  it("returns {} for loadout with no permissions/capabilities (empty fields)", () => {
    const loadout: WireLoadout = {};
    expect(loadoutToSpawnOptions(loadout)).toEqual({});
  });

  it("returns {} when permissions is present but all rule arrays are empty", () => {
    const loadout: WireLoadout = {
      permissions: { allow: [], deny: [], ask: [] },
    };
    // hasAnyRule returns false → no permissions or fullAutonomous propagated.
    expect(loadoutToSpawnOptions(loadout, { fullAutonomous: true })).toEqual({});
  });

  it("propagates deny rules + sets fullAutonomous from ctx (true)", () => {
    const loadout: WireLoadout = {
      permissions: { deny: ["Bash(rm -rf:*)"] },
    };
    const result = loadoutToSpawnOptions(loadout, { fullAutonomous: true });
    expect(result.permissions).toEqual({
      allow: [],
      deny: ["Bash(rm -rf:*)"],
      ask: [],
    });
    expect(result.fullAutonomous).toBe(true);
  });

  it("propagates deny rules + sets fullAutonomous from ctx (false)", () => {
    const loadout: WireLoadout = {
      permissions: { deny: ["Bash(rm -rf:*)"] },
    };
    const result = loadoutToSpawnOptions(loadout, { fullAutonomous: false });
    expect(result.permissions).toEqual({
      allow: [],
      deny: ["Bash(rm -rf:*)"],
      ask: [],
    });
    expect(result.fullAutonomous).toBe(false);
  });

  it("defaults fullAutonomous to false when ctx omits it but permissions are present", () => {
    const loadout: WireLoadout = {
      permissions: { ask: ["Write(*.env)"] },
    };
    const result = loadoutToSpawnOptions(loadout);
    expect(result.permissions).toEqual({
      allow: [],
      deny: [],
      ask: ["Write(*.env)"],
    });
    expect(result.fullAutonomous).toBe(false);
  });

  it("does NOT propagate fullAutonomous when no permissions are present", () => {
    // ctx.fullAutonomous is meaningless without permissions to apply it to.
    const loadout: WireLoadout = { capabilities: ["editor"] };
    const result = loadoutToSpawnOptions(loadout, { fullAutonomous: true });
    expect(result.fullAutonomous).toBeUndefined();
    expect(result.permissions).toBeUndefined();
  });

  it("forwards capabilities (cloned, not aliased)", () => {
    const sourceCaps = ["editor", "git"];
    const loadout: WireLoadout = { capabilities: sourceCaps };
    const result = loadoutToSpawnOptions(loadout);
    expect(result.capabilities).toEqual(["editor", "git"]);
    // Ensure we cloned — mutating the result's array must not affect the source.
    result.capabilities!.push("newcap");
    expect(sourceCaps).toEqual(["editor", "git"]);
  });

  it("does not include capabilities when the array is empty", () => {
    const loadout: WireLoadout = { capabilities: [] };
    const result = loadoutToSpawnOptions(loadout);
    expect(result.capabilities).toBeUndefined();
  });

  it("ignores mcpProviders (Phase 2 — reserved/no-op)", () => {
    const loadout: WireLoadout = {
      mcpProviders: [
        { name: "github", command: "github-mcp", args: ["--read-only"] },
      ],
    };
    const result = loadoutToSpawnOptions(loadout);
    // The provider should NOT appear on the returned spawn options.
    expect(result).toEqual({});
    expect((result as Record<string, unknown>).mcpProviders).toBeUndefined();
  });

  it("ignores mcpScope (Phase 1 — reserved/no-op)", () => {
    const loadout: WireLoadout = {
      mcpScope: [{ server: "github", tools: ["search"] }],
    };
    const result = loadoutToSpawnOptions(loadout);
    expect(result).toEqual({});
    expect((result as Record<string, unknown>).mcpScope).toBeUndefined();
  });

  it("combines permissions + capabilities + ignores mcp fields together", () => {
    const loadout: WireLoadout = {
      permissions: { allow: ["Read(**)"], deny: ["Bash(rm:*)"] },
      capabilities: ["editor"],
      mcpProviders: [{ name: "github" }],
      mcpScope: [{ server: "github" }],
    };
    const result = loadoutToSpawnOptions(loadout, { fullAutonomous: true });

    expect(result.permissions).toEqual({
      allow: ["Read(**)"],
      deny: ["Bash(rm:*)"],
      ask: [],
    });
    expect(result.fullAutonomous).toBe(true);
    expect(result.capabilities).toEqual(["editor"]);
    expect((result as Record<string, unknown>).mcpProviders).toBeUndefined();
    expect((result as Record<string, unknown>).mcpScope).toBeUndefined();
  });
});

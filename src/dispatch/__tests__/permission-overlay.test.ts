/**
 * Unit tests for the per-process permission-overlay registry.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  setPermissionOverlay,
  clearPermissionOverlay,
  getPermissionOverlay,
  clearAllPermissionOverlays,
  _resetForTest,
  _sizeForTest,
} from "../permission-overlay.js";

describe("permission-overlay registry", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("returns undefined when no overlay is set", () => {
    expect(getPermissionOverlay("agent-A")).toBeUndefined();
  });

  it("set / get round-trip", () => {
    setPermissionOverlay("agent-A", { deny: ["Bash(rm:*)"] });
    expect(getPermissionOverlay("agent-A")).toEqual({ deny: ["Bash(rm:*)"] });
  });

  it("clear removes only the targeted agent's overlay", () => {
    setPermissionOverlay("agent-A", { deny: ["Bash(*)"] });
    setPermissionOverlay("agent-B", { deny: ["Read(*)"] });
    clearPermissionOverlay("agent-A");
    expect(getPermissionOverlay("agent-A")).toBeUndefined();
    expect(getPermissionOverlay("agent-B")).toEqual({ deny: ["Read(*)"] });
  });

  it("clear is idempotent (no error when no overlay)", () => {
    expect(() => clearPermissionOverlay("ghost")).not.toThrow();
  });

  it("set overwrites prior overlay for the same agent", () => {
    setPermissionOverlay("agent-A", { deny: ["Bash(*)"] });
    setPermissionOverlay("agent-A", { allow: ["Read(*)"] });
    expect(getPermissionOverlay("agent-A")).toEqual({ allow: ["Read(*)"] });
  });

  it("clearAllPermissionOverlays drops everything", () => {
    setPermissionOverlay("a", { deny: ["x"] });
    setPermissionOverlay("b", { deny: ["y"] });
    setPermissionOverlay("c", { deny: ["z"] });
    expect(_sizeForTest()).toBe(3);
    clearAllPermissionOverlays();
    expect(_sizeForTest()).toBe(0);
    expect(getPermissionOverlay("a")).toBeUndefined();
  });
});

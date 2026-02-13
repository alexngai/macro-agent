/**
 * Tests for getStableInstanceId
 *
 * Verifies that the stable instance ID is deterministic, consistent,
 * and produces valid instance IDs for the EventStore.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { getStableInstanceId } from "../stable-instance-id.js";

describe("getStableInstanceId", () => {
  it("should return the same ID for the same path", () => {
    const id1 = getStableInstanceId("/Users/test/project");
    const id2 = getStableInstanceId("/Users/test/project");
    expect(id1).toBe(id2);
  });

  it("should return different IDs for different paths", () => {
    const id1 = getStableInstanceId("/Users/test/project-a");
    const id2 = getStableInstanceId("/Users/test/project-b");
    expect(id1).not.toBe(id2);
  });

  it("should start with inst_ prefix", () => {
    const id = getStableInstanceId("/tmp/test");
    expect(id).toMatch(/^inst_/);
  });

  it("should produce a valid instance ID format (alphanumeric + underscore)", () => {
    const id = getStableInstanceId("/tmp/test");
    expect(id).toMatch(/^[a-zA-Z0-9_]+$/);
  });

  it("should normalize relative paths to absolute", () => {
    // Both should resolve to the same absolute path
    const absPath = resolve("./src");
    const id1 = getStableInstanceId("./src");
    const id2 = getStableInstanceId(absPath);
    expect(id1).toBe(id2);
  });

  it("should handle paths with trailing slashes consistently", () => {
    // resolve() strips trailing slashes, so these should be equal
    const id1 = getStableInstanceId("/tmp/project");
    const id2 = getStableInstanceId("/tmp/project/");
    expect(id1).toBe(id2);
  });

  it("should produce a fixed-length ID", () => {
    const short = getStableInstanceId("/a");
    const long = getStableInstanceId("/very/long/path/to/some/deeply/nested/project/directory");
    // Both should be inst_ + 12 hex chars = 17 chars total
    expect(short.length).toBe(17);
    expect(long.length).toBe(17);
  });
});

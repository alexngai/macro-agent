/**
 * Tests for SessionMapper — in-memory ACP session ↔ agent mapping.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SessionMapper } from "../session-mapper.js";

describe("SessionMapper", () => {
  let mapper: SessionMapper;

  beforeEach(() => {
    mapper = new SessionMapper();
  });

  // ── createMapping / getMapping ────────────────────────────────

  describe("createMapping / getMapping", () => {
    it("should create and retrieve a mapping", () => {
      const mapping = mapper.createMapping("session-1", "head-1");

      expect(mapping.acpSessionId).toBe("session-1");
      expect(mapping.agentId).toBe("head-1");
      expect(mapping.headManagerId).toBe("head-1");
      expect(mapping.isMounted).toBe(false);
      expect(mapping.isProcessing).toBe(false);
      expect(mapping.createdAt).toBeGreaterThan(0);

      const retrieved = mapper.getMapping("session-1");
      expect(retrieved).toEqual(mapping);
    });

    it("should return undefined for unknown session", () => {
      expect(mapper.getMapping("nonexistent")).toBeUndefined();
    });
  });

  // ── getAgentId / getHeadManagerId ─────────────────────────────

  describe("getAgentId / getHeadManagerId", () => {
    it("should return the current agent ID", () => {
      mapper.createMapping("session-1", "head-1");
      expect(mapper.getAgentId("session-1")).toBe("head-1");
    });

    it("should return the head manager ID", () => {
      mapper.createMapping("session-1", "head-1");
      expect(mapper.getHeadManagerId("session-1")).toBe("head-1");
    });

    it("should return undefined for unknown session", () => {
      expect(mapper.getAgentId("nonexistent")).toBeUndefined();
      expect(mapper.getHeadManagerId("nonexistent")).toBeUndefined();
    });
  });

  // ── mount / unmount ───────────────────────────────────────────

  describe("mount / unmount", () => {
    it("should mount a different agent and return previous", () => {
      mapper.createMapping("session-1", "head-1");

      const previous = mapper.mount("session-1", "worker-1");
      expect(previous).toBe("head-1");
      expect(mapper.getAgentId("session-1")).toBe("worker-1");

      const mapping = mapper.getMapping("session-1");
      expect(mapping?.isMounted).toBe(true);
    });

    it("should unmount and restore head manager", () => {
      mapper.createMapping("session-1", "head-1");
      mapper.mount("session-1", "worker-1");

      const unmounted = mapper.unmount("session-1");
      expect(unmounted).toBe("worker-1");
      expect(mapper.getAgentId("session-1")).toBe("head-1");

      const mapping = mapper.getMapping("session-1");
      expect(mapping?.isMounted).toBe(false);
    });

    it("should return undefined when mounting unknown session", () => {
      expect(mapper.mount("nonexistent", "agent-1")).toBeUndefined();
    });

    it("should return undefined when unmounting unknown session", () => {
      expect(mapper.unmount("nonexistent")).toBeUndefined();
    });
  });

  // ── removeMapping ─────────────────────────────────────────────

  describe("removeMapping", () => {
    it("should remove a mapping", () => {
      mapper.createMapping("session-1", "head-1");
      expect(mapper.removeMapping("session-1")).toBe(true);
      expect(mapper.getMapping("session-1")).toBeUndefined();
    });

    it("should return false for unknown session", () => {
      expect(mapper.removeMapping("nonexistent")).toBe(false);
    });
  });

  // ── setProcessing ─────────────────────────────────────────────

  describe("setProcessing", () => {
    it("should set processing status", () => {
      mapper.createMapping("session-1", "head-1");

      mapper.setProcessing("session-1", true);
      expect(mapper.getMapping("session-1")?.isProcessing).toBe(true);

      mapper.setProcessing("session-1", false);
      expect(mapper.getMapping("session-1")?.isProcessing).toBe(false);
    });

    it("should no-op for unknown session", () => {
      // Should not throw
      mapper.setProcessing("nonexistent", true);
    });
  });

  // ── getAllMappings / getSessionsForAgent ───────────────────────

  describe("getAllMappings / getSessionsForAgent", () => {
    it("should return all mappings", () => {
      mapper.createMapping("session-1", "head-1");
      mapper.createMapping("session-2", "head-2");

      const all = mapper.getAllMappings();
      expect(all).toHaveLength(2);
    });

    it("should find sessions for a given agent", () => {
      mapper.createMapping("session-1", "head-1");
      mapper.createMapping("session-2", "head-1");
      mapper.createMapping("session-3", "head-2");

      const sessions = mapper.getSessionsForAgent("head-1");
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.acpSessionId).sort()).toEqual([
        "session-1",
        "session-2",
      ]);
    });

    it("should return empty array for unknown agent", () => {
      expect(mapper.getSessionsForAgent("nonexistent")).toEqual([]);
    });
  });
});

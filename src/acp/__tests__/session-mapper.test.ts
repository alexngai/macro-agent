/**
 * SessionMapper tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SessionMapper } from "../session-mapper.js";
import { ACPError } from "../types.js";

describe("SessionMapper", () => {
  let mapper: SessionMapper;

  beforeEach(() => {
    mapper = new SessionMapper();
  });

  describe("createMapping", () => {
    it("should create a new mapping", () => {
      const mapping = mapper.createMapping("session-1", "agent-head");

      expect(mapping.acpSessionId).toBe("session-1");
      expect(mapping.agentId).toBe("agent-head");
      expect(mapping.headManagerId).toBe("agent-head");
      expect(mapping.isMounted).toBe(false);
      expect(mapping.createdAt).toBeGreaterThan(0);
      expect(mapping.updatedAt).toBe(mapping.createdAt);
    });

    it("should overwrite existing mapping", () => {
      mapper.createMapping("session-1", "agent-1");
      const mapping = mapper.createMapping("session-1", "agent-2");

      expect(mapping.agentId).toBe("agent-2");
      expect(mapping.headManagerId).toBe("agent-2");
    });
  });

  describe("getMapping / getMappingOrThrow", () => {
    it("should return mapping if exists", () => {
      mapper.createMapping("session-1", "agent-1");

      const mapping = mapper.getMapping("session-1");
      expect(mapping).toBeDefined();
      expect(mapping?.agentId).toBe("agent-1");
    });

    it("should return undefined for non-existent session", () => {
      const mapping = mapper.getMapping("non-existent");
      expect(mapping).toBeUndefined();
    });

    it("should throw for non-existent session with getMappingOrThrow", () => {
      expect(() => mapper.getMappingOrThrow("non-existent")).toThrow(ACPError);
      expect(() => mapper.getMappingOrThrow("non-existent")).toThrow(
        "ACP session not found"
      );
    });
  });

  describe("getAgentId / getAgentIdOrThrow", () => {
    it("should return agent ID", () => {
      mapper.createMapping("session-1", "agent-1");

      expect(mapper.getAgentId("session-1")).toBe("agent-1");
    });

    it("should return undefined for non-existent session", () => {
      expect(mapper.getAgentId("non-existent")).toBeUndefined();
    });

    it("should throw for non-existent session with getAgentIdOrThrow", () => {
      expect(() => mapper.getAgentIdOrThrow("non-existent")).toThrow(ACPError);
    });
  });

  describe("mount", () => {
    it("should mount to a different agent", () => {
      mapper.createMapping("session-1", "agent-head");

      const previousId = mapper.mount("session-1", "agent-child");

      expect(previousId).toBe("agent-head");
      expect(mapper.getAgentId("session-1")).toBe("agent-child");
      expect(mapper.isMounted("session-1")).toBe(true);
    });

    it("should track head manager after mount", () => {
      mapper.createMapping("session-1", "agent-head");
      mapper.mount("session-1", "agent-child");

      expect(mapper.getHeadManagerId("session-1")).toBe("agent-head");
    });

    it("should update updatedAt timestamp", async () => {
      mapper.createMapping("session-1", "agent-head");
      const originalUpdatedAt = mapper.getMapping("session-1")!.updatedAt;

      // Small delay to ensure timestamp changes
      await new Promise((r) => setTimeout(r, 10));

      mapper.mount("session-1", "agent-child");
      const newUpdatedAt = mapper.getMapping("session-1")!.updatedAt;

      expect(newUpdatedAt).toBeGreaterThan(originalUpdatedAt);
    });

    it("should throw if session not found", () => {
      expect(() => mapper.mount("non-existent", "agent-1")).toThrow(ACPError);
    });

    it("should not set isMounted if mounting back to head manager", () => {
      mapper.createMapping("session-1", "agent-head");
      mapper.mount("session-1", "agent-child");
      mapper.mount("session-1", "agent-head");

      expect(mapper.isMounted("session-1")).toBe(false);
    });
  });

  describe("unmount", () => {
    it("should unmount back to head manager", () => {
      mapper.createMapping("session-1", "agent-head");
      mapper.mount("session-1", "agent-child");

      const previousId = mapper.unmount("session-1");

      expect(previousId).toBe("agent-child");
      expect(mapper.getAgentId("session-1")).toBe("agent-head");
      expect(mapper.isMounted("session-1")).toBe(false);
    });

    it("should throw if session not found", () => {
      expect(() => mapper.unmount("non-existent")).toThrow(ACPError);
    });
  });

  describe("removeMapping", () => {
    it("should remove mapping and return true", () => {
      mapper.createMapping("session-1", "agent-1");

      const result = mapper.removeMapping("session-1");

      expect(result).toBe(true);
      expect(mapper.getMapping("session-1")).toBeUndefined();
    });

    it("should return false for non-existent session", () => {
      const result = mapper.removeMapping("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("getAllMappings", () => {
    it("should return all mappings", () => {
      mapper.createMapping("session-1", "agent-1");
      mapper.createMapping("session-2", "agent-2");

      const all = mapper.getAllMappings();

      expect(all).toHaveLength(2);
      expect(all.map((m) => m.acpSessionId).sort()).toEqual([
        "session-1",
        "session-2",
      ]);
    });

    it("should return empty array when no mappings", () => {
      expect(mapper.getAllMappings()).toEqual([]);
    });
  });

  describe("getSessionsForAgent", () => {
    it("should return sessions mapped to an agent", () => {
      mapper.createMapping("session-1", "agent-1");
      mapper.createMapping("session-2", "agent-1");
      mapper.createMapping("session-3", "agent-2");

      const sessions = mapper.getSessionsForAgent("agent-1");

      expect(sessions.sort()).toEqual(["session-1", "session-2"]);
    });

    it("should return empty array if no sessions for agent", () => {
      mapper.createMapping("session-1", "agent-1");

      const sessions = mapper.getSessionsForAgent("agent-other");

      expect(sessions).toEqual([]);
    });

    it("should reflect mount changes", () => {
      mapper.createMapping("session-1", "agent-head");
      mapper.mount("session-1", "agent-child");

      expect(mapper.getSessionsForAgent("agent-head")).toEqual([]);
      expect(mapper.getSessionsForAgent("agent-child")).toEqual(["session-1"]);
    });
  });

  describe("size", () => {
    it("should return number of mappings", () => {
      expect(mapper.size).toBe(0);

      mapper.createMapping("session-1", "agent-1");
      expect(mapper.size).toBe(1);

      mapper.createMapping("session-2", "agent-2");
      expect(mapper.size).toBe(2);

      mapper.removeMapping("session-1");
      expect(mapper.size).toBe(1);
    });
  });

  describe("clear", () => {
    it("should remove all mappings", () => {
      mapper.createMapping("session-1", "agent-1");
      mapper.createMapping("session-2", "agent-2");

      mapper.clear();

      expect(mapper.size).toBe(0);
      expect(mapper.getAllMappings()).toEqual([]);
    });
  });
});

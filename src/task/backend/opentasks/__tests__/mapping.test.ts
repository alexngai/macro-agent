/**
 * Tests for OpenTasks status mapping utilities
 *
 * @module task/backend/opentasks/__tests__/mapping.test
 */

import { describe, it, expect } from "vitest";
import {
  mapOpenTasksStatus,
  mapTaskStatus,
  isIssueComplete,
  isIssueBlocked,
} from "../mapping.js";

describe("OpenTasks Mapping", () => {
  describe("mapOpenTasksStatus", () => {
    it("should map 'open' to 'pending'", () => {
      expect(mapOpenTasksStatus("open")).toBe("pending");
    });

    it("should map 'in_progress' to 'in_progress'", () => {
      expect(mapOpenTasksStatus("in_progress")).toBe("in_progress");
    });

    it("should map 'blocked' to 'pending'", () => {
      expect(mapOpenTasksStatus("blocked")).toBe("pending");
    });

    it("should map 'closed' to 'completed'", () => {
      expect(mapOpenTasksStatus("closed")).toBe("completed");
    });

    it("should map unknown statuses to 'pending'", () => {
      expect(mapOpenTasksStatus("unknown")).toBe("pending");
      expect(mapOpenTasksStatus("")).toBe("pending");
    });
  });

  describe("mapTaskStatus", () => {
    it("should map 'pending' to 'open'", () => {
      expect(mapTaskStatus("pending")).toBe("open");
    });

    it("should map 'assigned' to 'open'", () => {
      expect(mapTaskStatus("assigned")).toBe("open");
    });

    it("should map 'in_progress' to 'in_progress'", () => {
      expect(mapTaskStatus("in_progress")).toBe("in_progress");
    });

    it("should map 'completed' to 'closed'", () => {
      expect(mapTaskStatus("completed")).toBe("closed");
    });

    it("should map 'failed' to 'closed'", () => {
      expect(mapTaskStatus("failed")).toBe("closed");
    });
  });

  describe("isIssueComplete", () => {
    it("should return true for 'closed'", () => {
      expect(isIssueComplete("closed")).toBe(true);
    });

    it("should return false for other statuses", () => {
      expect(isIssueComplete("open")).toBe(false);
      expect(isIssueComplete("in_progress")).toBe(false);
      expect(isIssueComplete("blocked")).toBe(false);
    });
  });

  describe("isIssueBlocked", () => {
    it("should return true for 'blocked'", () => {
      expect(isIssueBlocked("blocked")).toBe(true);
    });

    it("should return false for other statuses", () => {
      expect(isIssueBlocked("open")).toBe(false);
      expect(isIssueBlocked("in_progress")).toBe(false);
      expect(isIssueBlocked("closed")).toBe(false);
    });
  });
});

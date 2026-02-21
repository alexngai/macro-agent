import { describe, it, expect } from "vitest";
import { AnalystRole } from "../analyst-role.js";
import {
  FILE_CAPABILITIES,
  EXEC_CAPABILITIES,
  LIFECYCLE_CAPABILITIES,
  GIT_CAPABILITIES,
  AGENT_CAPABILITIES,
} from "../../roles/capabilities.js";

describe("AnalystRole", () => {
  it("has correct name", () => {
    expect(AnalystRole.name).toBe("analyst");
  });

  describe("capabilities", () => {
    it("has file.read capability", () => {
      expect(AnalystRole.capabilities).toContain(FILE_CAPABILITIES.READ);
    });

    it("has file.write capability", () => {
      expect(AnalystRole.capabilities).toContain(FILE_CAPABILITIES.WRITE);
    });

    it("has exec.command capability", () => {
      expect(AnalystRole.capabilities).toContain(EXEC_CAPABILITIES.COMMAND);
    });

    it("has lifecycle.done capability", () => {
      expect(AnalystRole.capabilities).toContain(LIFECYCLE_CAPABILITIES.DONE);
    });

    it("does NOT have git capabilities", () => {
      for (const cap of Object.values(GIT_CAPABILITIES)) {
        expect(AnalystRole.capabilities).not.toContain(cap);
      }
    });

    it("does NOT have agent.spawn capabilities", () => {
      for (const cap of Object.values(AGENT_CAPABILITIES)) {
        expect(AnalystRole.capabilities).not.toContain(cap);
      }
    });

    it("does NOT have file.delete capability", () => {
      expect(AnalystRole.capabilities).not.toContain(FILE_CAPABILITIES.DELETE);
    });
  });

  describe("workspace", () => {
    it("has type none", () => {
      expect(AnalystRole.workspace?.type).toBe("none");
    });
  });

  describe("lifecycle", () => {
    it("is ephemeral", () => {
      expect(AnalystRole.lifecycle?.type).toBe("ephemeral");
    });

    it("is task bound", () => {
      expect(AnalystRole.lifecycle?.taskBound).toBe(true);
    });

    it("cascade terminates", () => {
      expect(AnalystRole.lifecycle?.cascadeTerminate).toBe(true);
    });
  });

  describe("system prompt", () => {
    it("mentions input/ directory", () => {
      expect(AnalystRole.systemPrompt).toContain("input/");
    });

    it("mentions output/ directory", () => {
      expect(AnalystRole.systemPrompt).toContain("output/");
    });

    it("mentions done()", () => {
      expect(AnalystRole.systemPrompt).toContain("done()");
    });
  });
});

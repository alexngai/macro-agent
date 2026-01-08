import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createCapabilityManager,
  type CapabilityManager,
} from "../capability-manager.js";
import type {
  CapabilityGrant,
  TaskDelegationCapability,
  FederatedHierarchyCapability,
  EncapsulationCapability,
} from "../types.js";

describe("CapabilityManager", () => {
  let capabilityManager: CapabilityManager;

  beforeEach(() => {
    capabilityManager = createCapabilityManager();
  });

  describe("grant", () => {
    it("should grant capabilities to a peer", () => {
      const grants: CapabilityGrant[] = [
        { type: "task-delegation" },
      ];

      const result = capabilityManager.grant("peer-1", grants);

      expect(result.peerId).toBe("peer-1");
      expect(result.grants).toHaveLength(1);
      expect(result.grants[0].type).toBe("task-delegation");
      expect(result.issuedAt).toBeDefined();
    });

    it("should merge grants when granting to existing peer", () => {
      capabilityManager.grant("peer-1", [{ type: "task-delegation" }]);

      const result = capabilityManager.grant("peer-1", [
        {
          type: "federated-hierarchy",
          canQueryAgents: true,
          canMount: false,
          canSubscribeStatus: true,
        },
      ]);

      expect(result.grants).toHaveLength(2);
      expect(result.grants.map((g) => g.type)).toContain("task-delegation");
      expect(result.grants.map((g) => g.type)).toContain("federated-hierarchy");
    });

    it("should override existing grant of same type", () => {
      capabilityManager.grant("peer-1", [
        { type: "task-delegation", maxConcurrentTasks: 5 },
      ]);

      const result = capabilityManager.grant("peer-1", [
        { type: "task-delegation", maxConcurrentTasks: 10 },
      ]);

      expect(result.grants).toHaveLength(1);
      expect((result.grants[0] as TaskDelegationCapability).maxConcurrentTasks).toBe(10);
    });

    it("should set expiration time when expiresIn is provided", () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const result = capabilityManager.grant(
        "peer-1",
        [{ type: "task-delegation" }],
        { expiresIn: 60000 }
      );

      expect(result.expiresAt).toBe(now + 60000);

      vi.useRealTimers();
    });

    it("should set issuedBy when provided", () => {
      const result = capabilityManager.grant(
        "peer-1",
        [{ type: "task-delegation" }],
        { issuedBy: "admin-agent" }
      );

      expect(result.issuedBy).toBe("admin-agent");
    });
  });

  describe("revoke", () => {
    it("should revoke all capabilities when no types specified", () => {
      capabilityManager.grant("peer-1", [
        { type: "task-delegation" },
        {
          type: "federated-hierarchy",
          canQueryAgents: true,
          canMount: false,
          canSubscribeStatus: false,
        },
      ]);

      capabilityManager.revoke("peer-1");

      expect(capabilityManager.getCapabilities("peer-1")).toBeNull();
    });

    it("should revoke specific capability types", () => {
      capabilityManager.grant("peer-1", [
        { type: "task-delegation" },
        {
          type: "federated-hierarchy",
          canQueryAgents: true,
          canMount: false,
          canSubscribeStatus: false,
        },
      ]);

      capabilityManager.revoke("peer-1", ["task-delegation"]);

      const remaining = capabilityManager.getCapabilities("peer-1");
      expect(remaining?.grants).toHaveLength(1);
      expect(remaining?.grants[0].type).toBe("federated-hierarchy");
    });

    it("should delete peer entirely if no grants remain", () => {
      capabilityManager.grant("peer-1", [{ type: "task-delegation" }]);

      capabilityManager.revoke("peer-1", ["task-delegation"]);

      expect(capabilityManager.getCapabilities("peer-1")).toBeNull();
    });

    it("should handle revoking from non-existent peer", () => {
      // Should not throw
      expect(() => capabilityManager.revoke("non-existent")).not.toThrow();
    });
  });

  describe("hasCapability", () => {
    describe("task-delegation", () => {
      it("should return true when peer has task-delegation capability", () => {
        capabilityManager.grant("peer-1", [{ type: "task-delegation" }]);

        const result = capabilityManager.hasCapability("peer-1", {
          type: "task-delegation",
        });

        expect(result).toBe(true);
      });

      it("should return false when peer lacks capability", () => {
        const result = capabilityManager.hasCapability("peer-1", {
          type: "task-delegation",
        });

        expect(result).toBe(false);
      });
    });

    describe("federated-hierarchy", () => {
      beforeEach(() => {
        capabilityManager.grant("peer-1", [
          {
            type: "federated-hierarchy",
            canQueryAgents: true,
            canMount: true,
            canSubscribeStatus: false,
          },
        ]);
      });

      it("should return true when all required permissions are granted", () => {
        const result = capabilityManager.hasCapability("peer-1", {
          type: "federated-hierarchy",
          canQueryAgents: true,
          canMount: false,
          canSubscribeStatus: false,
        });

        expect(result).toBe(true);
      });

      it("should return false when required permission is not granted", () => {
        const result = capabilityManager.hasCapability("peer-1", {
          type: "federated-hierarchy",
          canQueryAgents: true,
          canMount: true,
          canSubscribeStatus: true, // Not granted
        });

        expect(result).toBe(false);
      });

      it("should check agent ID restrictions", () => {
        capabilityManager.grant("peer-2", [
          {
            type: "federated-hierarchy",
            canQueryAgents: true,
            canMount: true,
            canSubscribeStatus: true,
            allowedAgentIds: ["agent-1", "agent-2"],
          },
        ]);

        // Requesting allowed agents
        expect(
          capabilityManager.hasCapability("peer-2", {
            type: "federated-hierarchy",
            canQueryAgents: true,
            canMount: false,
            canSubscribeStatus: false,
            allowedAgentIds: ["agent-1"],
          })
        ).toBe(true);

        // Requesting disallowed agent
        expect(
          capabilityManager.hasCapability("peer-2", {
            type: "federated-hierarchy",
            canQueryAgents: true,
            canMount: false,
            canSubscribeStatus: false,
            allowedAgentIds: ["agent-3"],
          })
        ).toBe(false);
      });
    });

    describe("encapsulation", () => {
      it("should check canActAsChild permission", () => {
        capabilityManager.grant("peer-1", [
          {
            type: "encapsulation",
            canActAsChild: true,
            canActAsParent: false,
          },
        ]);

        expect(
          capabilityManager.hasCapability("peer-1", {
            type: "encapsulation",
            canActAsChild: true,
            canActAsParent: false,
          })
        ).toBe(true);

        expect(
          capabilityManager.hasCapability("peer-1", {
            type: "encapsulation",
            canActAsChild: false,
            canActAsParent: true,
          })
        ).toBe(false);
      });

      it("should check canActAsParent permission", () => {
        capabilityManager.grant("peer-1", [
          {
            type: "encapsulation",
            canActAsChild: false,
            canActAsParent: true,
          },
        ]);

        expect(
          capabilityManager.hasCapability("peer-1", {
            type: "encapsulation",
            canActAsChild: false,
            canActAsParent: true,
          })
        ).toBe(true);
      });
    });

    describe("expiration", () => {
      it("should return false for expired capabilities", () => {
        vi.useFakeTimers();
        const now = Date.now();
        vi.setSystemTime(now);

        capabilityManager.grant(
          "peer-1",
          [{ type: "task-delegation" }],
          { expiresIn: 1000 }
        );

        // Before expiration
        expect(
          capabilityManager.hasCapability("peer-1", { type: "task-delegation" })
        ).toBe(true);

        // After expiration
        vi.setSystemTime(now + 2000);
        expect(
          capabilityManager.hasCapability("peer-1", { type: "task-delegation" })
        ).toBe(false);

        vi.useRealTimers();
      });
    });
  });

  describe("getCapabilities", () => {
    it("should return null for unknown peer", () => {
      expect(capabilityManager.getCapabilities("unknown")).toBeNull();
    });

    it("should return capabilities for known peer", () => {
      capabilityManager.grant("peer-1", [{ type: "task-delegation" }]);

      const caps = capabilityManager.getCapabilities("peer-1");

      expect(caps).not.toBeNull();
      expect(caps?.peerId).toBe("peer-1");
      expect(caps?.grants).toHaveLength(1);
    });

    it("should return null for expired capabilities", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      capabilityManager.grant(
        "peer-1",
        [{ type: "task-delegation" }],
        { expiresIn: 1000 }
      );

      vi.setSystemTime(now + 2000);

      expect(capabilityManager.getCapabilities("peer-1")).toBeNull();

      vi.useRealTimers();
    });
  });

  describe("listAuthorizedPeers", () => {
    it("should return empty array when no peers authorized", () => {
      expect(capabilityManager.listAuthorizedPeers()).toEqual([]);
    });

    it("should return all authorized peers", () => {
      capabilityManager.grant("peer-1", [{ type: "task-delegation" }]);
      capabilityManager.grant("peer-2", [
        {
          type: "encapsulation",
          canActAsChild: true,
          canActAsParent: false,
        },
      ]);

      const peers = capabilityManager.listAuthorizedPeers();

      expect(peers).toHaveLength(2);
      expect(peers.map((p) => p.peerId)).toContain("peer-1");
      expect(peers.map((p) => p.peerId)).toContain("peer-2");
    });

    it("should exclude expired capabilities", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      capabilityManager.grant(
        "peer-1",
        [{ type: "task-delegation" }],
        { expiresIn: 1000 }
      );
      capabilityManager.grant("peer-2", [{ type: "task-delegation" }]);

      vi.setSystemTime(now + 2000);

      const peers = capabilityManager.listAuthorizedPeers();

      expect(peers).toHaveLength(1);
      expect(peers[0].peerId).toBe("peer-2");

      vi.useRealTimers();
    });
  });

  describe("complex scenarios", () => {
    it("should handle multiple capability types for same peer", () => {
      capabilityManager.grant("peer-1", [
        { type: "task-delegation", maxConcurrentTasks: 5 },
        {
          type: "federated-hierarchy",
          canQueryAgents: true,
          canMount: true,
          canSubscribeStatus: true,
        },
        {
          type: "encapsulation",
          canActAsChild: true,
          canActAsParent: true,
        },
      ]);

      const caps = capabilityManager.getCapabilities("peer-1");
      expect(caps?.grants).toHaveLength(3);

      expect(
        capabilityManager.hasCapability("peer-1", { type: "task-delegation" })
      ).toBe(true);
      expect(
        capabilityManager.hasCapability("peer-1", {
          type: "federated-hierarchy",
          canQueryAgents: true,
          canMount: true,
          canSubscribeStatus: false,
        })
      ).toBe(true);
      expect(
        capabilityManager.hasCapability("peer-1", {
          type: "encapsulation",
          canActAsChild: true,
          canActAsParent: false,
        })
      ).toBe(true);
    });

    it("should refresh expiration when re-granting", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      capabilityManager.grant(
        "peer-1",
        [{ type: "task-delegation" }],
        { expiresIn: 1000 }
      );

      // Advance time but not past expiration
      vi.setSystemTime(now + 500);

      // Re-grant with new expiration
      capabilityManager.grant(
        "peer-1",
        [{ type: "task-delegation" }],
        { expiresIn: 2000 }
      );

      // Advance past original expiration
      vi.setSystemTime(now + 1500);

      // Should still be valid due to refreshed expiration
      expect(
        capabilityManager.hasCapability("peer-1", { type: "task-delegation" })
      ).toBe(true);

      vi.useRealTimers();
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  HierarchyError,
  HIERARCHY_ERROR_CODES,
  GENERAL_ERROR_CODES,
  FEDERATION_ERROR_CODES,
  ENCAPSULATION_ERROR_CODES,
  // Factory methods
  capabilityDenied,
  peerUnavailable,
  taskRejected,
  taskTimeout,
  invalidRequest,
  internalError,
  federationRejected,
  remoteAgentNotFound,
  federationNotFound,
  mountDenied,
  alreadyFederated,
  registrationRejected,
  proxyNotFound,
  alreadyRegistered,
  notRegistered,
  // Utility functions
  isHierarchyError,
  getErrorName,
  isGeneralError,
  isFederationError,
  isEncapsulationError,
  toHierarchyError,
} from "../hierarchy-errors.js";

describe("HierarchyErrors", () => {
  describe("Error Codes", () => {
    it("should have correct general error codes", () => {
      expect(GENERAL_ERROR_CODES.CAPABILITY_DENIED).toBe(4001);
      expect(GENERAL_ERROR_CODES.PEER_UNAVAILABLE).toBe(4002);
      expect(GENERAL_ERROR_CODES.TASK_REJECTED).toBe(4003);
      expect(GENERAL_ERROR_CODES.TASK_TIMEOUT).toBe(4004);
      expect(GENERAL_ERROR_CODES.INVALID_REQUEST).toBe(4005);
      expect(GENERAL_ERROR_CODES.INTERNAL_ERROR).toBe(4006);
    });

    it("should have correct federation error codes", () => {
      expect(FEDERATION_ERROR_CODES.FEDERATION_REJECTED).toBe(4101);
      expect(FEDERATION_ERROR_CODES.REMOTE_AGENT_NOT_FOUND).toBe(4102);
      expect(FEDERATION_ERROR_CODES.FEDERATION_NOT_FOUND).toBe(4103);
      expect(FEDERATION_ERROR_CODES.MOUNT_DENIED).toBe(4104);
      expect(FEDERATION_ERROR_CODES.ALREADY_FEDERATED).toBe(4105);
    });

    it("should have correct encapsulation error codes", () => {
      expect(ENCAPSULATION_ERROR_CODES.REGISTRATION_REJECTED).toBe(4201);
      expect(ENCAPSULATION_ERROR_CODES.PROXY_NOT_FOUND).toBe(4202);
      expect(ENCAPSULATION_ERROR_CODES.ALREADY_REGISTERED).toBe(4203);
      expect(ENCAPSULATION_ERROR_CODES.NOT_REGISTERED).toBe(4204);
    });

    it("should include all codes in HIERARCHY_ERROR_CODES", () => {
      expect(HIERARCHY_ERROR_CODES).toMatchObject(GENERAL_ERROR_CODES);
      expect(HIERARCHY_ERROR_CODES).toMatchObject(FEDERATION_ERROR_CODES);
      expect(HIERARCHY_ERROR_CODES).toMatchObject(ENCAPSULATION_ERROR_CODES);
    });
  });

  describe("HierarchyError class", () => {
    it("should create error with code and message", () => {
      const error = new HierarchyError(4001, "Test error");

      expect(error.errorCode).toBe(4001);
      expect(error.message).toBe("Test error");
      expect(error.name).toBe("HierarchyError");
    });

    it("should include optional data", () => {
      const error = new HierarchyError(4001, "Test error", { foo: "bar" });

      expect(error.data).toEqual({ foo: "bar" });
    });

    it("should provide error name", () => {
      const error = new HierarchyError(4001, "Test");
      expect(error.errorName).toBe("CAPABILITY_DENIED");
    });

    it("should convert to response error", () => {
      const error = new HierarchyError(4002, "Cannot reach peer", { peerId: "p1" });
      const response = error.toResponseError();

      expect(response).toEqual({
        code: 4002,
        message: "PEER_UNAVAILABLE",
        data: { peerId: "p1" },
      });
    });
  });

  describe("Factory Methods - General Errors", () => {
    it("capabilityDenied should create correct error", () => {
      const error = capabilityDenied("task-delegation", "peer-1");

      expect(error.errorCode).toBe(4001);
      expect(error.message).toContain("task-delegation");
      expect(error.data).toEqual({ capability: "task-delegation", peerId: "peer-1" });
    });

    it("peerUnavailable should create correct error", () => {
      const error = peerUnavailable("peer-1", "connection timeout");

      expect(error.errorCode).toBe(4002);
      expect(error.message).toContain("peer-1");
      expect(error.message).toContain("connection timeout");
    });

    it("taskRejected should create correct error", () => {
      const error = taskRejected("task-123", "queue full");

      expect(error.errorCode).toBe(4003);
      expect(error.data).toEqual({ taskId: "task-123", reason: "queue full" });
    });

    it("taskTimeout should create correct error", () => {
      const error = taskTimeout("task-123", 5000);

      expect(error.errorCode).toBe(4004);
      expect(error.message).toContain("5000ms");
    });

    it("invalidRequest should create correct error", () => {
      const error = invalidRequest("missing required field", { field: "taskId" });

      expect(error.errorCode).toBe(4005);
      expect(error.data).toEqual({ field: "taskId" });
    });

    it("internalError should create correct error", () => {
      const error = internalError("something went wrong");

      expect(error.errorCode).toBe(4006);
      expect(error.message).toContain("something went wrong");
    });
  });

  describe("Factory Methods - Federation Errors", () => {
    it("federationRejected should create correct error", () => {
      const error = federationRejected("peer-1", "not accepting federations");

      expect(error.errorCode).toBe(4101);
      expect(error.data).toEqual({ peerId: "peer-1", reason: "not accepting federations" });
    });

    it("remoteAgentNotFound should create correct error", () => {
      const error = remoteAgentNotFound("agent-123", "peer-1");

      expect(error.errorCode).toBe(4102);
      expect(error.data).toEqual({ agentId: "agent-123", peerId: "peer-1" });
    });

    it("federationNotFound should create correct error", () => {
      const error = federationNotFound("fed-123");

      expect(error.errorCode).toBe(4103);
      expect(error.data).toEqual({ federationId: "fed-123" });
    });

    it("mountDenied should create correct error", () => {
      const error = mountDenied("agent-123", "agent is private");

      expect(error.errorCode).toBe(4104);
      expect(error.message).toContain("agent-123");
    });

    it("alreadyFederated should create correct error", () => {
      const error = alreadyFederated("peer-1");

      expect(error.errorCode).toBe(4105);
      expect(error.data).toEqual({ peerId: "peer-1" });
    });
  });

  describe("Factory Methods - Encapsulation Errors", () => {
    it("registrationRejected should create correct error", () => {
      const error = registrationRejected("parent-peer", "capacity reached");

      expect(error.errorCode).toBe(4201);
      expect(error.data).toEqual({ parentPeerId: "parent-peer", reason: "capacity reached" });
    });

    it("proxyNotFound should create correct error", () => {
      const error = proxyNotFound("proxy-123");

      expect(error.errorCode).toBe(4202);
      expect(error.data).toEqual({ proxyAgentId: "proxy-123" });
    });

    it("alreadyRegistered should create correct error", () => {
      const error = alreadyRegistered("parent-peer");

      expect(error.errorCode).toBe(4203);
      expect(error.data).toEqual({ parentPeerId: "parent-peer" });
    });

    it("notRegistered should create correct error", () => {
      const error = notRegistered("parent-peer");

      expect(error.errorCode).toBe(4204);
      expect(error.data).toEqual({ parentPeerId: "parent-peer" });
    });
  });

  describe("Utility Functions", () => {
    describe("isHierarchyError", () => {
      it("should return true for HierarchyError", () => {
        const error = capabilityDenied("test");
        expect(isHierarchyError(error)).toBe(true);
      });

      it("should return false for regular Error", () => {
        const error = new Error("test");
        expect(isHierarchyError(error)).toBe(false);
      });

      it("should return false for non-error", () => {
        expect(isHierarchyError("string")).toBe(false);
        expect(isHierarchyError(null)).toBe(false);
        expect(isHierarchyError(undefined)).toBe(false);
      });
    });

    describe("getErrorName", () => {
      it("should return error name for valid code", () => {
        expect(getErrorName(4001)).toBe("CAPABILITY_DENIED");
        expect(getErrorName(4101)).toBe("FEDERATION_REJECTED");
        expect(getErrorName(4201)).toBe("REGISTRATION_REJECTED");
      });

      it("should return null for unknown code", () => {
        expect(getErrorName(9999)).toBeNull();
        expect(getErrorName(0)).toBeNull();
      });
    });

    describe("isGeneralError", () => {
      it("should return true for general error codes", () => {
        expect(isGeneralError(4001)).toBe(true);
        expect(isGeneralError(4006)).toBe(true);
        expect(isGeneralError(4050)).toBe(true);
      });

      it("should return false for other error codes", () => {
        expect(isGeneralError(4100)).toBe(false);
        expect(isGeneralError(4200)).toBe(false);
        expect(isGeneralError(3999)).toBe(false);
      });
    });

    describe("isFederationError", () => {
      it("should return true for federation error codes", () => {
        expect(isFederationError(4101)).toBe(true);
        expect(isFederationError(4105)).toBe(true);
        expect(isFederationError(4150)).toBe(true);
      });

      it("should return false for other error codes", () => {
        expect(isFederationError(4001)).toBe(false);
        expect(isFederationError(4200)).toBe(false);
      });
    });

    describe("isEncapsulationError", () => {
      it("should return true for encapsulation error codes", () => {
        expect(isEncapsulationError(4201)).toBe(true);
        expect(isEncapsulationError(4204)).toBe(true);
        expect(isEncapsulationError(4250)).toBe(true);
      });

      it("should return false for other error codes", () => {
        expect(isEncapsulationError(4001)).toBe(false);
        expect(isEncapsulationError(4101)).toBe(false);
      });
    });

    describe("toHierarchyError", () => {
      it("should return HierarchyError as-is", () => {
        const original = capabilityDenied("test");
        const result = toHierarchyError(original);

        expect(result).toBe(original);
      });

      it("should wrap regular Error in INTERNAL_ERROR", () => {
        const original = new Error("Something broke");
        const result = toHierarchyError(original);

        expect(result.errorCode).toBe(4006);
        expect(result.message).toContain("Something broke");
      });

      it("should wrap string in INTERNAL_ERROR", () => {
        const result = toHierarchyError("string error");

        expect(result.errorCode).toBe(4006);
        expect(result.message).toContain("string error");
      });
    });
  });
});

/**
 * Tests for context injection module
 *
 * @see s-9rld In-Flight Steering spec section 3.1
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  injectContext,
  formatInjectedContent,
  createInjector,
} from "../inject.js";
import type {
  InjectionDeps,
  InjectionOptions,
  InjectableSession,
} from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockSession(options: {
  supportsInject?: boolean;
  injectResult?: { success: boolean; error?: string };
  injectThrows?: Error;
  checkInjectResult?: boolean;
} = {}): InjectableSession {
  const {
    supportsInject = false,
    injectResult = { success: true },
    injectThrows,
    checkInjectResult,
  } = options;

  return {
    supportsInject: vi.fn().mockReturnValue(supportsInject),
    checkInjectSupport: vi.fn().mockResolvedValue(checkInjectResult ?? supportsInject),
    inject: injectThrows
      ? vi.fn().mockRejectedValue(injectThrows)
      : vi.fn().mockResolvedValue(injectResult),
    interruptWith: vi.fn().mockImplementation(async function* () {
      yield { type: "update" };
    }),
  };
}

function createMockDeps(options: {
  session?: InjectableSession | null;
  isPrompting?: boolean;
  sendMessageThrows?: Error;
} = {}): InjectionDeps {
  const {
    session = null,
    isPrompting = false,
    sendMessageThrows,
  } = options;

  return {
    getSession: vi.fn().mockReturnValue(session),
    isPrompting: vi.fn().mockReturnValue(isPrompting),
    sendMessage: sendMessageThrows
      ? vi.fn().mockRejectedValue(sendMessageThrows)
      : vi.fn().mockResolvedValue(undefined),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// formatInjectedContent
// ─────────────────────────────────────────────────────────────────────────────

describe("formatInjectedContent", () => {
  it("should format content with default header", () => {
    const result = formatInjectedContent("Test content", {});

    expect(result).toContain("[Context Injection]");
    expect(result).toContain("Test content");
  });

  it("should format content with human source", () => {
    const result = formatInjectedContent("Test content", {
      source: { type: "human" },
    });

    expect(result).toContain("[Context Injection from User]");
    expect(result).toContain("Test content");
  });

  it("should format content with agent source", () => {
    const result = formatInjectedContent("Test content", {
      source: { type: "agent", agentId: "coordinator-1" },
    });

    expect(result).toContain("[Context Injection from Agent: coordinator-1]");
    expect(result).toContain("Test content");
  });

  it("should include reason when provided", () => {
    const result = formatInjectedContent("Test content", {
      reason: "Priority change",
    });

    expect(result).toContain("Reason: Priority change");
    expect(result).toContain("Test content");
  });

  it("should format with all options", () => {
    const result = formatInjectedContent("Important update", {
      source: { type: "agent", agentId: "monitor-1" },
      reason: "Health check failed",
    });

    expect(result).toContain("[Context Injection from Agent: monitor-1]");
    expect(result).toContain("Reason: Health check failed");
    expect(result).toContain("Important update");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// injectContext - No Session Cases
// ─────────────────────────────────────────────────────────────────────────────

describe("injectContext", () => {
  describe("when agent has no session", () => {
    it("should fall back to message", async () => {
      const deps = createMockDeps({ session: null });

      const result = await injectContext(deps, "agent-1", "Test content");

      expect(result.success).toBe(true);
      expect(result.method).toBe("message");
      expect(result.note).toContain("high-priority message");
      expect(deps.sendMessage).toHaveBeenCalledWith(
        undefined,
        "agent-1",
        expect.stringContaining("Test content"),
        "high"
      );
    });

    it("should include agent source in fallback message", async () => {
      const deps = createMockDeps({ session: null });

      const result = await injectContext(deps, "agent-1", "Test content", {
        source: { type: "agent", agentId: "coordinator-1" },
      });

      expect(result.success).toBe(true);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        "coordinator-1",
        "agent-1",
        expect.any(String),
        "high"
      );
    });

    it("should return error if message sending fails", async () => {
      const deps = createMockDeps({
        session: null,
        sendMessageThrows: new Error("Network error"),
      });

      const result = await injectContext(deps, "agent-1", "Test content");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Network error");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // injectContext - Inject Supported
  // ─────────────────────────────────────────────────────────────────────────────

  describe("when inject is supported", () => {
    it("should use inject when supported", async () => {
      const session = createMockSession({ supportsInject: true });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "Test content");

      expect(result.success).toBe(true);
      expect(result.method).toBe("inject");
      expect(result.note).toContain("Queued for next turn");
      expect(session.inject).toHaveBeenCalledWith(expect.stringContaining("Test content"));
    });

    it("should check inject support if supportsInject returns false", async () => {
      const session = createMockSession({
        supportsInject: false,
        checkInjectResult: true,
      });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "Test content");

      expect(result.success).toBe(true);
      expect(result.method).toBe("inject");
      expect(session.checkInjectSupport).toHaveBeenCalled();
    });

    it("should fall back when inject returns failure", async () => {
      const session = createMockSession({
        supportsInject: true,
        injectResult: { success: false, error: "Queue full" },
      });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "Test content", {
        allowInterrupt: false,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("message");
    });

    it("should fall back when inject throws", async () => {
      const session = createMockSession({
        supportsInject: true,
        injectThrows: new Error("Inject error"),
      });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "Test content", {
        allowInterrupt: false,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("message");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // injectContext - Interrupt Fallback
  // ─────────────────────────────────────────────────────────────────────────────

  describe("interrupt fallback", () => {
    it("should fall back to interrupt when inject not supported and allowInterrupt is true", async () => {
      const session = createMockSession({ supportsInject: false });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "Test content", {
        allowInterrupt: true,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
      expect(result.note).toContain("Cancelled current work");
      expect(session.interruptWith).toHaveBeenCalled();
    });

    it("should not use interrupt when allowInterrupt is false", async () => {
      const session = createMockSession({ supportsInject: false });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "Test content", {
        allowInterrupt: false,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("message");
      expect(session.interruptWith).not.toHaveBeenCalled();
    });

    it("should not use interrupt when agent is not prompting", async () => {
      const session = createMockSession({ supportsInject: false });
      const deps = createMockDeps({ session, isPrompting: false });

      const result = await injectContext(deps, "agent-1", "Test content", {
        allowInterrupt: true,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("message");
      expect(session.interruptWith).not.toHaveBeenCalled();
    });

    it("should default allowInterrupt to true", async () => {
      const session = createMockSession({ supportsInject: false });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "Test content");

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // injectContext - Urgent Mode
  // ─────────────────────────────────────────────────────────────────────────────

  describe("urgent mode", () => {
    it("should prefer interrupt when urgent and agent is prompting", async () => {
      const session = createMockSession({ supportsInject: true });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "URGENT!", {
        urgent: true,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
      expect(session.interruptWith).toHaveBeenCalled();
    });

    it("should fall back to inject if interrupt fails in urgent mode", async () => {
      const session = createMockSession({ supportsInject: true });
      // Make interruptWith throw
      session.interruptWith = vi.fn().mockImplementation(async function* () {
        throw new Error("Interrupt failed");
      });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "URGENT!", {
        urgent: true,
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("inject");
    });

    it("should not use interrupt when urgent but agent not prompting", async () => {
      const session = createMockSession({ supportsInject: true });
      const deps = createMockDeps({ session, isPrompting: false });

      const result = await injectContext(deps, "agent-1", "URGENT!", {
        urgent: true,
      });

      // Agent not prompting, so inject should work
      expect(result.success).toBe(true);
      expect(result.method).toBe("inject");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // injectContext - Message Fallback
  // ─────────────────────────────────────────────────────────────────────────────

  describe("message fallback", () => {
    it("should fall back to message when all else fails", async () => {
      const session = createMockSession({ supportsInject: false });
      session.interruptWith = vi.fn().mockImplementation(async function* () {
        throw new Error("Interrupt failed");
      });
      const deps = createMockDeps({ session, isPrompting: true });

      const result = await injectContext(deps, "agent-1", "Test content");

      expect(result.success).toBe(true);
      expect(result.method).toBe("message");
      expect(deps.sendMessage).toHaveBeenCalledWith(
        undefined,
        "agent-1",
        expect.stringContaining("Test content"),
        "high"
      );
    });

    it("should return error if all fallbacks fail", async () => {
      const session = createMockSession({ supportsInject: false });
      session.interruptWith = vi.fn().mockImplementation(async function* () {
        throw new Error("Interrupt failed");
      });
      const deps = createMockDeps({
        session,
        isPrompting: true,
        sendMessageThrows: new Error("Message failed"),
      });

      const result = await injectContext(deps, "agent-1", "Test content");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Message failed");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createInjector
// ─────────────────────────────────────────────────────────────────────────────

describe("createInjector", () => {
  it("should create bound injector function", async () => {
    const session = createMockSession({ supportsInject: true });
    const deps = createMockDeps({ session, isPrompting: false });

    const inject = createInjector(deps);
    const result = await inject("agent-1", "Test content");

    expect(result.success).toBe(true);
    expect(deps.getSession).toHaveBeenCalledWith("agent-1");
  });

  it("should pass options through to injectContext", async () => {
    const session = createMockSession({ supportsInject: false });
    const deps = createMockDeps({ session, isPrompting: true });

    const inject = createInjector(deps);
    const result = await inject("agent-1", "URGENT!", { urgent: true });

    expect(result.success).toBe(true);
    expect(result.method).toBe("interrupt");
  });
});

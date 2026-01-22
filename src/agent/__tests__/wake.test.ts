/**
 * Tests for agent wake mechanism
 *
 * @see s-9rld In-Flight Steering spec section 3.4
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  formatActivityContext,
  wakeAgent,
  createWakeHandler,
  createSessionProviderFromAgentManager,
  type WakeSessionProvider,
  type WakeSessionInfo,
} from "../wake.js";
import type { Activity } from "../../activity/types.js";
import type { AgentManager } from "../agent-manager.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "evt-123",
    type: "task_completed",
    timestamp: 1700000000000,
    ...overrides,
  };
}

function createSessionProvider(
  sessionInfo: WakeSessionInfo | null,
  options: {
    inject?: (agentId: string, message: string) => Promise<boolean>;
    interrupt?: (agentId: string, message: string) => Promise<boolean>;
  } = {}
): WakeSessionProvider {
  return {
    getSessionInfo: vi.fn().mockReturnValue(sessionInfo),
    inject: options.inject,
    interrupt: options.interrupt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// formatActivityContext
// ─────────────────────────────────────────────────────────────────────────────

describe("formatActivityContext", () => {
  it("should format basic activity with type and timestamp", () => {
    const activity = createActivity({
      type: "task_completed",
      timestamp: 1700000000000,
    });

    const result = formatActivityContext(activity);

    expect(result).toContain("[Activity Notification]");
    expect(result).toContain("Type: task_completed");
    expect(result).toContain("Time: 2023-11-14T22:13:20.000Z");
  });

  it("should include source agent_id when present", () => {
    const activity = createActivity({
      source: { agent_id: "agent-worker-1" },
    });

    const result = formatActivityContext(activity);

    expect(result).toContain("Source Agent: agent-worker-1");
  });

  it("should include source task_id when present", () => {
    const activity = createActivity({
      source: { task_id: "task-abc" },
    });

    const result = formatActivityContext(activity);

    expect(result).toContain("Source Task: task-abc");
  });

  it("should include source role when present", () => {
    const activity = createActivity({
      source: { role: "worker" },
    });

    const result = formatActivityContext(activity);

    expect(result).toContain("Source Role: worker");
  });

  it("should include all source fields when all present", () => {
    const activity = createActivity({
      source: {
        agent_id: "agent-1",
        task_id: "task-1",
        role: "monitor",
      },
    });

    const result = formatActivityContext(activity);

    expect(result).toContain("Source Agent: agent-1");
    expect(result).toContain("Source Task: task-1");
    expect(result).toContain("Source Role: monitor");
  });

  it("should include details when present and non-empty", () => {
    const activity = createActivity({
      details: { status: "completed", count: 5 },
    });

    const result = formatActivityContext(activity);

    expect(result).toContain("Details:");
    expect(result).toContain('"status": "completed"');
    expect(result).toContain('"count": 5');
  });

  it("should not include details section when details is empty", () => {
    const activity = createActivity({
      details: {},
    });

    const result = formatActivityContext(activity);

    expect(result).not.toContain("Details:");
  });

  it("should not include details section when details is undefined", () => {
    const activity = createActivity();
    delete (activity as Partial<Activity>).details;

    const result = formatActivityContext(activity);

    expect(result).not.toContain("Details:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wakeAgent - No Session Cases
// ─────────────────────────────────────────────────────────────────────────────

describe("wakeAgent", () => {
  describe("when agent has no session", () => {
    it("should queue for low priority", async () => {
      const provider = createSessionProvider(null);
      const activity = createActivity({ priority: "low" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });

    it("should return failure for normal priority without agentManager", async () => {
      const provider = createSessionProvider(null);
      const activity = createActivity({ priority: "normal" });

      const result = await wakeAgent("agent-1", activity, provider);

      // Normal priority wants to wake, but can't without agentManager
      expect(result.success).toBe(false);
      expect(result.reason).toBe("no_session");
    });

    it("should return failure for urgent priority without agentManager", async () => {
      const provider = createSessionProvider(null);
      const activity = createActivity({ priority: "urgent" });

      const result = await wakeAgent("agent-1", activity, provider);

      // Urgent priority wants to wake, but can't without agentManager
      expect(result.success).toBe(false);
      expect(result.reason).toBe("no_session");
    });

    it("should return failure when hasSession is false for normal priority", async () => {
      const provider = createSessionProvider({ hasSession: false, isPrompting: false, supportsInjection: false });
      const activity = createActivity({ priority: "normal" });

      const result = await wakeAgent("agent-1", activity, provider);

      // Normal priority wants to wake, but can't without agentManager
      expect(result.success).toBe(false);
      expect(result.reason).toBe("no_session");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // wakeAgent - Has Session, Not Prompting
  // ─────────────────────────────────────────────────────────────────────────────

  describe("when agent has session but is not prompting", () => {
    const idleSession: WakeSessionInfo = {
      hasSession: true,
      isPrompting: false,
      supportsInjection: false,
    };

    it("should queue for low priority", async () => {
      const provider = createSessionProvider(idleSession);
      const activity = createActivity({ priority: "low" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });

    it("should queue without agentManager for normal priority", async () => {
      const provider = createSessionProvider(idleSession);
      const activity = createActivity({ priority: "normal" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });

    it("should wake with agentManager for normal priority", async () => {
      const provider = createSessionProvider(idleSession);
      const activity = createActivity({ priority: "normal" });

      // Mock agentManager.prompt to return an async iterable
      const mockPrompt = vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: "message" };
        },
      });
      const agentManager = { prompt: mockPrompt } as unknown as AgentManager;

      const result = await wakeAgent("agent-1", activity, provider, agentManager);

      expect(result.success).toBe(true);
      expect(result.method).toBe("wake");
      expect(mockPrompt).toHaveBeenCalledWith("agent-1", expect.stringContaining("[Activity Notification]"));
    });

    it("should wake with agentManager for high priority", async () => {
      const provider = createSessionProvider(idleSession);
      const activity = createActivity({ priority: "high" });

      const mockPrompt = vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: "message" };
        },
      });
      const agentManager = { prompt: mockPrompt } as unknown as AgentManager;

      const result = await wakeAgent("agent-1", activity, provider, agentManager);

      expect(result.success).toBe(true);
      expect(result.method).toBe("wake");
    });

    it("should wake with agentManager for urgent priority", async () => {
      const provider = createSessionProvider(idleSession);
      const activity = createActivity({ priority: "urgent" });

      const mockPrompt = vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { type: "message" };
        },
      });
      const agentManager = { prompt: mockPrompt } as unknown as AgentManager;

      const result = await wakeAgent("agent-1", activity, provider, agentManager);

      expect(result.success).toBe(true);
      expect(result.method).toBe("wake");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // wakeAgent - Has Session, Is Prompting (Busy)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("when agent is actively prompting (busy)", () => {
    const busySession: WakeSessionInfo = {
      hasSession: true,
      isPrompting: true,
      supportsInjection: true,
    };

    it("should queue for low priority", async () => {
      const provider = createSessionProvider(busySession);
      const activity = createActivity({ priority: "low" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });

    it("should queue for normal priority", async () => {
      const provider = createSessionProvider(busySession);
      const activity = createActivity({ priority: "normal" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });

    it("should inject for high priority when injection supported", async () => {
      const injectMock = vi.fn().mockResolvedValue(true);
      const provider = createSessionProvider(busySession, { inject: injectMock });
      const activity = createActivity({ priority: "high" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("inject");
      expect(injectMock).toHaveBeenCalledWith("agent-1", expect.stringContaining("[Activity Notification]"));
    });

    it("should fall back to interrupt when inject fails for high priority", async () => {
      const injectMock = vi.fn().mockResolvedValue(false);
      const interruptMock = vi.fn().mockResolvedValue(true);
      const provider = createSessionProvider(busySession, {
        inject: injectMock,
        interrupt: interruptMock,
      });
      const activity = createActivity({ priority: "high" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
      expect(injectMock).toHaveBeenCalled();
      expect(interruptMock).toHaveBeenCalled();
    });

    it("should fall back to interrupt when inject throws for high priority", async () => {
      const injectMock = vi.fn().mockRejectedValue(new Error("Inject failed"));
      const interruptMock = vi.fn().mockResolvedValue(true);
      const provider = createSessionProvider(busySession, {
        inject: injectMock,
        interrupt: interruptMock,
      });
      const activity = createActivity({ priority: "high" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
    });

    it("should queue when both inject and interrupt fail for high priority", async () => {
      const injectMock = vi.fn().mockResolvedValue(false);
      const interruptMock = vi.fn().mockResolvedValue(false);
      const provider = createSessionProvider(busySession, {
        inject: injectMock,
        interrupt: interruptMock,
      });
      const activity = createActivity({ priority: "high" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });

    it("should return error when interrupt throws for high priority", async () => {
      const injectMock = vi.fn().mockResolvedValue(false);
      const interruptMock = vi.fn().mockRejectedValue(new Error("Interrupt error"));
      const provider = createSessionProvider(busySession, {
        inject: injectMock,
        interrupt: interruptMock,
      });
      const activity = createActivity({ priority: "high" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(false);
      expect(result.reason).toBe("inject_failed");
      expect(result.error).toBe("Interrupt error");
    });

    it("should interrupt for urgent priority", async () => {
      const interruptMock = vi.fn().mockResolvedValue(true);
      const provider = createSessionProvider(busySession, { interrupt: interruptMock });
      const activity = createActivity({ priority: "urgent" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
      expect(interruptMock).toHaveBeenCalledWith("agent-1", expect.stringContaining("[Activity Notification]"));
    });

    it("should queue when interrupt not available for urgent priority", async () => {
      const provider = createSessionProvider(busySession);
      const activity = createActivity({ priority: "urgent" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });

    it("should queue when interrupt returns false for urgent priority", async () => {
      const interruptMock = vi.fn().mockResolvedValue(false);
      const provider = createSessionProvider(busySession, { interrupt: interruptMock });
      const activity = createActivity({ priority: "urgent" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });

    it("should return error when interrupt throws for urgent priority", async () => {
      const interruptMock = vi.fn().mockRejectedValue(new Error("Interrupt failed"));
      const provider = createSessionProvider(busySession, { interrupt: interruptMock });
      const activity = createActivity({ priority: "urgent" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(false);
      expect(result.reason).toBe("error");
      expect(result.error).toBe("Interrupt failed");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // wakeAgent - Injection Not Supported
  // ─────────────────────────────────────────────────────────────────────────────

  describe("when injection is not supported", () => {
    const busyNoInjectSession: WakeSessionInfo = {
      hasSession: true,
      isPrompting: true,
      supportsInjection: false,
    };

    it("should fall back to interrupt for high priority when supportsInjection is false", async () => {
      const interruptMock = vi.fn().mockResolvedValue(true);
      const injectMock = vi.fn().mockResolvedValue(true);
      const provider = createSessionProvider(busyNoInjectSession, {
        inject: injectMock,
        interrupt: interruptMock,
      });
      const activity = createActivity({ priority: "high" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
      // inject should NOT be called because supportsInjection is false
      expect(injectMock).not.toHaveBeenCalled();
      expect(interruptMock).toHaveBeenCalled();
    });

    it("should queue when neither inject nor interrupt available", async () => {
      const provider = createSessionProvider(busyNoInjectSession);
      const activity = createActivity({ priority: "high" });

      const result = await wakeAgent("agent-1", activity, provider);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // wakeAgent - Force Action Option
  // ─────────────────────────────────────────────────────────────────────────────

  describe("forceAction option", () => {
    const idleSession: WakeSessionInfo = {
      hasSession: true,
      isPrompting: false,
      supportsInjection: true,
    };

    it("should use forced action instead of calculated one", async () => {
      const provider = createSessionProvider(idleSession);
      const activity = createActivity({ priority: "urgent" });

      // Force queue even for urgent priority
      const result = await wakeAgent("agent-1", activity, provider, undefined, {
        forceAction: "queue",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });

    it("should force interrupt when specified", async () => {
      const interruptMock = vi.fn().mockResolvedValue(true);
      const provider = createSessionProvider(idleSession, { interrupt: interruptMock });
      const activity = createActivity({ priority: "low" });

      const result = await wakeAgent("agent-1", activity, provider, undefined, {
        forceAction: "interrupt",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
    });

    it("should force inject when specified", async () => {
      const busySession: WakeSessionInfo = {
        hasSession: true,
        isPrompting: true,
        supportsInjection: true,
      };
      const injectMock = vi.fn().mockResolvedValue(true);
      const provider = createSessionProvider(busySession, { inject: injectMock });
      const activity = createActivity({ priority: "low" });

      const result = await wakeAgent("agent-1", activity, provider, undefined, {
        forceAction: "inject",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("inject");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // wakeAgent - Priority Override
  // ─────────────────────────────────────────────────────────────────────────────

  describe("priority option", () => {
    const busySession: WakeSessionInfo = {
      hasSession: true,
      isPrompting: true,
      supportsInjection: true,
    };

    it("should use options.priority over activity.priority", async () => {
      const interruptMock = vi.fn().mockResolvedValue(true);
      const provider = createSessionProvider(busySession, { interrupt: interruptMock });
      const activity = createActivity({ priority: "low" }); // Low priority in activity

      // Override with urgent priority
      const result = await wakeAgent("agent-1", activity, provider, undefined, {
        priority: "urgent",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
    });

    it("should default to normal when no priority specified", async () => {
      const provider = createSessionProvider(busySession);
      const activity = createActivity(); // No priority
      delete (activity as Partial<Activity>).priority;

      const result = await wakeAgent("agent-1", activity, provider);

      // Normal priority + busy = queue
      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createWakeHandler
// ─────────────────────────────────────────────────────────────────────────────

describe("createWakeHandler", () => {
  it("should create a wake handler function", () => {
    const provider = createSessionProvider(null);
    const handler = createWakeHandler(provider);

    expect(typeof handler).toBe("function");
  });

  it("should call wakeAgent with correct parameters", async () => {
    const provider = createSessionProvider(null);
    const handler = createWakeHandler(provider);
    const activity = createActivity({ priority: "normal" });

    const result = await handler("agent-1", activity, "urgent");

    // Priority from handler call should override activity priority
    // Urgent priority wants to wake, but can't without agentManager - returns failure
    expect(result.success).toBe(false);
    expect(result.reason).toBe("no_session");
  });

  it("should pass agentManager to wakeAgent", async () => {
    const idleSession: WakeSessionInfo = {
      hasSession: true,
      isPrompting: false,
      supportsInjection: false,
    };
    const provider = createSessionProvider(idleSession);

    const mockPrompt = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "message" };
      },
    });
    const agentManager = { prompt: mockPrompt } as unknown as AgentManager;

    const handler = createWakeHandler(provider, agentManager);
    const activity = createActivity();

    const result = await handler("agent-1", activity, "normal");

    expect(result.success).toBe(true);
    expect(result.method).toBe("wake");
    expect(mockPrompt).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createSessionProviderFromAgentManager
// ─────────────────────────────────────────────────────────────────────────────

describe("createSessionProviderFromAgentManager", () => {
  it("should create a session provider", () => {
    const agentManager = {
      hasActiveSession: vi.fn(),
    } as unknown as AgentManager;

    const provider = createSessionProviderFromAgentManager(agentManager);

    expect(provider).toBeDefined();
    expect(typeof provider.getSessionInfo).toBe("function");
  });

  it("should return null when agent has no session", () => {
    const agentManager = {
      hasActiveSession: vi.fn().mockReturnValue(false),
    } as unknown as AgentManager;

    const provider = createSessionProviderFromAgentManager(agentManager);
    const info = provider.getSessionInfo("agent-1");

    expect(info).toBeNull();
    expect(agentManager.hasActiveSession).toHaveBeenCalledWith("agent-1");
  });

  it("should return session info when agent has session", () => {
    const agentManager = {
      hasActiveSession: vi.fn().mockReturnValue(true),
    } as unknown as AgentManager;

    const provider = createSessionProviderFromAgentManager(agentManager);
    const info = provider.getSessionInfo("agent-1");

    expect(info).toEqual({
      hasSession: true,
      isPrompting: false, // Default, not tracked
      supportsInjection: false, // Claude Code doesn't support injection yet
    });
  });

  it("should not have inject method (not implemented)", () => {
    const agentManager = {
      hasActiveSession: vi.fn(),
    } as unknown as AgentManager;

    const provider = createSessionProviderFromAgentManager(agentManager);

    expect(provider.inject).toBeUndefined();
  });

  it("should not have interrupt method (not implemented)", () => {
    const agentManager = {
      hasActiveSession: vi.fn(),
    } as unknown as AgentManager;

    const provider = createSessionProviderFromAgentManager(agentManager);

    expect(provider.interrupt).toBeUndefined();
  });
});

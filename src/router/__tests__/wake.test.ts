/**
 * Tests for priority-based wake decisions
 *
 * @see s-9rld In-Flight Steering spec
 */

import { describe, it, expect, vi } from "vitest";
import {
  determineWakeAction,
  getWakeDecision,
  shouldWakeAgent,
  shouldInterruptAgent,
  comparePriority,
  PRIORITY_VALUES,
  type SessionChecker,
} from "../wake.js";

// ─────────────────────────────────────────────────────────────────────────────
// determineWakeAction
// ─────────────────────────────────────────────────────────────────────────────

describe("determineWakeAction", () => {
  describe("when agent has no active session", () => {
    it("should wake for urgent priority", () => {
      expect(determineWakeAction("urgent", false, false)).toBe("wake");
    });

    it("should wake for high priority", () => {
      expect(determineWakeAction("high", false, false)).toBe("wake");
    });

    it("should wake for normal priority", () => {
      expect(determineWakeAction("normal", false, false)).toBe("wake");
    });

    it("should queue for low priority (never wake idle agent)", () => {
      expect(determineWakeAction("low", false, false)).toBe("queue");
    });
  });

  describe("when agent has session but is not prompting", () => {
    it("should wake for urgent priority", () => {
      expect(determineWakeAction("urgent", true, false)).toBe("wake");
    });

    it("should wake for high priority", () => {
      expect(determineWakeAction("high", true, false)).toBe("wake");
    });

    it("should wake for normal priority", () => {
      expect(determineWakeAction("normal", true, false)).toBe("wake");
    });

    it("should queue for low priority", () => {
      expect(determineWakeAction("low", true, false)).toBe("queue");
    });
  });

  describe("when agent is actively prompting (busy)", () => {
    it("should interrupt for urgent priority", () => {
      expect(determineWakeAction("urgent", true, true)).toBe("interrupt");
    });

    it("should inject for high priority", () => {
      expect(determineWakeAction("high", true, true)).toBe("inject");
    });

    it("should queue for normal priority", () => {
      expect(determineWakeAction("normal", true, true)).toBe("queue");
    });

    it("should queue for low priority", () => {
      expect(determineWakeAction("low", true, true)).toBe("queue");
    });
  });

  describe("when agent is stopped/terminated", () => {
    it("should skip for urgent priority", () => {
      expect(determineWakeAction("urgent", false, false, true)).toBe("skip");
    });

    it("should skip for high priority", () => {
      expect(determineWakeAction("high", false, false, true)).toBe("skip");
    });

    it("should skip for normal priority", () => {
      expect(determineWakeAction("normal", false, false, true)).toBe("skip");
    });

    it("should skip for low priority", () => {
      expect(determineWakeAction("low", false, false, true)).toBe("skip");
    });

    it("should skip even if agent has active session (edge case)", () => {
      // Stopped takes precedence over session state
      expect(determineWakeAction("urgent", true, true, true)).toBe("skip");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getWakeDecision
// ─────────────────────────────────────────────────────────────────────────────

describe("getWakeDecision", () => {
  it("should return full decision for idle agent with urgent message", () => {
    const checker: SessionChecker = {
      hasActiveSession: vi.fn().mockReturnValue(false),
      isPrompting: vi.fn().mockReturnValue(false),
      supportsInjection: vi.fn().mockReturnValue(true),
    };

    const decision = getWakeDecision("agent-1", "urgent", checker);

    expect(decision.action).toBe("wake");
    expect(decision.shouldWake).toBe(true);
    expect(decision.shouldInterrupt).toBe(false);
    expect(decision.canInject).toBe(true);
  });

  it("should return interrupt decision for busy agent with urgent message", () => {
    const checker: SessionChecker = {
      hasActiveSession: vi.fn().mockReturnValue(true),
      isPrompting: vi.fn().mockReturnValue(true),
      supportsInjection: vi.fn().mockReturnValue(true),
    };

    const decision = getWakeDecision("agent-1", "urgent", checker);

    expect(decision.action).toBe("interrupt");
    expect(decision.shouldWake).toBe(false);
    expect(decision.shouldInterrupt).toBe(true);
    expect(decision.canInject).toBe(true);
  });

  it("should return inject decision for busy agent with high message", () => {
    const checker: SessionChecker = {
      hasActiveSession: vi.fn().mockReturnValue(true),
      isPrompting: vi.fn().mockReturnValue(true),
      supportsInjection: vi.fn().mockReturnValue(true),
    };

    const decision = getWakeDecision("agent-1", "high", checker);

    expect(decision.action).toBe("inject");
    expect(decision.shouldWake).toBe(false);
    expect(decision.shouldInterrupt).toBe(false);
    expect(decision.canInject).toBe(true);
  });

  it("should fall back to interrupt if injection not supported", () => {
    const checker: SessionChecker = {
      hasActiveSession: vi.fn().mockReturnValue(true),
      isPrompting: vi.fn().mockReturnValue(true),
      supportsInjection: vi.fn().mockReturnValue(false),
    };

    const decision = getWakeDecision("agent-1", "high", checker);

    expect(decision.action).toBe("interrupt");
    expect(decision.canInject).toBe(false);
  });

  it("should return queue decision for low priority", () => {
    const checker: SessionChecker = {
      hasActiveSession: vi.fn().mockReturnValue(false),
      isPrompting: vi.fn().mockReturnValue(false),
      supportsInjection: vi.fn().mockReturnValue(true),
    };

    const decision = getWakeDecision("agent-1", "low", checker);

    expect(decision.action).toBe("queue");
    expect(decision.shouldWake).toBe(false);
    expect(decision.shouldInterrupt).toBe(false);
  });

  it("should handle missing isPrompting and supportsInjection", () => {
    const checker: SessionChecker = {
      hasActiveSession: vi.fn().mockReturnValue(true),
    };

    const decision = getWakeDecision("agent-1", "high", checker);

    // Without isPrompting, defaults to not prompting
    expect(decision.action).toBe("wake");
    // Without supportsInjection, defaults to true
    expect(decision.canInject).toBe(true);
  });

  it("should return skip decision for stopped agent", () => {
    const checker: SessionChecker = {
      hasActiveSession: vi.fn().mockReturnValue(false),
      isPrompting: vi.fn().mockReturnValue(false),
      supportsInjection: vi.fn().mockReturnValue(true),
      isStopped: vi.fn().mockReturnValue(true),
    };

    const decision = getWakeDecision("agent-1", "urgent", checker);

    expect(decision.action).toBe("skip");
    expect(decision.shouldWake).toBe(false);
    expect(decision.shouldInterrupt).toBe(false);
  });

  it("should handle missing isStopped (defaults to false)", () => {
    const checker: SessionChecker = {
      hasActiveSession: vi.fn().mockReturnValue(false),
    };

    const decision = getWakeDecision("agent-1", "urgent", checker);

    // Without isStopped, defaults to not stopped
    expect(decision.action).toBe("wake");
    expect(decision.shouldWake).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldWakeAgent", () => {
  it("should return true for urgent priority", () => {
    expect(shouldWakeAgent("urgent")).toBe(true);
  });

  it("should return true for high priority", () => {
    expect(shouldWakeAgent("high")).toBe(true);
  });

  it("should return true for normal priority", () => {
    expect(shouldWakeAgent("normal")).toBe(true);
  });

  it("should return false for low priority", () => {
    expect(shouldWakeAgent("low")).toBe(false);
  });
});

describe("shouldInterruptAgent", () => {
  it("should return true only for urgent priority", () => {
    expect(shouldInterruptAgent("urgent")).toBe(true);
    expect(shouldInterruptAgent("high")).toBe(false);
    expect(shouldInterruptAgent("normal")).toBe(false);
    expect(shouldInterruptAgent("low")).toBe(false);
  });
});

describe("comparePriority", () => {
  it("should return positive when a > b", () => {
    expect(comparePriority("urgent", "low")).toBeGreaterThan(0);
    expect(comparePriority("high", "normal")).toBeGreaterThan(0);
    expect(comparePriority("normal", "low")).toBeGreaterThan(0);
  });

  it("should return negative when a < b", () => {
    expect(comparePriority("low", "urgent")).toBeLessThan(0);
    expect(comparePriority("normal", "high")).toBeLessThan(0);
  });

  it("should return 0 when equal", () => {
    expect(comparePriority("normal", "normal")).toBe(0);
    expect(comparePriority("urgent", "urgent")).toBe(0);
  });
});

describe("PRIORITY_VALUES", () => {
  it("should have correct ordering", () => {
    expect(PRIORITY_VALUES.low).toBeLessThan(PRIORITY_VALUES.normal);
    expect(PRIORITY_VALUES.normal).toBeLessThan(PRIORITY_VALUES.high);
    expect(PRIORITY_VALUES.high).toBeLessThan(PRIORITY_VALUES.urgent);
  });
});

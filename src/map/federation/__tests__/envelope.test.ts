/**
 * Tests for federation envelope handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  wrapMessage,
  unwrapMessage,
  getMetadata,
  isEnvelope,
  validateEnvelope,
  createResponseEnvelope,
  isResponseTo,
  getEnvelopeAge,
  type FederationEnvelope,
} from "../envelope.js";

describe("wrapMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps a message with federation metadata", () => {
    const message = { type: "test", data: "hello" };
    const envelope = wrapMessage(message, "system-a", "system-b");

    expect(envelope.message).toEqual(message);
    expect(envelope.federation.sourceSystem).toBe("system-a");
    expect(envelope.federation.targetSystem).toBe("system-b");
    expect(envelope.federation.timestamp).toBe(Date.now());
  });

  it("includes correlationId when provided", () => {
    const message = { type: "test" };
    const envelope = wrapMessage(message, "system-a", "system-b", {
      correlationId: "corr-123",
    });

    expect(envelope.federation.correlationId).toBe("corr-123");
  });

  it("uses provided timestamp when specified", () => {
    const message = { type: "test" };
    const customTimestamp = 1000000;
    const envelope = wrapMessage(message, "system-a", "system-b", {
      timestamp: customTimestamp,
    });

    expect(envelope.federation.timestamp).toBe(customTimestamp);
  });

  it("works with any message type", () => {
    // String message
    const strEnvelope = wrapMessage("hello", "a", "b");
    expect(strEnvelope.message).toBe("hello");

    // Number message
    const numEnvelope = wrapMessage(42, "a", "b");
    expect(numEnvelope.message).toBe(42);

    // Array message
    const arrEnvelope = wrapMessage([1, 2, 3], "a", "b");
    expect(arrEnvelope.message).toEqual([1, 2, 3]);

    // Null message
    const nullEnvelope = wrapMessage(null, "a", "b");
    expect(nullEnvelope.message).toBe(null);
  });
});

describe("unwrapMessage", () => {
  it("returns the original message", () => {
    const message = { type: "test", data: [1, 2, 3] };
    const envelope = wrapMessage(message, "a", "b");
    const unwrapped = unwrapMessage(envelope);

    expect(unwrapped).toEqual(message);
  });

  it("preserves message reference", () => {
    const message = { type: "test" };
    const envelope = wrapMessage(message, "a", "b");
    const unwrapped = unwrapMessage(envelope);

    expect(unwrapped).toBe(message);
  });
});

describe("getMetadata", () => {
  it("returns federation metadata", () => {
    const envelope = wrapMessage({ type: "test" }, "source", "target", {
      correlationId: "corr-1",
      timestamp: 12345,
    });

    const metadata = getMetadata(envelope);

    expect(metadata.sourceSystem).toBe("source");
    expect(metadata.targetSystem).toBe("target");
    expect(metadata.timestamp).toBe(12345);
    expect(metadata.correlationId).toBe("corr-1");
  });
});

describe("isEnvelope", () => {
  it("returns true for valid envelope", () => {
    const envelope = wrapMessage({ type: "test" }, "a", "b");
    expect(isEnvelope(envelope)).toBe(true);
  });

  it("returns true for envelope with correlationId", () => {
    const envelope = wrapMessage({ type: "test" }, "a", "b", {
      correlationId: "123",
    });
    expect(isEnvelope(envelope)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isEnvelope(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isEnvelope(undefined)).toBe(false);
  });

  it("returns false for primitive values", () => {
    expect(isEnvelope("string")).toBe(false);
    expect(isEnvelope(123)).toBe(false);
    expect(isEnvelope(true)).toBe(false);
  });

  it("returns false for object without message", () => {
    expect(
      isEnvelope({
        federation: { sourceSystem: "a", targetSystem: "b", timestamp: 1 },
      })
    ).toBe(false);
  });

  it("returns false for object without federation", () => {
    expect(isEnvelope({ message: "test" })).toBe(false);
  });

  it("returns false for invalid federation structure", () => {
    expect(isEnvelope({ message: "test", federation: "invalid" })).toBe(false);
  });

  it("returns false when sourceSystem is missing", () => {
    expect(
      isEnvelope({
        message: "test",
        federation: { targetSystem: "b", timestamp: 1 },
      })
    ).toBe(false);
  });

  it("returns false when targetSystem is missing", () => {
    expect(
      isEnvelope({
        message: "test",
        federation: { sourceSystem: "a", timestamp: 1 },
      })
    ).toBe(false);
  });

  it("returns false when timestamp is missing", () => {
    expect(
      isEnvelope({
        message: "test",
        federation: { sourceSystem: "a", targetSystem: "b" },
      })
    ).toBe(false);
  });

  it("returns false when correlationId is not a string", () => {
    expect(
      isEnvelope({
        message: "test",
        federation: {
          sourceSystem: "a",
          targetSystem: "b",
          timestamp: 1,
          correlationId: 123,
        },
      })
    ).toBe(false);
  });
});

describe("validateEnvelope", () => {
  it("returns empty array for valid envelope", () => {
    const envelope = wrapMessage({ type: "test" }, "a", "b");
    expect(validateEnvelope(envelope)).toEqual([]);
  });

  it("returns error for empty sourceSystem", () => {
    const envelope: FederationEnvelope = {
      message: "test",
      federation: { sourceSystem: "", targetSystem: "b", timestamp: 1 },
    };
    const errors = validateEnvelope(envelope);
    expect(errors).toContain("sourceSystem is required");
  });

  it("returns error for empty targetSystem", () => {
    const envelope: FederationEnvelope = {
      message: "test",
      federation: { sourceSystem: "a", targetSystem: "", timestamp: 1 },
    };
    const errors = validateEnvelope(envelope);
    expect(errors).toContain("targetSystem is required");
  });

  it("returns error for non-positive timestamp", () => {
    const envelope: FederationEnvelope = {
      message: "test",
      federation: { sourceSystem: "a", targetSystem: "b", timestamp: 0 },
    };
    const errors = validateEnvelope(envelope);
    expect(errors).toContain("timestamp must be positive");
  });

  it("returns error when source equals target", () => {
    const envelope: FederationEnvelope = {
      message: "test",
      federation: { sourceSystem: "a", targetSystem: "a", timestamp: 1 },
    };
    const errors = validateEnvelope(envelope);
    expect(errors).toContain("sourceSystem and targetSystem cannot be the same");
  });

  it("returns multiple errors when multiple issues exist", () => {
    const envelope: FederationEnvelope = {
      message: "test",
      federation: { sourceSystem: "", targetSystem: "", timestamp: 0 },
    };
    const errors = validateEnvelope(envelope);
    expect(errors.length).toBeGreaterThan(1);
  });
});

describe("createResponseEnvelope", () => {
  it("swaps source and target systems", () => {
    const request = wrapMessage({ type: "request" }, "client", "server");
    const response = createResponseEnvelope(request, { type: "response" });

    expect(response.federation.sourceSystem).toBe("server");
    expect(response.federation.targetSystem).toBe("client");
  });

  it("preserves correlationId from request", () => {
    const request = wrapMessage({ type: "request" }, "client", "server", {
      correlationId: "corr-abc",
    });
    const response = createResponseEnvelope(request, { type: "response" });

    expect(response.federation.correlationId).toBe("corr-abc");
  });

  it("wraps the response message", () => {
    const request = wrapMessage({ type: "request" }, "a", "b");
    const responseMsg = { type: "response", result: 42 };
    const response = createResponseEnvelope(request, responseMsg);

    expect(response.message).toEqual(responseMsg);
  });
});

describe("isResponseTo", () => {
  it("returns true for matching response", () => {
    const request = wrapMessage({ type: "request" }, "client", "server", {
      correlationId: "123",
    });
    const response = createResponseEnvelope(request, { type: "response" });

    expect(isResponseTo(request, response)).toBe(true);
  });

  it("returns true when request has no correlationId", () => {
    const request = wrapMessage({ type: "request" }, "client", "server");
    const response: FederationEnvelope = {
      message: { type: "response" },
      federation: {
        sourceSystem: "server",
        targetSystem: "client",
        timestamp: Date.now(),
      },
    };

    expect(isResponseTo(request, response)).toBe(true);
  });

  it("returns false when systems don't match", () => {
    const request = wrapMessage({ type: "request" }, "client", "server");
    const response: FederationEnvelope = {
      message: { type: "response" },
      federation: {
        sourceSystem: "other",
        targetSystem: "client",
        timestamp: Date.now(),
      },
    };

    expect(isResponseTo(request, response)).toBe(false);
  });

  it("returns false when correlationId doesn't match", () => {
    const request = wrapMessage({ type: "request" }, "client", "server", {
      correlationId: "123",
    });
    const response: FederationEnvelope = {
      message: { type: "response" },
      federation: {
        sourceSystem: "server",
        targetSystem: "client",
        timestamp: Date.now(),
        correlationId: "456",
      },
    };

    expect(isResponseTo(request, response)).toBe(false);
  });
});

describe("getEnvelopeAge", () => {
  it("calculates age correctly", () => {
    const envelope: FederationEnvelope = {
      message: "test",
      federation: {
        sourceSystem: "a",
        targetSystem: "b",
        timestamp: 1000,
      },
    };

    expect(getEnvelopeAge(envelope, 1500)).toBe(500);
    expect(getEnvelopeAge(envelope, 2000)).toBe(1000);
  });

  it("uses current time by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);

    const envelope: FederationEnvelope = {
      message: "test",
      federation: {
        sourceSystem: "a",
        targetSystem: "b",
        timestamp: 3000,
      },
    };

    expect(getEnvelopeAge(envelope)).toBe(2000);

    vi.useRealTimers();
  });
});

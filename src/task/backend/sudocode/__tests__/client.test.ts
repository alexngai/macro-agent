/**
 * SudocodeClient Interface Tests
 *
 * Tests for the SudocodeClient interface types and factory function.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkServerHealth,
  createSudocodeClient,
  DEFAULT_CLIENT_CONFIG,
  type SudocodeClientConfig,
  type SudocodeClient,
  type IssueChangeEvent,
} from "../client.js";

// Mock fetch for server health checks
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    // Simulate async connection
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }

  close() {
    // Simulate close
  }

  static clearInstances() {
    MockWebSocket.instances = [];
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

describe("SudocodeClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.clearInstances();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("DEFAULT_CLIENT_CONFIG", () => {
    it("should have expected default values", () => {
      expect(DEFAULT_CLIENT_CONFIG.serverUrl).toBe("http://localhost:3001");
      expect(DEFAULT_CLIENT_CONFIG.wsUrl).toBe("ws://localhost:3001/ws");
      expect(DEFAULT_CLIENT_CONFIG.autoDetect.timeout).toBe(2000);
      expect(DEFAULT_CLIENT_CONFIG.autoDetect.preferManaged).toBe(true);
    });
  });

  describe("checkServerHealth", () => {
    it("should return true when server responds with ok", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await checkServerHealth("http://localhost:3001");

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/health",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it("should return false when server responds with error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });

      const result = await checkServerHealth("http://localhost:3001");

      expect(result).toBe(false);
    });

    it("should return false when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await checkServerHealth("http://localhost:3001");

      expect(result).toBe(false);
    });

    it("should return false when request times out", async () => {
      // Simulate timeout by never resolving
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Aborted")), 100);
          })
      );

      const result = await checkServerHealth("http://localhost:3001", 50);

      expect(result).toBe(false);
    });
  });

  describe("createSudocodeClient", () => {
    describe("managed mode", () => {
      it("should create a ServerClient in managed mode", async () => {
        const config: SudocodeClientConfig = {
          mode: "managed",
          serverUrl: "http://localhost:3001",
        };

        const client = await createSudocodeClient(config);

        try {
          // Verify client implements the interface
          expect(typeof client.getIssue).toBe("function");
          expect(typeof client.listIssues).toBe("function");
          expect(typeof client.getReadyIssues).toBe("function");
          expect(typeof client.updateIssue).toBe("function");
          expect(typeof client.createLink).toBe("function");
          expect(typeof client.removeLink).toBe("function");
          expect(typeof client.getBlockers).toBe("function");
          expect(typeof client.getBlocking).toBe("function");
          expect(typeof client.getSpec).toBe("function");
          expect(typeof client.listSpecs).toBe("function");
          expect(typeof client.addFeedback).toBe("function");
          expect(typeof client.onIssueChange).toBe("function");
          expect(typeof client.isReady).toBe("function");
          expect(typeof client.close).toBe("function");

          // Verify WebSocket was created with correct URL
          expect(MockWebSocket.instances).toHaveLength(1);
          expect(MockWebSocket.instances[0].url).toBe("ws://localhost:3001/ws");
        } finally {
          client.close();
        }
      });

      it("should use custom wsUrl if provided", async () => {
        const config: SudocodeClientConfig = {
          mode: "managed",
          serverUrl: "http://localhost:3001",
          wsUrl: "ws://custom.example.com/websocket",
        };

        const client = await createSudocodeClient(config);

        try {
          expect(MockWebSocket.instances).toHaveLength(1);
          expect(MockWebSocket.instances[0].url).toBe(
            "ws://custom.example.com/websocket"
          );
        } finally {
          client.close();
        }
      });
    });

    describe("standalone mode", () => {
      it("should throw when StandaloneClient is not implemented", async () => {
        const config: SudocodeClientConfig = {
          mode: "standalone",
          projectPath: "/tmp/test-project",
        };

        await expect(createSudocodeClient(config)).rejects.toThrow(
          "StandaloneClient not yet implemented"
        );
      });
    });

    describe("auto mode", () => {
      it("should use managed mode when server is available and preferManaged is true", async () => {
        mockFetch.mockResolvedValueOnce({ ok: true });

        const config: SudocodeClientConfig = {
          mode: "auto",
          autoDetect: { preferManaged: true },
        };

        const client = await createSudocodeClient(config);

        try {
          expect(mockFetch).toHaveBeenCalled();
          // Should have created a ServerClient (WebSocket was created)
          expect(MockWebSocket.instances).toHaveLength(1);
        } finally {
          client.close();
        }
      });

      it("should fall back to standalone when server is unavailable", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

        const config: SudocodeClientConfig = {
          mode: "auto",
          projectPath: "/tmp/test-project",
        };

        // Will throw because StandaloneClient is not implemented
        await expect(createSudocodeClient(config)).rejects.toThrow(
          "StandaloneClient not yet implemented"
        );

        expect(mockFetch).toHaveBeenCalled();
      });

      it("should use standalone when preferManaged is false", async () => {
        mockFetch.mockResolvedValueOnce({ ok: true });

        const config: SudocodeClientConfig = {
          mode: "auto",
          autoDetect: { preferManaged: false },
          projectPath: "/tmp/test-project",
        };

        // Will throw because StandaloneClient is not implemented
        await expect(createSudocodeClient(config)).rejects.toThrow(
          "StandaloneClient not yet implemented"
        );
      });
    });
  });

  describe("Type definitions", () => {
    it("should have correct IssueChangeEvent types", () => {
      // Type-level test: ensure the type is correctly defined
      const event: IssueChangeEvent = {
        type: "created",
        issueId: "i-abc123",
        issue: {
          id: "i-abc123",
          uuid: "uuid-123",
          title: "Test Issue",
          content: "Test content",
          status: "open",
          priority: 1,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      };

      expect(event.type).toBe("created");
      expect(event.issueId).toBe("i-abc123");
    });

    it("should support all IssueChangeType values", () => {
      const types: IssueChangeEvent["type"][] = [
        "created",
        "updated",
        "deleted",
        "status_changed",
        "blocked",
        "unblocked",
      ];

      expect(types).toHaveLength(6);
    });
  });
});

describe("SudocodeClient interface contract", () => {
  // These are type-level tests to ensure the interface is correctly defined
  // They don't actually run code but verify the type structure

  it("should define all required methods", () => {
    // This is a compile-time check - if the interface is wrong, TypeScript will error
    const methodNames: (keyof SudocodeClient)[] = [
      // Issue operations
      "getIssue",
      "listIssues",
      "getReadyIssues",
      "updateIssue",
      // Relationship operations
      "createLink",
      "removeLink",
      "getBlockers",
      "getBlocking",
      // Spec operations
      "getSpec",
      "listSpecs",
      // Feedback operations
      "addFeedback",
      // Event subscription
      "onIssueChange",
      // Lifecycle
      "isReady",
      "close",
    ];

    expect(methodNames).toHaveLength(14);
  });
});

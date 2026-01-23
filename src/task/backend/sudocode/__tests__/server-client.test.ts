/**
 * ServerClient Tests
 *
 * Tests for the ServerClient implementation (managed mode).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ServerClient } from "../server-client.js";
import type { IssueChangeEvent } from "../client.js";

// Mock fetch
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
    // Don't trigger onclose to prevent reconnection attempts
  }

  // Helper to simulate receiving a message
  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  // Helper to simulate connection
  simulateOpen() {
    if (this.onopen) this.onopen();
  }

  // Helper to simulate disconnection
  simulateClose() {
    if (this.onclose) this.onclose();
  }

  static clearInstances() {
    MockWebSocket.instances = [];
  }

  static getLatest(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

describe("ServerClient", () => {
  let client: ServerClient;

  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.clearInstances();
    vi.useFakeTimers();
  });

  afterEach(() => {
    client?.close();
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("should initialize with config", () => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
        wsUrl: "ws://localhost:3001/ws",
      });

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].url).toBe("ws://localhost:3001/ws");
    });

    it("should derive wsUrl from serverUrl if not provided", () => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
      });

      expect(MockWebSocket.instances[0].url).toBe("ws://localhost:3001/ws");
    });

    it("should handle https to wss conversion", () => {
      client = new ServerClient({
        serverUrl: "https://example.com",
      });

      expect(MockWebSocket.instances[0].url).toBe("wss://example.com/ws");
    });
  });

  describe("isReady", () => {
    it("should return false before WebSocket connects", () => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
      });

      expect(client.isReady()).toBe(false);
    });

    it("should return true after WebSocket connects", async () => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
      });

      // Advance timers to trigger onopen
      await vi.advanceTimersByTimeAsync(10);

      expect(client.isReady()).toBe(true);
    });
  });

  describe("HTTP operations", () => {
    beforeEach(() => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
        projectId: "test-project",
      });
    });

    describe("getIssue", () => {
      it("should fetch an issue by ID", async () => {
        const mockIssue = {
          id: "i-abc123",
          uuid: "uuid-123",
          title: "Test Issue",
          content: "Test content",
          status: "open",
          priority: 1,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        };

        mockFetch.mockResolvedValueOnce({
          json: async () => ({ success: true, data: mockIssue }),
        });

        const issue = await client.getIssue("i-abc123");

        expect(issue).toEqual(mockIssue);
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3001/api/issues/i-abc123",
          expect.objectContaining({
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "X-Project-ID": "test-project",
            },
          })
        );
      });

      it("should return null when issue not found", async () => {
        mockFetch.mockResolvedValueOnce({
          json: async () => ({
            success: false,
            message: "Issue not found",
          }),
        });

        const issue = await client.getIssue("i-nonexistent");

        expect(issue).toBeNull();
      });

      it("should throw on other errors", async () => {
        mockFetch.mockResolvedValueOnce({
          json: async () => ({
            success: false,
            message: "Server error",
          }),
        });

        await expect(client.getIssue("i-abc123")).rejects.toThrow(
          "Server error"
        );
      });
    });

    describe("listIssues", () => {
      it("should list issues with no filter", async () => {
        const mockIssues = [
          { id: "i-1", title: "Issue 1" },
          { id: "i-2", title: "Issue 2" },
        ];

        mockFetch.mockResolvedValueOnce({
          json: async () => ({ success: true, data: mockIssues }),
        });

        const issues = await client.listIssues();

        expect(issues).toEqual(mockIssues);
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3001/api/issues",
          expect.anything()
        );
      });

      it("should apply filter parameters", async () => {
        mockFetch.mockResolvedValueOnce({
          json: async () => ({ success: true, data: [] }),
        });

        await client.listIssues({
          status: "open",
          priority: 1,
          search: "test",
          archived: false,
          limit: 10,
        });

        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3001/api/issues?status=open&priority=1&search=test&archived=false&limit=10",
          expect.anything()
        );
      });
    });

    describe("updateIssue", () => {
      it("should update an issue", async () => {
        const updatedIssue = {
          id: "i-abc123",
          title: "Updated Title",
          status: "in_progress",
        };

        mockFetch.mockResolvedValueOnce({
          json: async () => ({ success: true, data: updatedIssue }),
        });

        const result = await client.updateIssue("i-abc123", {
          title: "Updated Title",
          status: "in_progress",
        });

        expect(result).toEqual(updatedIssue);
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3001/api/issues/i-abc123",
          expect.objectContaining({
            method: "PUT",
            body: JSON.stringify({
              title: "Updated Title",
              status: "in_progress",
            }),
          })
        );
      });
    });

    describe("getSpec", () => {
      it("should fetch a spec by ID", async () => {
        const mockSpec = {
          id: "s-abc123",
          uuid: "uuid-123",
          title: "Test Spec",
          content: "Test content",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        };

        mockFetch.mockResolvedValueOnce({
          json: async () => ({ success: true, data: mockSpec }),
        });

        const spec = await client.getSpec("s-abc123");

        expect(spec).toEqual(mockSpec);
      });

      it("should return null when spec not found", async () => {
        mockFetch.mockResolvedValueOnce({
          json: async () => ({
            success: false,
            message: "Spec not found",
          }),
        });

        const spec = await client.getSpec("s-nonexistent");

        expect(spec).toBeNull();
      });
    });

    describe("listSpecs", () => {
      it("should list specs with filter", async () => {
        mockFetch.mockResolvedValueOnce({
          json: async () => ({ success: true, data: [] }),
        });

        await client.listSpecs({ search: "test", limit: 5 });

        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3001/api/specs?search=test&limit=5",
          expect.anything()
        );
      });
    });
  });

  describe("Relationship operations", () => {
    beforeEach(() => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
      });
    });

    describe("createLink", () => {
      it("should create a relationship between issues", async () => {
        mockFetch.mockResolvedValueOnce({
          json: async () => ({ success: true, data: null }),
        });

        await client.createLink("i-source", "i-target", "blocks");

        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3001/api/relationships",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              from_id: "i-source",
              from_type: "issue",
              to_id: "i-target",
              to_type: "issue",
              relationship_type: "blocks",
            }),
          })
        );
      });

      it("should handle spec-to-issue relationships", async () => {
        mockFetch.mockResolvedValueOnce({
          json: async () => ({ success: true, data: null }),
        });

        await client.createLink("i-issue", "s-spec", "implements");

        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3001/api/relationships",
          expect.objectContaining({
            body: JSON.stringify({
              from_id: "i-issue",
              from_type: "issue",
              to_id: "s-spec",
              to_type: "spec",
              relationship_type: "implements",
            }),
          })
        );
      });
    });

    describe("removeLink", () => {
      it("should remove a relationship", async () => {
        mockFetch.mockResolvedValueOnce({
          json: async () => ({ success: true, data: null }),
        });

        await client.removeLink("i-source", "i-target", "blocks");

        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3001/api/relationships",
          expect.objectContaining({
            method: "DELETE",
            body: JSON.stringify({
              from_id: "i-source",
              from_type: "issue",
              to_id: "i-target",
              to_type: "issue",
              relationship_type: "blocks",
            }),
          })
        );
      });
    });

    describe("getBlockers", () => {
      it("should fetch blocking issues", async () => {
        // First call: get relationships
        mockFetch.mockResolvedValueOnce({
          json: async () => ({
            success: true,
            data: [
              { from_id: "i-blocker1", from_type: "issue" },
              { from_id: "i-blocker2", from_type: "issue" },
            ],
          }),
        });

        // Subsequent calls: get issue details
        mockFetch.mockResolvedValueOnce({
          json: async () => ({
            success: true,
            data: { id: "i-blocker1", title: "Blocker 1" },
          }),
        });
        mockFetch.mockResolvedValueOnce({
          json: async () => ({
            success: true,
            data: { id: "i-blocker2", title: "Blocker 2" },
          }),
        });

        const blockers = await client.getBlockers("i-target");

        expect(blockers).toHaveLength(2);
        expect(blockers[0].id).toBe("i-blocker1");
        expect(blockers[1].id).toBe("i-blocker2");
      });
    });

    describe("getBlocking", () => {
      it("should fetch issues that this issue blocks", async () => {
        // First call: get relationships
        mockFetch.mockResolvedValueOnce({
          json: async () => ({
            success: true,
            data: [{ to_id: "i-blocked1", to_type: "issue" }],
          }),
        });

        // Get issue details
        mockFetch.mockResolvedValueOnce({
          json: async () => ({
            success: true,
            data: { id: "i-blocked1", title: "Blocked 1" },
          }),
        });

        const blocking = await client.getBlocking("i-source");

        expect(blocking).toHaveLength(1);
        expect(blocking[0].id).toBe("i-blocked1");
      });
    });
  });

  describe("Feedback operations", () => {
    beforeEach(() => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
      });
    });

    it("should add feedback to a spec", async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ success: true, data: null }),
      });

      await client.addFeedback("i-source", "s-target", {
        type: "suggestion",
        content: "This needs improvement",
        agent: "test-agent",
        anchor: { line: 10, text: "Some text" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/feedback",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            from_id: "i-source",
            to_id: "s-target",
            feedback_type: "suggestion",
            content: "This needs improvement",
            agent: "test-agent",
            line: 10,
            text: "Some text",
          }),
        })
      );
    });

    it("should add anonymous feedback when fromIssueId is undefined", async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ success: true, data: null }),
      });

      await client.addFeedback(undefined, "s-target", {
        type: "comment",
        content: "Just a comment",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/feedback",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            to_id: "s-target",
            feedback_type: "comment",
            content: "Just a comment",
          }),
        })
      );
    });
  });

  describe("Event subscriptions", () => {
    beforeEach(() => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
      });
    });

    it("should subscribe to all issue changes", async () => {
      const callback = vi.fn();
      const unsubscribe = client.onIssueChange(callback);

      // Simulate WebSocket message
      const ws = MockWebSocket.getLatest()!;
      ws.simulateMessage({
        type: "issue",
        entityId: "i-abc123",
        action: "updated",
        data: { id: "i-abc123", title: "Updated" },
      });

      expect(callback).toHaveBeenCalledWith({
        type: "updated",
        issueId: "i-abc123",
        issue: { id: "i-abc123", title: "Updated" },
      });

      unsubscribe();
    });

    it("should subscribe to specific issue changes", async () => {
      const callback = vi.fn();
      const unsubscribe = client.onIssueChange("i-abc123", callback);

      const ws = MockWebSocket.getLatest()!;

      // Message for subscribed issue
      ws.simulateMessage({
        type: "issue",
        entityId: "i-abc123",
        action: "updated",
      });

      // Message for different issue
      ws.simulateMessage({
        type: "issue",
        entityId: "i-other",
        action: "updated",
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: "i-abc123" })
      );

      unsubscribe();
    });

    it("should handle unsubscribe correctly", () => {
      const callback = vi.fn();
      const unsubscribe = client.onIssueChange(callback);

      unsubscribe();

      const ws = MockWebSocket.getLatest()!;
      ws.simulateMessage({
        type: "issue",
        entityId: "i-abc123",
        action: "updated",
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it("should map WebSocket actions to event types", () => {
      const callback = vi.fn();
      client.onIssueChange(callback);

      const ws = MockWebSocket.getLatest()!;

      const actions = ["created", "updated", "deleted", "status_changed"];
      for (const action of actions) {
        ws.simulateMessage({
          type: "issue",
          entityId: "i-abc123",
          action,
        });
      }

      expect(callback).toHaveBeenCalledTimes(4);
      const calls = callback.mock.calls.map(
        (c: [IssueChangeEvent]) => c[0].type
      );
      expect(calls).toEqual(["created", "updated", "deleted", "status_changed"]);
    });
  });

  describe("WebSocket reconnection", () => {
    beforeEach(() => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
      });
    });

    it("should schedule reconnect on disconnect", async () => {
      const ws = MockWebSocket.getLatest()!;

      // Simulate connection then disconnect
      await vi.advanceTimersByTimeAsync(10);
      expect(client.isReady()).toBe(true);

      ws.simulateClose();
      expect(client.isReady()).toBe(false);

      // Advance past reconnect delay
      await vi.advanceTimersByTimeAsync(1000);

      // Should have created a new WebSocket
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it("should use exponential backoff for reconnection", async () => {
      // Simulate multiple disconnections
      for (let i = 0; i < 3; i++) {
        const ws = MockWebSocket.getLatest()!;
        ws.simulateClose();

        // Expected delays: 1000, 2000, 4000 (exponential)
        const expectedDelay = 1000 * Math.pow(2, i);
        await vi.advanceTimersByTimeAsync(expectedDelay);
      }

      // Should have original + 3 reconnection attempts
      expect(MockWebSocket.instances).toHaveLength(4);
    });
  });

  describe("close", () => {
    it("should clean up resources", async () => {
      client = new ServerClient({
        serverUrl: "http://localhost:3001",
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(client.isReady()).toBe(true);

      const callback = vi.fn();
      client.onIssueChange(callback);

      client.close();

      expect(client.isReady()).toBe(false);

      // Simulate message after close
      const ws = MockWebSocket.getLatest()!;
      ws.simulateMessage({
        type: "issue",
        entityId: "i-abc123",
        action: "updated",
      });

      // Callback should not be called after close
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
